import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TranslatizeClient, TranslatizeApiError, type MergeGateSummary } from "../src/index.js";

interface MockCall {
    url: string;
    method: string;
    headers: Record<string, string>;
    body: string | undefined;
    /** The body exactly as passed to fetch (a FormData for multipart uploads). */
    rawBody: unknown;
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
            body: typeof init.body === "string" ? init.body : undefined,
            rawBody: init.body,
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
    assert.equal(calls[0].headers["user-agent"], "translatize-core/0.2.0");
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

test("mergeBranch(): branch-changes is sent as given and overlappingKeys come back", async () => {
    const resp = { message: "ok", source: "pr-7", target: "main", strategy: "branch-changes", overlappingKeys: ["home.title"], overlappingCount: 1 };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: resp });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.mergeBranch("pr-7", { strategy: "branch-changes" });
    assert.deepEqual(JSON.parse(calls[1].body as string), { strategy: "branch-changes" });
    assert.deepEqual(out.overlappingKeys, ["home.title"]);
    assert.equal(out.overlappingCount, 1);
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

test("rebaseLabels(): POSTs keys + langs to .../branches/:name/labels/rebase", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { rebased: 1, notFound: [] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.rebaseLabels("pr-7", ["auth.logout"], { langs: ["en"] });
    assert.deepEqual(out, { rebased: 1, notFound: [] });
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, "https://api.example.com/v1/integrations/projects/proj123/branches/pr-7/labels/rebase");
    assert.deepEqual(JSON.parse(calls[1].body as string), { keys: ["auth.logout"], langs: ["en"] });
});

test("rebaseLabels(): omits `langs` when not given", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { rebased: 1, notFound: [] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.rebaseLabels("pr-7", ["a.key"]);
    assert.deepEqual(JSON.parse(calls[1].body as string), { keys: ["a.key"] });
});

test("rebaseLabels(): chunks 501 keys into batches of 500 + 1 and aggregates rebased/notFound", async () => {
    const batchSizes: number[] = [];
    installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { keys: string[] };
        batchSizes.push(parsed.keys.length);
        return { json: { rebased: parsed.keys.length - 1, notFound: [parsed.keys[0]] } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const keys = Array.from({ length: 501 }, (_, i) => `k${i}`);
    const result = await client.rebaseLabels("pr-7", keys);
    assert.deepEqual(batchSizes, [500, 1]);
    assert.equal(result.rebased, 499);
    assert.deepEqual(result.notFound, ["k0", "k500"]);
});

test("rebaseLabels(): empty `keys` makes no network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const result = await client.rebaseLabels("pr-7", []);
    assert.deepEqual(result, { rebased: 0, notFound: [] });
    assert.equal(calls.length, 0);
});

test("branch methods reject a blank branch name without a network call", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(() => client.compareBranch(""), /branch name/);
    await assert.rejects(() => client.branchConflicts("   "), /branch name/);
    await assert.rejects(() => client.mergeBranch(""), /branch name/);
    await assert.rejects(() => client.deleteBranch(""), /branch name/);
    await assert.rejects(() => client.rebaseLabels("", ["a"]), /branch name/);
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

// ============================================================================
// 0.2.0 – extra headers, label context
// ============================================================================

const BASE = "https://api.example.com/v1/integrations/projects/proj123";

test("headers option: extra headers go out on every request, including the me() lookup", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { terms: [] } });
    const client = new TranslatizeClient({
        apiUrl: "https://api.example.com/v1",
        token: "mcni_abc",
        headers: { "X-Internal-Token": "secret-123" },
    });
    await client.getGlossary();
    assert.equal(calls.length, 2);
    for (const call of calls) {
        assert.equal(call.headers["x-internal-token"], "secret-123");
        assert.equal(call.headers["authorization"], "Bearer mcni_abc");
    }
});

test("headers option: may replace User-Agent case-insensitively, never Authorization or Content-Type", async () => {
    const calls = installFetchMock(() => ({ json: ME_RESPONSE }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t", headers: { "user-agent": "github-app/1" } });
    await client.me();
    assert.equal(calls[0].headers["user-agent"], "github-app/1");
    assert.throws(() => new TranslatizeClient({ apiUrl: "x", token: "t", headers: { authorization: "Bearer other" } }), /cannot be overridden/);
    assert.throws(() => new TranslatizeClient({ apiUrl: "x", token: "t", headers: { "Content-Type": "text/plain" } }), /cannot be overridden/);
});

test("upsertLabel(): sends context and tags as given", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { key: "a", branch: "main", created: false, values: {}, status: "draft", tags: ["ui"] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.upsertLabel({
        key: "checkout.pay",
        values: { en: "Pay now" },
        tags: ["ui"],
        context: { description: "Primary button on the checkout page", charLimit: 20, location: "src/Checkout.tsx:42" },
    });
    assert.deepEqual(JSON.parse(calls[1].body as string), {
        key: "checkout.pay",
        values: { en: "Pay now" },
        tags: ["ui"],
        context: { description: "Primary button on the checkout page", charLimit: 20, location: "src/Checkout.tsx:42" },
    });
});

test("upsertLabels(): context-only items are sent without values", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { updated: 1, created: 0, failed: [{ key: "gone", error: "label_not_found" }] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.upsertLabels([{ key: "a", context: { charLimit: 30 } }, { key: "gone", tags: ["x"] }], { branch: "feature" });
    assert.deepEqual(JSON.parse(calls[1].body as string), {
        labels: [{ key: "a", context: { charLimit: 30 } }, { key: "gone", tags: ["x"] }],
        branch: "feature",
    });
    assert.deepEqual(out.failed, [{ key: "gone", error: "label_not_found" }]);
});

// ============================================================================
// 0.2.0 – glossary + translation memory
// ============================================================================

test("getGlossary(): GETs .../glossary", async () => {
    const terms = [{ id: "g1", term: "Translatize", translations: { lv: "Translatize" }, description: null, caseSensitive: true, prohibited: false, category: null, scope: "workspace" }];
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { terms } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.getGlossary();
    assert.equal(out.terms[0].scope, "workspace");
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, `${BASE}/glossary`);
});

test("findTranslationMemory(): POSTs texts + langs (+ threshold) to .../tm/matches", async () => {
    const results = [{ text: "Save", matches: [{ sourceText: "Save", targetText: "Saglabāt", match: 100, quality: 1, placeholderMapped: false, origin: "approved" }] }];
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { results } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.findTranslationMemory({ texts: ["Save"], sourceLang: "en", targetLang: "lv", threshold: 90 });
    assert.equal(out.results[0].matches[0].targetText, "Saglabāt");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/tm/matches`);
    assert.deepEqual(JSON.parse(calls[1].body as string), { texts: ["Save"], sourceLang: "en", targetLang: "lv", threshold: 90 });
});

test("findTranslationMemory(): chunks 101 texts into 100 + 1 and keeps the result order", async () => {
    const sizes: number[] = [];
    installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { texts: string[]; threshold?: number };
        sizes.push(parsed.texts.length);
        assert.equal("threshold" in parsed, false);
        return { json: { results: parsed.texts.map((text) => ({ text, matches: [] })) } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const texts = Array.from({ length: 101 }, (_, i) => `t${i}`);
    const out = await client.findTranslationMemory({ texts, sourceLang: "en", targetLang: "lv" });
    assert.deepEqual(sizes, [100, 1]);
    assert.deepEqual(out.results.map((r) => r.text), texts);
});

test("findTranslationMemory(): empty texts make no call; missing langs throw", async () => {
    const calls = installFetchMock(() => ({ json: {} }));
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    assert.deepEqual(await client.findTranslationMemory({ texts: [], sourceLang: "en", targetLang: "lv" }), { results: [] });
    await assert.rejects(() => client.findTranslationMemory({ texts: ["a"], sourceLang: "en", targetLang: "" }), /targetLang/);
    assert.equal(calls.length, 0);
});

// ============================================================================
// 0.2.0 – QA, merge gate, AI review
// ============================================================================

const ISSUE = {
    id: "i1", branch: "feature", key: "app.count", lang: "lv", checkId: "placeholders", severity: "error",
    code: "placeholder_missing", params: { missing: ["{count}"] }, source: "rule", ignored: false, createdAt: "2026-10-27T00:00:00.000Z",
};

test("runQa(): POSTs branch + keys to .../qa/run and returns the inline result", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { branch: "feature", pairsChecked: 4, counts: { error: 1, warning: 0, info: 0 }, issues: [ISSUE] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.runQa({ branch: "feature", keys: ["app.count"] });
    assert.equal(out.background, undefined);
    if (out.background !== true) {
        assert.equal(out.counts.error, 1);
        assert.equal(out.issues[0].code, "placeholder_missing");
    }
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/qa/run`);
    assert.deepEqual(JSON.parse(calls[1].body as string), { branch: "feature", keys: ["app.count"] });
});

test("runQa(): no options send an empty body; a 202 background answer is passed through", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 202, json: { branch: "main", background: true } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.runQa();
    assert.equal(out.background, true);
    assert.deepEqual(JSON.parse(calls[1].body as string), {});
});

test("listQaIssues(): sends every filter as a query param, numbers stringified", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { issues: [ISSUE], nextCursor: "c2", counts: { error: 1, warning: 0, info: 0 } } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.listQaIssues({ branch: "feature", severity: "error", key: "app.count", source: "rule", cursor: "c1", limit: 50 });
    assert.equal(out.nextCursor, "c2");
    assert.equal(
        calls[1].url,
        `${BASE}/qa/issues?branch=feature&severity=error&key=app.count&source=rule&cursor=c1&limit=50`,
    );
});

test("listQaIssues(): omits filters that are not given", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { issues: [], nextCursor: null, counts: { error: 0, warning: 0, info: 0 } } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.listQaIssues();
    assert.equal(calls[1].url, `${BASE}/qa/issues`);
});

test("getMergeGate(): GETs .../branches/:name/merge-gate with the name encoded", async () => {
    const gate = { mode: "block", applies: true, blocked: true, errors: 1, warnings: 0, pairsChecked: 3, issues: [ISSUE] };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { target: "main", gate } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.getMergeGate("agent-copy");
    assert.equal(out.target, "main");
    assert.equal(out.gate.blocked, true);
    assert.equal(calls[1].method, "GET");
    assert.equal(calls[1].url, `${BASE}/branches/agent-copy/merge-gate`);
    await assert.rejects(() => client.getMergeGate(" "), /branch name/);
});

test("getMergeGate(): previews the strategy the merge will use", async () => {
    const gate = { mode: "warn", applies: true, blocked: false, errors: 0, warnings: 0, pairsChecked: 1, issues: [] };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { target: "main", gate } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.getMergeGate("pr-7", { strategy: "branch-changes" });
    assert.equal(calls[1].url, `${BASE}/branches/pr-7/merge-gate?strategy=branch-changes`);
});

test("mergeBranch(): a gate that could not run comes back as the warn-mode error shape", async () => {
    const unavailable = { mode: "warn", applies: true, error: "gate_unavailable" };
    installFetchMock((call) => meRoute(call) ?? { json: { message: "ok", source: "feature", target: "main", strategy: "overwrite", gate: unavailable } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.mergeBranch("feature");
    // Narrowed by `error`: the counts exist only on a gate that ran.
    const errorsOf = (gate: MergeGateSummary): number | null => (gate.error ? null : gate.errors);
    assert.ok(out.gate);
    assert.equal(errorsOf(out.gate), null);
    assert.equal(errorsOf({ mode: "block", applies: true, blocked: true, errors: 2, warnings: 0, pairsChecked: 3, overridden: false }), 2);
    assert.deepEqual(out.gate, unavailable);
});

test("mergeBranch(): a 409 qa_gate_blocked keeps the gate in details; 403 admin_token_required_for_main maps", async () => {
    const gate = { mode: "block", applies: true, blocked: true, errors: 2, warnings: 0, pairsChecked: 3, issues: [] };
    let answer: MockResponseSpec = { status: 409, json: { error: "qa_gate_blocked", gate } };
    installFetchMock((call) => meRoute(call) ?? answer);
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.mergeBranch("feature"),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.status, 409);
            assert.equal(err.code, "qa_gate_blocked");
            assert.deepEqual((err.details as { gate: unknown }).gate, gate);
            return true;
        },
    );
    answer = { status: 403, json: { error: "admin_token_required_for_main" } };
    await assert.rejects(
        () => client.mergeBranch("feature"),
        (err: unknown) => err instanceof TranslatizeApiError && err.status === 403 && err.code === "admin_token_required_for_main",
    );
});

test("startAiReview(): POSTs branch/keys/langs to .../qa/ai-review", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 202, json: { jobId: "r1", status: "queued", pairs: 10, estimatedCharacters: 420 } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.startAiReview({ branch: "feature", keys: ["a"], langs: ["lv"] });
    assert.equal(out.jobId, "r1");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/qa/ai-review`);
    assert.deepEqual(JSON.parse(calls[1].body as string), { branch: "feature", keys: ["a"], langs: ["lv"] });
});

test("startAiReview(): plan and quota errors keep their code and details", async () => {
    let answer: MockResponseSpec = { status: 403, json: { error: "feature_not_available", feature: "aiReview" } };
    installFetchMock((call) => meRoute(call) ?? answer);
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.startAiReview(),
        (err: unknown) => err instanceof TranslatizeApiError && err.code === "feature_not_available" && err.details?.feature === "aiReview",
    );
    answer = { status: 403, json: { error: "ai_review_quota_exceeded", used: 10, limit: 10 } };
    await assert.rejects(
        () => client.startAiReview(),
        (err: unknown) => err instanceof TranslatizeApiError && err.code === "ai_review_quota_exceeded" && err.details?.limit === 10,
    );
});

test("aiReviewStatus(): GETs .../qa/ai-review/status", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { job: null } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.aiReviewStatus();
    assert.equal(out.job, null);
    assert.equal(calls[1].url, `${BASE}/qa/ai-review/status`);
});

// ============================================================================
// 0.2.0 – screenshot capture runs
// ============================================================================

test("createScreenshotRun(): POSTs name/branch/commitSha; a blank name throws first", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 201, json: { runId: "run1" } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.createScreenshotRun({ name: "e2e", branch: "feature", commitSha: "abc123" });
    assert.equal(out.runId, "run1");
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/screenshots/runs`);
    assert.deepEqual(JSON.parse(calls[1].body as string), { name: "e2e", branch: "feature", commitSha: "abc123" });
    await assert.rejects(() => client.createScreenshotRun({ name: "" }), /name/);
    assert.equal(calls.length, 2);
});

test("createScreenshotRun(): 429 capture_run_limit maps to the error code", async () => {
    installFetchMock((call) => meRoute(call) ?? { status: 429, json: { error: "capture_run_limit", limit: 30 } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.createScreenshotRun({ name: "e2e" }),
        (err: unknown) => err instanceof TranslatizeApiError && err.status === 429 && err.code === "capture_run_limit",
    );
});

test("checkScreenshots(): POSTs clientHashes, chunked by 500, and merges `existing`", async () => {
    const sizes: number[] = [];
    const calls = installFetchMock((call) => {
        const me = meRoute(call);
        if (me) return me;
        const parsed = JSON.parse(call.body as string) as { clientHashes: string[] };
        sizes.push(parsed.clientHashes.length);
        return { json: { existing: parsed.clientHashes.slice(0, 1) } };
    });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const hashes = Array.from({ length: 501 }, (_, i) => `h${i}`);
    const out = await client.checkScreenshots("run 1", hashes);
    assert.deepEqual(sizes, [500, 1]);
    assert.deepEqual(out.existing, ["h0", "h500"]);
    assert.equal(calls[1].url, `${BASE}/screenshots/runs/run%201/check`);
    assert.deepEqual(await client.checkScreenshots("run1", []), { existing: [] });
    assert.equal(calls.length, 3);
});

test("uploadScreenshot(): sends multipart meta + image, without a JSON content type", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 201, json: { screenshotId: "s1", deduped: false, links: 3 } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const meta = { name: "checkout", viewport: { width: 1280, height: 720 }, locale: "en", clientHash: "ab".repeat(32), regions: [{ text: "Pay", rect: { x: 1, y: 2, w: 3, h: 4 } }] };
    const out = await client.uploadScreenshot("run1", { image: new Uint8Array([137, 80, 78, 71]), meta });
    assert.equal(out.links, 3);
    const call = calls[1];
    assert.equal(call.method, "POST");
    assert.equal(call.url, `${BASE}/screenshots/runs/run1/screens`);
    assert.equal(call.headers["content-type"], undefined);
    assert.ok(call.rawBody instanceof FormData);
    const form = call.rawBody as FormData;
    assert.deepEqual(JSON.parse(form.get("meta") as string), meta);
    const image = form.get("image") as Blob;
    assert.equal(image.type, "image/png");
    assert.deepEqual([...new Uint8Array(await image.arrayBuffer())], [137, 80, 78, 71]);
});

test("uploadScreenshot(): meta only when no image is given", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 201, json: { screenshotId: "s1", deduped: true, links: 0 } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.uploadScreenshot("run1", { meta: { name: "home", clientHash: "cd".repeat(32), regions: [] } });
    const form = calls[1].rawBody as FormData;
    assert.equal(form.get("image"), null);
    assert.equal(JSON.parse(form.get("meta") as string).name, "home");
});

test("uploadScreenshot(): 413 image_too_large and 403 screenshot_quota_exceeded map", async () => {
    let answer: MockResponseSpec = { status: 413, json: { error: "image_too_large" } };
    installFetchMock((call) => meRoute(call) ?? answer);
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const input = { image: new Uint8Array([1]), meta: { name: "x", regions: [] } };
    await assert.rejects(() => client.uploadScreenshot("run1", input), (err: unknown) => err instanceof TranslatizeApiError && err.code === "image_too_large");
    answer = { status: 403, json: { error: "screenshot_quota_exceeded" } };
    await assert.rejects(() => client.uploadScreenshot("run1", input), (err: unknown) => err instanceof TranslatizeApiError && err.code === "screenshot_quota_exceeded");
    answer = { status: 429, json: { error: "run_screen_limit" } };
    await assert.rejects(() => client.uploadScreenshot("run1", input), (err: unknown) => err instanceof TranslatizeApiError && err.code === "run_screen_limit");
});

test("completeScreenshotRun(): POSTs .../runs/:id/complete; a blank id throws", async () => {
    const run = { id: "run1", status: "completed", counts: { screens: 2, linked: 5, ambiguous: 1, superseded: 1 } };
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { run } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.completeScreenshotRun("run1");
    assert.equal(out.run.counts.linked, 5);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/screenshots/runs/run1/complete`);
    await assert.rejects(() => client.completeScreenshotRun(""), /run id/);
});

// ============================================================================
// 0.2.0 – OTA distributions and releases
// ============================================================================

test("listDistributions(): GETs .../ota/distributions", async () => {
    const distributions = [{ id: "d1", name: "Web", publicId: "A".repeat(22), branch: "main", publishFilter: "all", format: "json-flat", autoPublishOnMerge: false, status: "active", latestVersion: 3, manifestUrl: "https://cdn.translatize.com/d/x/manifest.json" }];
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { distributions } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.listDistributions();
    assert.equal(out.distributions[0].latestVersion, 3);
    assert.equal(calls[1].url, `${BASE}/ota/distributions`);
});

test("publishRelease(): POSTs {} to .../ota/distributions/:id/releases", async () => {
    const release = { version: 4, labelCount: 120, languages: { en: { path: "/d/x/v4/en.json", hash: "h", bytes: 10 } }, createdAt: "2026-10-27T00:00:00.000Z" };
    const calls = installFetchMock((call) => meRoute(call) ?? { status: 201, json: { release, manifestUrl: "https://cdn.translatize.com/d/x/manifest.json" } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    const out = await client.publishRelease("d1");
    assert.equal(out.release.version, 4);
    assert.equal(calls[1].method, "POST");
    assert.equal(calls[1].url, `${BASE}/ota/distributions/d1/releases`);
    assert.deepEqual(JSON.parse(calls[1].body as string), {});
    await assert.rejects(() => client.publishRelease(" "), /distribution id/);
});

test("publishRelease(): branch_not_allowed for a distribution on another branch keeps its details", async () => {
    installFetchMock((call) => meRoute(call) ?? { status: 400, json: { error: "branch_not_allowed", boundBranch: "main", allowedBranches: ["main"] } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.publishRelease("d2"),
        (err: unknown) => {
            assert.ok(err instanceof TranslatizeApiError);
            assert.equal(err.code, "branch_not_allowed");
            assert.deepEqual(err.details?.allowedBranches, ["main"]);
            return true;
        },
    );
});

test("listQaIssues(): lang and includeIgnored go out as query params", async () => {
    const calls = installFetchMock((call) => meRoute(call) ?? { json: { issues: [], nextCursor: null, counts: { error: 0, warning: 0, info: 0 } } });
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await client.listQaIssues({ lang: "lv", includeIgnored: true });
    assert.equal(calls[1].url, `${BASE}/qa/issues?lang=lv&includeIgnored=true`);
});

test("non-2xx validation bodies become a readable message, the code stays", async () => {
    let answer: MockResponseSpec = { status: 400, json: { errors: [{ name: '"name" length must be at most 100' }] } };
    installFetchMock(() => answer);
    const client = new TranslatizeClient({ apiUrl: "https://api.example.com/v1", token: "t" });
    await assert.rejects(
        () => client.me(),
        (err: unknown) => err instanceof TranslatizeApiError && err.code === "http_400" && /at most 100/.test(err.message),
    );
    answer = { status: 400, json: { error: "invalid_request", details: [{ path: "branch", message: '"branch" is not allowed' }] } };
    await assert.rejects(
        () => client.me(),
        (err: unknown) => err instanceof TranslatizeApiError && err.code === "invalid_request" && /"branch" is not allowed/.test(err.message),
    );
    answer = { status: 400, json: { error: "invalid_meta", detail: "meta is not valid JSON" } };
    await assert.rejects(
        () => client.me(),
        (err: unknown) => err instanceof TranslatizeApiError && err.code === "invalid_meta" && err.message === "meta is not valid JSON",
    );
});
