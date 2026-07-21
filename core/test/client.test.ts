import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TranslatizeClient, TranslatizeApiError } from "../src/index.js";

interface MockCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
}

interface MockResponseSpec {
    status?: number;
    json?: unknown;
    text?: string;
}

type Router = (call: MockCall) => MockResponseSpec;

const ORIGINAL_FETCH = globalThis.fetch;

function normalizeHeaders(raw: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (raw && typeof raw === "object") {
        for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
            out[k.toLowerCase()] = String(v);
        }
    }
    return out;
}

// Replace globalThis.fetch with a router that records every call. Returns the
// (mutable) list of recorded calls; afterEach restores the real fetch.
function installFetchMock(router: Router): MockCall[] {
    const calls: MockCall[] = [];
    const mock = async (input: unknown, init: Record<string, unknown> = {}): Promise<unknown> => {
        const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
        const method = String((init.method as string | undefined) ?? "GET").toUpperCase();
        const call: MockCall = {
            url,
            method,
            headers: normalizeHeaders(init.headers),
            body: init.body as string | undefined,
        };
        calls.push(call);
        const spec = router(call);
        const status = spec.status ?? 200;
        const bodyText = spec.text !== undefined ? spec.text : JSON.stringify(spec.json ?? {});
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: "",
            json: async () => (spec.json !== undefined ? spec.json : JSON.parse(bodyText)),
            text: async () => bodyText,
        };
    };
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;
    return calls;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

const ME_RESPONSE = {
    project: { id: "proj123", name: "Demo", langs: ["en", "lv"] },
    branch: "main",
    role: "developer",
    token: { name: "ci", autoPublish: false, expiresAt: null },
};

// Answer the me() lookup a project-scoped method makes before its real call.
function meRoute(call: MockCall): MockResponseSpec | undefined {
    return call.url.endsWith("/integrations/me") ? { json: ME_RESPONSE } : undefined;
}

test("me(): sends auth + user-agent headers and parses the response", async () => {
    const calls = installFetchMock(() => ({ json: ME_RESPONSE }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "mcni_abc" });
    const me = await client.me();
    assert.equal(me.project.id, "proj123");
    assert.equal(me.branch, "main");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.example.com/v1/integrations/me");
    assert.equal(calls[0].method, "GET");
    assert.equal(calls[0].headers["authorization"], "Bearer mcni_abc");
    assert.equal(calls[0].headers["user-agent"], "translatize-core/0.1.1");
});

test("trailing slash in apiUrl is tolerated", async () => {
    const calls = installFetchMock(() => ({ json: ME_RESPONSE }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1/", token: "t" });
    await client.me();
    assert.equal(calls[0].url, "https://api.example.com/v1/integrations/me");
});

test("non-2xx maps the JSON error field to TranslatizeApiError.code/status", async () => {
    installFetchMock(() => ({ status: 403, json: { error: "insufficient_permissions", message: "nope" } }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.status, 403);
            assert.equal(err.code, "insufficient_permissions");
            assert.equal(err.message, "nope");
            return true;
        },
    );
});

test("non-2xx exposes the parsed JSON error body as details (e.g. boundBranch)", async () => {
    installFetchMock(() => ({ status: 400, json: { error: "branch_not_allowed", boundBranch: "main" } }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.code, "branch_not_allowed");
            assert.deepEqual(err.details, { error: "branch_not_allowed", boundBranch: "main" });
            return true;
        },
    );
});

test("non-2xx without a JSON error body leaves details undefined", async () => {
    installFetchMock(() => ({ status: 500, text: "Internal Server Error" }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.details, undefined);
            return true;
        },
    );
});

test("non-2xx without a JSON error body falls back to http_<status>", async () => {
    installFetchMock(() => ({ status: 500, text: "Internal Server Error" }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.status, 500);
            assert.equal(err.code, "http_500");
            return true;
        },
    );
});

test("non-2xx with an error code but no message uses the code as the message", async () => {
    installFetchMock(() => ({ status: 401, json: { error: "token_expired" } }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.status, 401);
            assert.equal(err.code, "token_expired");
            assert.equal(err.message, "token_expired");
            return true;
        },
    );
});

test("listLabels(): resolves project id via me() then hits the labels endpoint with filters", async () => {
    const listResponse = {
        branch: "main",
        total: 1,
        labels: [{ key: "app.title", values: { en: "Hi" }, status: "approved", tags: [], updatedAt: "2026-01-01T00:00:00.000Z" }],
    };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: listResponse });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const result = await client.listLabels({ namespace: "app", status: "approved" });
    assert.equal(result.total, 1);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].url.endsWith("/integrations/me"));
    assert.equal(
        calls[1].url,
        "https://api.example.com/v1/integrations/projects/proj123/labels?namespace=app&status=approved",
    );
    assert.equal(calls[1].method, "GET");
});

test("listLabels(): omits query params that are not provided", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { branch: "main", total: 0, labels: [] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.listLabels();
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/labels");
});

test("exportFile(): returns the raw body verbatim", async () => {
    const raw = '{"en":{"app.title":"Hi"}}';
    const calls = installFetchMock((call) => meRoute(call) ?? { text: raw });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.exportFile({ format: "json" });
    assert.equal(out, raw);
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/export?format=json");
});

test("upsertLabel(): PATCHes the single-label endpoint with a JSON body", async () => {
    const created = { key: "app.title", branch: "main", created: true, values: { en: "Hi" }, status: "draft", tags: [] };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: created });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const result = await client.upsertLabel({ key: "app.title", values: { en: "Hi" } });
    assert.equal(result.created, true);
    const patch = calls[1];
    assert.equal(patch.method, "PATCH");
    assert.equal(patch.url, "https://api.example.com/v1/integrations/projects/proj123/labels");
    assert.equal(patch.headers["content-type"], "application/json");
    assert.deepEqual(JSON.parse(patch.body as string), { key: "app.title", values: { en: "Hi" } });
});

test("upsertLabels(): chunks 501 items into batches of 500 + 1 and aggregates counts", async () => {
    const batchSizes: number[] = [];
    const calls = installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { labels: unknown[] };
        batchSizes.push(parsed.labels.length);
        return { json: { updated: parsed.labels.length, created: 0, failed: [] } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const labels = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}`, values: { en: String(i) } }));
    const result = await client.upsertLabels(labels);
    assert.deepEqual(batchSizes, [500, 1]);
    assert.equal(result.updated, 501);
    assert.equal(result.created, 0);
    assert.equal(result.failed.length, 0);
    // 1 me() call + 2 batch calls.
    assert.equal(calls.length, 3);
    assert.ok(calls[1].url.endsWith("/integrations/projects/proj123/labels/batch"));
});

test("upsertLabels(): chunks 1000 items into two batches of 500", async () => {
    const batchSizes: number[] = [];
    installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { labels: unknown[] };
        batchSizes.push(parsed.labels.length);
        return { json: { updated: 0, created: parsed.labels.length, failed: [] } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const labels = Array.from({ length: 1000 }, (_, i) => ({ key: `k${i}` }));
    const result = await client.upsertLabels(labels);
    assert.deepEqual(batchSizes, [500, 500]);
    assert.equal(result.created, 1000);
});

test("upsertLabels(): aggregates failed items across batch responses", async () => {
    installFetchMock((call) =>
        meRoute(call) ?? { json: { updated: 1, created: 0, failed: [{ key: "bad", error: "invalid_input" }] } },
    );
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const result = await client.upsertLabels([{ key: "ok" }, { key: "bad" }]);
    assert.equal(result.updated, 1);
    assert.deepEqual(result.failed, [{ key: "bad", error: "invalid_input" }]);
});

test("upsertLabels(): empty input makes no network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const result = await client.upsertLabels([]);
    assert.deepEqual(result, { updated: 0, created: 0, failed: [] });
    assert.equal(calls.length, 0);
});

test("constructor validates required options", () => {
    assert.throws(() => new TranslatizeClient({ apiUrl: "", token: "t" }), /apiUrl/);
    assert.throws(() => new TranslatizeClient({ apiUrl: "x", token: "" }), /token/);
});

// ============================================================================
// V2 — branch parameter on the four label methods
// ============================================================================

test("listLabels(): sends `branch` as a query param when provided", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { branch: "feature", total: 0, labels: [] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.listLabels({ namespace: "app", status: "approved", branch: "feature" });
    assert.equal(
        calls[1].url,
        "https://api.example.com/v1/integrations/projects/proj123/labels?namespace=app&status=approved&branch=feature",
    );
});

test("exportFile(): sends `branch` as a query param when provided", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { text: "{}" });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.exportFile({ format: "json", branch: "feature" });
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/export?format=json&branch=feature");
});

test("upsertLabel(): adds `branch` to the PATCH body when provided, and omits it otherwise", async () => {
    const created = { key: "app.title", branch: "feature", created: true, values: { en: "Hi" }, status: "draft", tags: [] };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: created });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });

    await client.upsertLabel({ key: "app.title", values: { en: "Hi" } }, { branch: "feature" });
    assert.deepEqual(JSON.parse(calls[1].body as string), { key: "app.title", values: { en: "Hi" }, branch: "feature" });

    // No branch option => body carries no `branch` key (server uses the bound branch).
    await client.upsertLabel({ key: "app.title", values: { en: "Hi" } });
    assert.deepEqual(JSON.parse(calls[2].body as string), { key: "app.title", values: { en: "Hi" } });
});

test("upsertLabels(): adds `branch` to every batch body and keeps 500-chunking", async () => {
    const branches: (string | undefined)[] = [];
    const sizes: number[] = [];
    installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { labels: unknown[]; branch?: string };
        branches.push(parsed.branch);
        sizes.push(parsed.labels.length);
        return { json: { updated: parsed.labels.length, created: 0, failed: [] } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const labels = Array.from({ length: 501 }, (_, i) => ({ key: `k${i}` }));
    const result = await client.upsertLabels(labels, { branch: "feature" });
    assert.deepEqual(sizes, [500, 1]);
    assert.deepEqual(branches, ["feature", "feature"]);
    assert.equal(result.updated, 501);
});

// ============================================================================
// V2 — branch endpoints
// ============================================================================

test("listBranches(): GETs the branches endpoint and parses the response", async () => {
    const listResponse = {
        baseBranch: "main",
        branchScope: "create-own",
        branches: [
            { name: "main", description: "", basedOn: null, createdAt: "2026-01-01T00:00:00.000Z", createdByThisToken: false, writable: true },
            { name: "feature", description: "", basedOn: "main", createdAt: "2026-02-01T00:00:00.000Z", createdByThisToken: true, writable: true },
        ],
    };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: listResponse });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.listBranches();
    assert.equal(out.baseBranch, "main");
    assert.equal(out.branchScope, "create-own");
    assert.equal(out.branches.length, 2);
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches");
    assert.equal(calls[1].method, "GET");
});

test("createBranch(): POSTs name (+ description) to the branches endpoint", async () => {
    const resp = { branch: { name: "feature", description: "wip", isDefault: false, basedOn: "main", createdBy: "u1", createdAt: "x", lastModified: "x", createdByName: "CI" } };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });

    const out = await client.createBranch({ name: "feature", description: "wip" });
    assert.equal(out.branch.name, "feature");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches");
    assert.deepEqual(JSON.parse(calls[1].body as string), { name: "feature", description: "wip" });

    // description omitted => not present in the body.
    await client.createBranch({ name: "feature2" });
    assert.deepEqual(JSON.parse(calls[2].body as string), { name: "feature2" });
});

test("createBranch(): rejects a missing name without a network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(() => client.createBranch({ name: "  " }), /name/);
    assert.equal(calls.length, 0);
});

test("compareBranch(): GETs .../branches/:name/compare against the base", async () => {
    const resp = { source: "feature", target: "main", differences: { changed: [], added: [], deleted: [] }, summary: { changed: 0, added: 0, deleted: 0, total: 0 } };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.compareBranch("feature");
    assert.equal(out.source, "feature");
    assert.equal(out.target, "main");
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches/feature/compare");
});

test("branchConflicts(): GETs .../branches/:name/conflicts against the base", async () => {
    const resp = { source: "feature", target: "main", conflicts: [{ key: "a", lang: "en", sourceValue: "x", targetValue: "y" }], hasConflicts: true, conflictCount: 1 };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.branchConflicts("feature");
    assert.equal(out.hasConflicts, true);
    assert.equal(out.conflictCount, 1);
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches/feature/conflicts");
});

test("mergeBranch(): POSTs strategy + conflicts and never sends `target`", async () => {
    const resp = { message: "Branch merged successfully", source: "feature", target: "main", strategy: "manual" };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const conflicts = [{ key: "a", lang: "en", resolution: "custom" as const, customValue: "z" }];
    const out = await client.mergeBranch("feature", { strategy: "manual", conflicts });
    assert.equal(out.strategy, "manual");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches/feature/merge");
    const body = JSON.parse(calls[1].body as string);
    assert.deepEqual(body, { strategy: "manual", conflicts });
    assert.equal("target" in body, false);
});

test("mergeBranch(): default options send an empty body (server defaults to overwrite)", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { message: "ok", source: "feature", target: "main", strategy: "overwrite" } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.mergeBranch("feature");
    assert.deepEqual(JSON.parse(calls[1].body as string), {});
});

test("deleteBranch(): sends a DELETE to .../branches/:name", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { message: "Branch deleted successfully" } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.deleteBranch("feature");
    assert.match(out.message, /deleted/);
    assert.equal(calls[1].method, "DELETE");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches/feature");
});

test("branch methods reject a blank branch name without a network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(() => client.compareBranch(""), /branch name/);
    await assert.rejects(() => client.branchConflicts("   "), /branch name/);
    await assert.rejects(() => client.mergeBranch(""), /branch name/);
    await assert.rejects(() => client.deleteBranch(""), /branch name/);
    assert.equal(calls.length, 0);
});

// ============================================================================
// V2 — auto-translate + translation status
// ============================================================================

test("autoTranslate(): POSTs only the provided fields and returns the started job", async () => {
    const started = { started: true, branch: "feature", job: { id: "j1", status: "queued", targetLangs: ["lv", "ru"], counts: { requestedLabels: 3, translatedValues: 0, failedValues: 0, skippedValues: 0 }, chars: { estimated: 100, actual: 0 } } };
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 202, json: started });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.autoTranslate({ branch: "feature", targetLangs: ["lv", "ru"], sourceLang: "en", labelKeys: ["a"], overwriteTranslated: true });
    assert.equal(out.started, true);
    if (out.started) {
        assert.equal(out.job.id, "j1");
    }
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/translation/auto-translate");
    assert.deepEqual(JSON.parse(calls[1].body as string), {
        targetLangs: ["lv", "ru"],
        branch: "feature",
        sourceLang: "en",
        labelKeys: ["a"],
        overwriteTranslated: true,
    });
});

test("autoTranslate(): minimal call sends only targetLangs", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 202, json: { started: true, branch: "main", job: { id: "j", status: "queued", targetLangs: ["lv"], counts: {}, chars: {} } } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.autoTranslate({ targetLangs: ["lv"] });
    assert.deepEqual(JSON.parse(calls[1].body as string), { targetLangs: ["lv"] });
});

test("autoTranslate(): parses the nothing-to-translate response (200)", async () => {
    const nothing = { started: false, nothingToTranslate: true, reason: "already_translated", sourceLang: "en", branch: "main" };
    installFetchMock((call) => meRoute(call) ?? { status: 200, json: nothing });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.autoTranslate({ targetLangs: ["lv"] });
    assert.equal(out.started, false);
    if (!out.started) {
        assert.equal(out.reason, "already_translated");
    }
});

test("autoTranslate(): rejects empty/missing targetLangs without a network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(() => client.autoTranslate({ targetLangs: [] }), /targetLangs/);
    await assert.rejects(() => client.autoTranslate({} as never), /targetLangs/);
    assert.equal(calls.length, 0);
});

test("translationStatus(): GETs .../translation/status and parses activeJob/lastJob + aiQuota", async () => {
    const resp = {
        activeJob: { jobId: "j1", status: "running", targetLangs: ["lv"], requestedLabels: 10 },
        lastJob: { id: "j0", status: "completed", branch: "main", sourceLang: "en", targetLangs: ["lv"], counts: {}, chars: {}, error: null, startedAt: null, finishedAt: null },
        aiQuota: { used: 100, limit: 1000, remaining: 900 },
    };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.translationStatus();
    assert.equal(out.aiQuota.remaining, 900);
    assert.equal(out.activeJob?.status, "running");
    assert.equal(out.lastJob?.status, "completed");
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/translation/status");
});
