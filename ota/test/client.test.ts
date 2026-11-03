import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createOtaClient, memoryStorage } from "../src/index.js";

const ID = "A".repeat(22);
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

interface Call {
    url: string;
    init?: RequestInit;
}

function setup(files: Record<string, string>, opts: { status?: number; headers?: Record<string, string>; fail?: boolean } = {}) {
    const calls: Call[] = [];
    const fetchMock = (async (url: string, init?: RequestInit) => {
        calls.push({ url, init });
        if (opts.fail) throw new TypeError("network down");
        if (opts.status && opts.status !== 200) return new Response("{}", { status: opts.status, headers: opts.headers });
        const path = url.replace("https://cdn.test", "");
        if (path === `/d/${ID}/manifest.json`) {
            const languages: Record<string, unknown> = {};
            for (const [lang, body] of Object.entries(files)) {
                languages[lang] = { url: `/d/${ID}/v1/${lang}.json`, hash: sha(body), bytes: body.length };
            }
            return new Response(JSON.stringify({ version: 1, publishedAt: "2026-01-01T00:00:00Z", languages }));
        }
        const m = path.match(/\/v1\/(\w+)\.json$/);
        if (m && files[m[1]]) return new Response(files[m[1]]);
        return new Response("", { status: 404 });
    }) as typeof fetch;
    return { calls, fetchMock };
}

// room for the background refresh incl. crypto.subtle.digest (threadpool)
const tick = () => new Promise((r) => setTimeout(r, 25));

function make(fetchMock: typeof fetch, extra: Record<string, unknown> = {}) {
    let t = 1_000_000;
    const clock = { advance: (ms: number) => (t += ms) };
    const client = createOtaClient({
        distributionId: ID,
        cdnUrl: "https://cdn.test",
        fetch: fetchMock,
        now: () => t,
        ...extra,
    });
    return { client, clock };
}

test("empty cache and no bundle: waits for one fetch and returns it", async () => {
    const { fetchMock } = setup({ en: '{"a":"1"}' });
    const { client } = make(fetchMock);
    assert.deepEqual(await client.load("en"), { a: "1" });
});

test("requests carry no cookies and no custom headers", async () => {
    const { fetchMock, calls } = setup({ en: '{"a":"1"}' });
    const { client } = make(fetchMock);
    await client.load("en");
    for (const c of calls) {
        assert.equal(c.init?.credentials, "omit");
        assert.equal(c.init?.headers, undefined);
    }
});

test("cached copy is returned first, stale cache refreshes in the background", async () => {
    const storage = memoryStorage();
    const first = setup({ en: '{"a":"old"}' });
    const a = make(first.fetchMock, { storage });
    await a.client.load("en");

    const second = setup({ en: '{"a":"new"}' });
    const b = make(second.fetchMock, { storage });
    const updates: unknown[] = [];
    b.client.onUpdate((lang, t) => updates.push([lang, t]));
    // fresh clock far in the future relative to fetchedAt
    b.clock.advance(10 * 60_000);
    const got = await b.client.load("en");
    assert.deepEqual(got, { a: "old" });
    await tick();
    assert.deepEqual(updates, [["en", { a: "new" }]]);
    assert.deepEqual(await b.client.load("en"), { a: "new" });
});

test("fresh cache is not re-checked within minRefreshMs", async () => {
    const storage = memoryStorage();
    const s = setup({ en: '{"a":"1"}' });
    const { client } = make(s.fetchMock, { storage });
    await client.load("en");
    const n = s.calls.length;
    await client.load("en");
    await tick();
    assert.equal(s.calls.length, n);
});

test("unchanged hash skips the file download", async () => {
    const storage = memoryStorage();
    const s = setup({ en: '{"a":"1"}' });
    const { client, clock } = make(s.fetchMock, { storage });
    await client.load("en");
    s.calls.length = 0;
    clock.advance(10 * 60_000);
    await client.load("en");
    await tick();
    assert.equal(s.calls.length, 1);
    assert.match(s.calls[0].url, /manifest\.json$/);
});

test("hash mismatch is discarded", async () => {
    const calls: string[] = [];
    const fetchMock = (async (url: string) => {
        calls.push(url);
        if (url.endsWith("manifest.json")) {
            return new Response(JSON.stringify({ languages: { en: { url: `/d/${ID}/v1/en.json`, hash: "0".repeat(64), bytes: 1 } } }));
        }
        return new Response('{"a":"tampered"}');
    }) as typeof fetch;
    const { client } = make(fetchMock, { bundled: { en: { a: "bundled" } } });
    assert.deepEqual(await client.load("en"), { a: "bundled" });
    await tick();
    assert.equal(await client.refresh("en"), null);
    // with WebCrypto (Node >= 19, browsers) the tampered file is never stored
    if (globalThis.crypto?.subtle) assert.deepEqual(await client.load("en"), { a: "bundled" });
});

test("a file whose sha256 matches the manifest is accepted", async () => {
    // the backend hashes the exact UTF-8 bytes it uploads; non-ASCII must round-trip
    const body = '{"greeting":"Sveiki, pasaule – 你好"}';
    const s = setup({ en: body });
    const { client } = make(s.fetchMock);
    assert.deepEqual(await client.load("en"), { greeting: "Sveiki, pasaule – 你好" });
});

test("429 keeps bundled data and backs off by Retry-After", async () => {
    const s = setup({}, { status: 429, headers: { "retry-after": "120" } });
    const { client, clock } = make(s.fetchMock, { bundled: { en: { a: "bundled" } } });
    assert.deepEqual(await client.load("en"), { a: "bundled" });
    await tick();
    assert.equal(s.calls.length, 1);
    await client.refresh("en");
    assert.equal(s.calls.length, 1, "blocked while backing off");
    clock.advance(121_000);
    await client.refresh("en");
    assert.equal(s.calls.length, 2);
});

test("network error falls back to cached data", async () => {
    const storage = memoryStorage();
    const ok = setup({ en: '{"a":"1"}' });
    await make(ok.fetchMock, { storage }).client.load("en");
    const bad = setup({}, { fail: true });
    const { client, clock } = make(bad.fetchMock, { storage });
    clock.advance(10 * 60_000);
    assert.deepEqual(await client.load("en"), { a: "1" });
    await tick();
});

test("nothing cached or bundled and the fetch fails: resolves with {}", async () => {
    const bad = setup({}, { fail: true });
    const { client } = make(bad.fetchMock);
    assert.deepEqual(await client.load("en"), {});
});

test("bundled data is returned immediately", async () => {
    const s = setup({ en: '{"a":"remote"}' });
    const { client } = make(s.fetchMock, { bundled: { en: { a: "bundled" } } });
    assert.deepEqual(await client.load("en"), { a: "bundled" });
});

test("onUpdate unsubscribe stops notifications", async () => {
    const s = setup({ en: '{"a":"1"}' });
    const { client } = make(s.fetchMock);
    let n = 0;
    const off = client.onUpdate(() => n++);
    off();
    await client.load("en");
    assert.equal(n, 0);
});
