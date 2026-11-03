import { test } from "node:test";
import assert from "node:assert/strict";
import { OtaBackend } from "../src/i18next.js";
import type { OtaClient } from "../src/index.js";

const fake: OtaClient = {
    load: async (lang) => ({ hello: `hi-${lang}` }),
    onUpdate: () => () => {},
    refresh: async () => null,
};

test("backend reads the default namespace through the client", async () => {
    const b = new OtaBackend();
    b.init(null, { client: fake });
    const out = await new Promise((res, rej) => b.read("de", "translation", (e, d) => (e ? rej(e) : res(d))));
    assert.deepEqual(out, { hello: "hi-de" });
});

test("other namespaces resolve empty", async () => {
    const b = new OtaBackend();
    b.init(null, { client: fake });
    const out = await new Promise((res, rej) => b.read("de", "other", (e, d) => (e ? rej(e) : res(d))));
    assert.deepEqual(out, {});
});

test("updates are pushed into the resource store", () => {
    let cb: (l: string, d: Record<string, unknown>) => void = () => {};
    const client: OtaClient = { ...fake, onUpdate: (c) => ((cb = c), () => {}) };
    const added: unknown[] = [];
    const b = new OtaBackend();
    b.init({ resourceStore: { addResourceBundle: (...a) => void added.push(a) } }, { client });
    cb("en", { a: "b" });
    assert.deepEqual(added, [["en", "translation", { a: "b" }, true, true]]);
});

// createOtaClient throws synchronously when distributionId is missing; init()
// must warn and fall back instead of letting that take the whole app down.
test("a missing distributionId warns and falls back to bundled resources, instead of throwing", async () => {
    const warnings: unknown[][] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => void warnings.push(args);
    try {
        const b = new OtaBackend();
        assert.doesNotThrow(() => b.init(null, { bundled: { en: { hello: "hi" } } }));
        const out = await new Promise((res, rej) => b.read("en", "translation", (e, d) => (e ? rej(e) : res(d))));
        assert.deepEqual(out, { hello: "hi" });
        const missing = await new Promise((res, rej) => b.read("de", "translation", (e, d) => (e ? rej(e) : res(d))));
        assert.deepEqual(missing, {}, "a language with no bundled data resolves empty, not an error");
        assert.equal(warnings.length, 1);
        assert.match(String(warnings[0][0]), /distributionId is required/);
    } finally {
        console.warn = originalWarn;
    }
});

test("a missing distributionId with no bundled resources still falls back cleanly", async () => {
    const originalWarn = console.warn;
    console.warn = () => {};
    try {
        const b = new OtaBackend();
        b.init(null, {});
        const out = await new Promise((res, rej) => b.read("en", "translation", (e, d) => (e ? rej(e) : res(d))));
        assert.deepEqual(out, {});
    } finally {
        console.warn = originalWarn;
    }
});
