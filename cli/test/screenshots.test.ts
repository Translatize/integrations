import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslatizeApiError, type UploadScreenshotInput } from "@translatize/core";
import {
    MAX_REGIONS_PER_SCREEN,
    MAX_SCREENS_PER_RUN,
    assertWithinRunLimit,
    defaultRunName,
    readCaptures,
    resolveCommitSha,
    sanitizeRegions,
    sha256Hex,
    uploadCaptures,
    type LocalCapture,
    type ScreenshotClient,
} from "../src/commands/screenshots.js";
import { UsageError } from "../src/config.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "tz-cli-shots-"));
}

const PNG_A = new Uint8Array([137, 80, 78, 71, 1]);
const PNG_B = new Uint8Array([137, 80, 78, 71, 2]);

function writeCapture(dir: string, slug: string, png: Uint8Array | null, json: Record<string, unknown>): void {
    writeFileSync(join(dir, `${slug}.json`), JSON.stringify(json));
    if (png) writeFileSync(join(dir, `${slug}.png`), png);
}

function captureJson(name: string, png: Uint8Array): Record<string, unknown> {
    return {
        name,
        viewport: { width: 1280, height: 720 },
        locale: "en",
        clientHash: sha256Hex(png),
        fullPage: false,
        capturedAt: "2026-10-27T10:00:00.000Z",
        regions: [{ text: "Pay now", rect: { x: 1, y: 2, w: 3, h: 4 } }],
    };
}

test("readCaptures: pairs json + png, strips capturedAt/fullPage, sorts by name", () => {
    const dir = tmp();
    try {
        writeCapture(dir, "b-home", PNG_B, captureJson("Home", PNG_B));
        writeCapture(dir, "a-checkout", PNG_A, captureJson("Checkout", PNG_A));
        const out = readCaptures(dir);
        assert.deepEqual(out.skipped, []);
        assert.deepEqual(out.captures.map((c) => c.slug), ["a-checkout", "b-home"]);
        const meta = out.captures[0].meta as unknown as Record<string, unknown>;
        assert.equal(meta.name, "Checkout");
        assert.equal(meta.locale, "en");
        assert.equal(meta.clientHash, sha256Hex(PNG_A));
        assert.equal("capturedAt" in meta, false);
        assert.equal("fullPage" in meta, false);
        assert.deepEqual(meta.regions, [{ text: "Pay now", rect: { x: 1, y: 2, w: 3, h: 4 } }]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("readCaptures: skips a json without png, bad json and non-captures", () => {
    const dir = tmp();
    try {
        writeCapture(dir, "nopng", null, captureJson("No png", PNG_A));
        writeFileSync(join(dir, "broken.json"), "{ nope");
        writeCapture(dir, "other", PNG_A, { hello: "world" });
        writeCapture(dir, "ok", PNG_A, captureJson("Ok", PNG_A));
        const out = readCaptures(dir);
        assert.deepEqual(out.captures.map((c) => c.slug), ["ok"]);
        assert.equal(out.skipped.length, 3);
        assert.ok(out.skipped.some((line) => /nopng\.json: no matching nopng\.png/.test(line)));
        assert.ok(out.skipped.some((line) => /broken\.json: not valid JSON/.test(line)));
        assert.ok(out.skipped.some((line) => /other\.json: not a capture/.test(line)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("readCaptures: the hash comes from the png on disk, with a note when it changed", () => {
    const dir = tmp();
    try {
        writeCapture(dir, "edited", PNG_B, captureJson("Edited", PNG_A));
        const out = readCaptures(dir);
        assert.equal(out.captures[0].clientHash, sha256Hex(PNG_B));
        assert.equal(out.captures[0].meta.clientHash, sha256Hex(PNG_B));
        assert.equal(out.notes.length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("readCaptures: regions past the server's cap are not sent", () => {
    const dir = tmp();
    try {
        const json = captureJson("Busy", PNG_A);
        json.regions = Array.from({ length: MAX_REGIONS_PER_SCREEN + 2 }, (_, i) => ({ text: `t${i}`, rect: { x: 0, y: i, w: 1, h: 1 } }));
        writeCapture(dir, "busy", PNG_A, json);
        const out = readCaptures(dir);
        assert.equal(out.captures[0].meta.regions.length, MAX_REGIONS_PER_SCREEN);
        assert.equal(out.notes.length, 1);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("readCaptures: a missing directory is a usage error", () => {
    assert.throws(() => readCaptures(join(tmpdir(), "tz-does-not-exist-xyz")), UsageError);
});

test("assertWithinRunLimit: the D10 limit stops before a run is created", () => {
    assert.doesNotThrow(() => assertWithinRunLimit(MAX_SCREENS_PER_RUN, "dir"));
    assert.throws(() => assertWithinRunLimit(MAX_SCREENS_PER_RUN + 1, "dir"), /at most 500 screens/);
});

function local(slug: string, hash: string): LocalCapture {
    return { slug, pngPath: `/captures/${slug}.png`, clientHash: hash, meta: { name: slug, clientHash: hash, regions: [] } };
}

// Records every call; `existing` is what the server already has, `failOn` makes one screen fail.
function fakeClient(opts: { existing?: string[]; failOn?: Record<string, TranslatizeApiError> } = {}) {
    const calls: string[] = [];
    const uploads: { name: string; withImage: boolean }[] = [];
    const client: ScreenshotClient = {
        async createScreenshotRun(input) {
            calls.push(`create:${input.name}:${input.branch ?? "-"}:${input.commitSha ?? "-"}`);
            return { runId: "run1" };
        },
        async checkScreenshots(runId, hashes) {
            calls.push(`check:${runId}:${hashes.length}`);
            return { existing: (opts.existing ?? []).filter((h) => hashes.includes(h)) };
        },
        async uploadScreenshot(runId, input: UploadScreenshotInput) {
            const failure = opts.failOn?.[input.meta.name];
            if (failure) throw failure;
            uploads.push({ name: input.meta.name, withImage: input.image !== undefined });
            return { screenshotId: `s-${input.meta.name}`, deduped: input.image === undefined, links: 1 };
        },
        async completeScreenshotRun(runId) {
            calls.push(`complete:${runId}`);
            return { run: { id: runId, status: "completed", counts: { screens: uploads.length, linked: uploads.length, ambiguous: 0, superseded: 0 } } };
        },
    };
    return { client, calls, uploads };
}

const readImage = () => new Uint8Array([1]);

test("uploadCaptures: uploads only unknown images, sends meta for all, completes the run", async () => {
    const { client, calls, uploads } = fakeClient({ existing: ["h2"] });
    const result = await uploadCaptures(client, [local("a", "h1"), local("b", "h2"), local("c", "h1")], {
        runName: "e2e",
        branch: "feature",
        commitSha: "abc",
        readImage,
    });
    assert.deepEqual(calls, ["create:e2e:feature:abc", "check:run1:2", "complete:run1"]);
    // c has the same pixels as a, so only a's image goes up.
    assert.deepEqual(uploads, [
        { name: "a", withImage: true },
        { name: "b", withImage: false },
        { name: "c", withImage: false },
    ]);
    assert.equal(result.uploaded, 1);
    assert.equal(result.reused, 2);
    assert.equal(result.run?.counts.screens, 3);
    assert.equal(result.stopped, null);
});

test("uploadCaptures: a per-screen error is recorded and the rest still go up", async () => {
    const { client, uploads } = fakeClient({ failOn: { b: new TranslatizeApiError("too big", 413, "image_too_large") } });
    const result = await uploadCaptures(client, [local("a", "h1"), local("b", "h2"), local("c", "h3")], { runName: "r", readImage });
    assert.deepEqual(uploads.map((u) => u.name), ["a", "c"]);
    assert.equal(result.failed.length, 1);
    assert.equal(result.failed[0].name, "b");
    assert.match(result.failed[0].error, /image_too_large/);
    assert.ok(result.run);
});

test("uploadCaptures: the storage quota stops the upload but the run is still completed", async () => {
    const { client, calls, uploads } = fakeClient({ failOn: { b: new TranslatizeApiError("full", 403, "screenshot_quota_exceeded") } });
    const result = await uploadCaptures(client, [local("a", "h1"), local("b", "h2"), local("c", "h3")], { runName: "r", readImage });
    assert.deepEqual(uploads.map((u) => u.name), ["a"]);
    assert.equal(result.stopped?.code, "screenshot_quota_exceeded");
    assert.ok(calls.includes("complete:run1"));
});

test("uploadCaptures: run_not_open stops without completing", async () => {
    const { client, calls } = fakeClient({ failOn: { a: new TranslatizeApiError("closed", 409, "run_not_open") } });
    const result = await uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage });
    assert.equal(result.stopped?.code, "run_not_open");
    assert.equal(result.run, null);
    assert.equal(calls.includes("complete:run1"), false);
});

test("uploadCaptures: image_required on a reused hash retries once with the image", async () => {
    const sent: boolean[] = [];
    let first = true;
    const { client } = fakeClient({ existing: ["h1"] });
    client.uploadScreenshot = async (_runId, input) => {
        sent.push(input.image !== undefined);
        if (first) {
            first = false;
            throw new TranslatizeApiError("need it", 400, "image_required");
        }
        return { screenshotId: "s", deduped: false, links: 0 };
    };
    const result = await uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage });
    assert.deepEqual(sent, [false, true]);
    assert.equal(result.uploaded, 1);
    assert.equal(result.reused, 0);
});

test("defaultRunName / resolveCommitSha read the CI environment", () => {
    const now = new Date("2026-10-27T10:05:00.000Z");
    assert.equal(defaultRunName({}, now), "capture 2026-10-27 10:05 UTC");
    assert.equal(defaultRunName({ GITHUB_REF_NAME: "feature-x" }, now), "feature-x 2026-10-27 10:05 UTC");
    assert.equal(resolveCommitSha("flag", { GITHUB_SHA: "gh" }), "flag");
    assert.equal(resolveCommitSha(undefined, { GITHUB_SHA: "gh" }), "gh");
    assert.equal(resolveCommitSha(undefined, { CI_COMMIT_SHA: "gl" }), "gl");
    assert.equal(resolveCommitSha(undefined, {}), undefined);
});

test("sanitizeRegions: drops empty boxes and over-long text, caps the count", () => {
    const ok = { text: "Pay", rect: { x: 0, y: 0, w: 10, h: 5 } };
    const out = sanitizeRegions([
        ok,
        { text: "Zero", rect: { x: 0, y: 0, w: 0, h: 5 } },
        { text: "x".repeat(10001), rect: { x: 0, y: 0, w: 10, h: 5 } },
        { text: "No rect" },
        "junk",
    ]);
    assert.deepEqual(out.regions, [ok]);
    assert.equal(out.dropped, 4);
    const many = Array.from({ length: 5001 }, () => ok);
    assert.equal(sanitizeRegions(many).regions.length, 5000);
});

test("readCaptures: a locale that is not a language tag is left out with a note", () => {
    const dir = tmp();
    try {
        writeCapture(dir, "odd", PNG_A, { ...captureJson("Odd", PNG_A), locale: "en_US.UTF-8" });
        const out = readCaptures(dir);
        assert.equal("locale" in (out.captures[0].meta as unknown as Record<string, unknown>), false);
        assert.ok(out.notes.some((line) => /locale/.test(line)));
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("uploadCaptures: a busy server is retried after a wait", async () => {
    const waits: number[] = [];
    let busy = 2;
    const { client } = fakeClient();
    const original = client.uploadScreenshot.bind(client);
    client.uploadScreenshot = async (runId, input) => {
        if (busy > 0) {
            busy--;
            throw new TranslatizeApiError("busy", 503, "screenshot_pipeline_busy");
        }
        return original(runId, input);
    };
    const result = await uploadCaptures(client, [local("a", "h1")], {
        runName: "r",
        readImage,
        sleep: async (ms) => {
            waits.push(ms);
        },
    });
    assert.equal(waits.length, 2);
    assert.equal(result.uploaded, 1);
    assert.deepEqual(result.failed, []);
});

// M5: a stop (e.g. access_denied) is not an "upload loop crash" – only that
// case may swallow a completion failure. A stop that still tries to complete
// must propagate a completion error too, or CI would report the stop without
// ever noticing the run was left open on the server.
test("uploadCaptures: a failing complete after a stop still rejects, it is not swallowed", async () => {
    const { client } = fakeClient({ failOn: { a: new TranslatizeApiError("denied", 401, "access_denied") } });
    client.completeScreenshotRun = async () => {
        throw new TranslatizeApiError("server error", 500, "internal_error");
    };
    await assert.rejects(
        () => uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage }),
        /server error/,
    );
});

// M5: the central bug – every screen uploaded fine, but completing the run
// itself failed. That must not be swallowed into a quietly-null `run`, or the
// CLI would exit 0 while the run stays open on the server.
test("uploadCaptures: a failing complete on the success path rejects instead of being swallowed", async () => {
    const { client, uploads } = fakeClient();
    client.completeScreenshotRun = async () => {
        throw new TranslatizeApiError("server error", 500, "internal_error");
    };
    await assert.rejects(
        () => uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage }),
        /server error/,
    );
    assert.deepEqual(uploads.map((u) => u.name), ["a"], "the screen was still uploaded before completion failed");
});

// M5: the one case a completion failure IS swallowed – the upload loop itself
// already crashed (a non-API error), so the original crash is what matters
// and must not be hidden behind a secondary completion failure.
test("uploadCaptures: after an unexpected crash, a second failure completing the run is swallowed in favor of the original error", async () => {
    const { client } = fakeClient();
    client.uploadScreenshot = async (_runId, input) => {
        if (input.meta.name === "a") throw new Error("ECONNRESET");
        return { screenshotId: "s", deduped: false, links: 0 };
    };
    client.completeScreenshotRun = async () => {
        throw new Error("also failed completing");
    };
    await assert.rejects(
        () => uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage }),
        /ECONNRESET/,
    );
});

// A non-TranslatizeApiError (network drop, a file disappearing mid-upload, …)
// used to skip completion entirely and leave the run open on the server until
// its 24h GC timeout – screens already sent would then never run through the
// server's own supersede logic. The CLI must now still complete the run with
// whatever was already sent before the error is reported.
test("uploadCaptures: an unexpected (non-API) error still completes the run, then rethrows", async () => {
    const { client, calls, uploads } = fakeClient();
    client.uploadScreenshot = async (runId, input) => {
        if (input.meta.name === "b") throw new Error("ECONNRESET");
        uploads.push({ name: input.meta.name, withImage: input.image !== undefined });
        return { screenshotId: `s-${input.meta.name}`, deduped: false, links: 1 };
    };
    await assert.rejects(
        () => uploadCaptures(client, [local("a", "h1"), local("b", "h2"), local("c", "h3")], { runName: "r", readImage }),
        /ECONNRESET/,
    );
    assert.deepEqual(uploads.map((u) => u.name), ["a"]);
    assert.ok(calls.includes("complete:run1"), "the run was still completed with whatever got through");
});

test("uploadCaptures: an unexpected error after run_not_open/run_not_found does not try to complete", async () => {
    const { client, calls } = fakeClient({ failOn: { a: new TranslatizeApiError("closed", 409, "run_not_open") } });
    client.completeScreenshotRun = async () => {
        throw new Error("should not be called");
    };
    const result = await uploadCaptures(client, [local("a", "h1")], { runName: "r", readImage });
    assert.equal(result.stopped?.code, "run_not_open");
    assert.equal(calls.includes("complete:run1"), false);
});
