import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

// The built binary under test (produced by `npm run build`, i.e. tsconfig.json -> dist/).
const SERVER_PATH = fileURLToPath(new URL("../../dist/index.js", import.meta.url));

// Fixture the mock API serves. lv is missing on app.subtitle, so lv completeness is 2/3.
const ME = {
    project: { id: "proj_abc", name: "Demo Shop", langs: ["en", "lv"] },
    branch: "main",
    role: "developer",
    token: { name: "ci-token", autoPublish: false, expiresAt: null },
};
const LABELS = {
    branch: "main",
    total: 3,
    labels: [
        { key: "app.title", values: { en: "Title", lv: "Nosaukums" }, status: "approved", tags: [], updatedAt: "2026-01-01T00:00:00.000Z" },
        { key: "app.subtitle", values: { en: "Subtitle" }, status: "draft", tags: ["hero"], updatedAt: "2026-01-02T00:00:00.000Z" },
        { key: "common.cancel", values: { en: "Cancel", lv: "Atcelt" }, status: "approved", tags: [], updatedAt: "2026-01-03T00:00:00.000Z" },
    ],
};

// V2: the token is create-own scoped; main + feature-x are writable, release is not.
const BRANCHES = {
    baseBranch: "main",
    branchScope: "create-own",
    branches: [
        { name: "main", description: "", basedOn: null, createdAt: "2026-01-01T00:00:00.000Z", createdByThisToken: false, writable: true },
        { name: "feature-x", description: "Feature X", basedOn: "main", createdAt: "2026-01-05T00:00:00.000Z", createdByThisToken: true, writable: true },
        { name: "release", description: "", basedOn: "main", createdAt: "2026-01-03T00:00:00.000Z", createdByThisToken: false, writable: false },
    ],
};

// V2: a compare of a feature branch (source) against the base (target) — one of each bucket.
const COMPARE = {
    source: "feature-x",
    target: "main",
    differences: {
        changed: [{ key: "app.title", languages: { en: { sourceValue: "New Title", targetValue: "Title" } } }],
        added: [{ key: "app.hero", languages: { en: { sourceValue: "Hero", targetValue: null }, lv: { sourceValue: "Varonis", targetValue: null } } }],
        deleted: [{ key: "app.old", languages: { en: { sourceValue: null, targetValue: "Old" } } }],
    },
    summary: { changed: 1, added: 1, deleted: 1, total: 3 },
};

/** A minimal stand-in for the Translatize integration API implementing the V2 contract. */
function startMock(): Promise<Server> {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
            const path = url.pathname;
            const parsed = body ? JSON.parse(body) : {};
            res.setHeader("content-type", "application/json");
            const compareMatch = path.match(/\/branches\/([^/]+)\/compare$/);
            const conflictsMatch = path.match(/\/branches\/([^/]+)\/conflicts$/);
            const mergeMatch = path.match(/\/branches\/([^/]+)\/merge$/);
            const deleteMatch = path.match(/\/branches\/([^/]+)$/);
            if (req.method === "GET" && path.endsWith("/integrations/me")) {
                res.end(JSON.stringify(ME));
            } else if (req.method === "GET" && compareMatch) {
                res.end(JSON.stringify({ ...COMPARE, source: decodeURIComponent(compareMatch[1]) }));
            } else if (req.method === "GET" && conflictsMatch) {
                res.end(
                    JSON.stringify({
                        source: decodeURIComponent(conflictsMatch[1]),
                        target: "main",
                        conflicts: [],
                        hasConflicts: false,
                        conflictCount: 0,
                    }),
                );
            } else if (req.method === "GET" && path.endsWith("/branches")) {
                res.end(JSON.stringify(BRANCHES));
            } else if (req.method === "POST" && path.endsWith("/branches")) {
                res.end(
                    JSON.stringify({
                        branch: {
                            name: parsed.name,
                            description: parsed.description ?? "",
                            isDefault: false,
                            basedOn: "main",
                            createdBy: "u_ci",
                            createdAt: "2026-02-01T00:00:00.000Z",
                            lastModified: "2026-02-01T00:00:00.000Z",
                            createdByName: "ci-token",
                        },
                    }),
                );
            } else if (req.method === "POST" && mergeMatch) {
                res.end(
                    JSON.stringify({
                        message: "merged",
                        source: decodeURIComponent(mergeMatch[1]),
                        target: "main",
                        strategy: parsed.strategy ?? "overwrite",
                    }),
                );
            } else if (req.method === "DELETE" && deleteMatch) {
                res.end(JSON.stringify({ message: "deleted" }));
            } else if (req.method === "POST" && path.endsWith("/translation/auto-translate")) {
                // The sentinel label key drives a server-side (5xx) failure so the 5xx-generic
                // error mapping can be exercised; otherwise the mock's plan simply does not
                // include platform AI (403 feature_not_available).
                if (Array.isArray(parsed.labelKeys) && parsed.labelKeys.includes("__server_error__")) {
                    res.statusCode = 500;
                    res.end(JSON.stringify({ error: "ai_provider_not_configured" }));
                } else {
                    res.statusCode = 403;
                    res.end(JSON.stringify({ error: "feature_not_available" }));
                }
            } else if (req.method === "GET" && path.endsWith("/translation/status")) {
                res.end(JSON.stringify({ activeJob: null, lastJob: null, aiQuota: { used: 0, limit: 100000, remaining: 100000 } }));
            } else if (req.method === "GET" && path.endsWith("/labels")) {
                res.end(JSON.stringify(LABELS));
            } else if (req.method === "PATCH" && path.endsWith("/labels/batch")) {
                const count = Array.isArray(parsed.labels) ? parsed.labels.length : 0;
                res.end(JSON.stringify({ updated: 0, created: count, failed: [] }));
            } else if (req.method === "PATCH" && path.endsWith("/labels")) {
                res.end(
                    JSON.stringify({
                        key: parsed.key,
                        branch: "main",
                        created: true,
                        values: parsed.values ?? {},
                        status: parsed.status ?? "draft",
                        tags: parsed.tags ?? [],
                    }),
                );
            } else {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "not_found" }));
            }
        });
    });
    return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

interface Pending {
    resolve: (msg: any) => void;
    reject: (err: Error) => void;
}

/** Newline-delimited JSON-RPC driver over the child's stdio (the MCP stdio transport). */
function createRpc(child: ChildProcessWithoutNullStreams) {
    let nextId = 1;
    const pending = new Map<number, Pending>();
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
        const trimmed = line.trim();
        if (trimmed === "") return;
        let msg: any;
        try {
            msg = JSON.parse(trimmed);
        } catch {
            return; // ignore anything that is not a JSON-RPC frame
        }
        if (typeof msg.id === "number" && pending.has(msg.id)) {
            const p = pending.get(msg.id)!;
            pending.delete(msg.id);
            if (msg.error) p.reject(new Error(`RPC error ${msg.error.code}: ${msg.error.message}`));
            else p.resolve(msg);
        }
    });
    child.on("exit", (code, signal) => {
        const err = new Error(`server exited early (code=${code}, signal=${signal})`);
        for (const p of pending.values()) p.reject(err);
        pending.clear();
    });
    // Swallow EPIPE that can arrive on stdin after the child is killed in teardown.
    child.stdin.on("error", () => {});

    return {
        request(method: string, params: unknown = {}): Promise<any> {
            const id = nextId++;
            return new Promise<any>((resolve, reject) => {
                const timer = setTimeout(() => {
                    if (pending.delete(id)) reject(new Error(`timed out waiting for "${method}"`));
                }, 10_000);
                pending.set(id, {
                    resolve: (v) => { clearTimeout(timer); resolve(v); },
                    reject: (e) => { clearTimeout(timer); reject(e); },
                });
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
            });
        },
        notify(method: string, params: unknown = {}): void {
            child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
        },
    };
}

const EXPECTED_TOOLS = [
    "auto_translate",
    "compare_with_base",
    "create_branch",
    "delete_branch",
    "get_labels",
    "get_merge_conflicts",
    "get_missing_translations",
    "get_project_info",
    "list_branches",
    "list_labels",
    "merge_branch",
    "review_changes",
    "search_labels",
    "set_labels_status",
    "translation_job_status",
    "translation_status",
    "upsert_label",
    "upsert_labels",
];

// The human title and behavioral annotation each tool must advertise in tools/list.
// readOnly ⇒ annotations.readOnlyHint === true (destructiveHint omitted — it is only
// meaningful when readOnlyHint is false). Otherwise readOnlyHint === false and
// destructiveHint is asserted explicitly (true only for delete_branch / merge_branch).
const EXPECTED_ANNOTATIONS: Record<string, { title: string; readOnly: boolean; destructive: boolean }> = {
    get_project_info: { title: "Get Project Info", readOnly: true, destructive: false },
    list_labels: { title: "List Labels", readOnly: true, destructive: false },
    get_labels: { title: "Get Labels", readOnly: true, destructive: false },
    search_labels: { title: "Search Labels", readOnly: true, destructive: false },
    translation_status: { title: "Translation Coverage", readOnly: true, destructive: false },
    list_branches: { title: "List Branches", readOnly: true, destructive: false },
    compare_with_base: { title: "Compare Branch With Base", readOnly: true, destructive: false },
    get_merge_conflicts: { title: "Get Merge Conflicts", readOnly: true, destructive: false },
    get_missing_translations: { title: "Find Missing Translations", readOnly: true, destructive: false },
    translation_job_status: { title: "AI Translation Job Status", readOnly: true, destructive: false },
    review_changes: { title: "Review Branch Changes", readOnly: true, destructive: false },
    upsert_label: { title: "Create or Update Label", readOnly: false, destructive: false },
    upsert_labels: { title: "Create or Update Labels (Batch)", readOnly: false, destructive: false },
    set_labels_status: { title: "Set Labels Status", readOnly: false, destructive: false },
    create_branch: { title: "Create Branch", readOnly: false, destructive: false },
    auto_translate: { title: "Auto-Translate (Platform AI)", readOnly: false, destructive: false },
    merge_branch: { title: "Merge Branch Into Base", readOnly: false, destructive: true },
    delete_branch: { title: "Delete Branch", readOnly: false, destructive: true },
};

describe("translatize-mcp stdio server", () => {
    let mock: Server;
    let child: ChildProcessWithoutNullStreams;
    let rpc: ReturnType<typeof createRpc>;
    let initResult: any;
    let stderr = "";

    before(async () => {
        mock = await startMock();
        const { port } = mock.address() as AddressInfo;
        child = spawn(process.execPath, [SERVER_PATH], {
            env: {
                ...process.env,
                TRANSLATIZE_API_TOKEN: "mcni_test",
                TRANSLATIZE_API_URL: `http://127.0.0.1:${port}/v1`,
            },
            stdio: ["pipe", "pipe", "pipe"],
        });
        child.stderr.on("data", (d) => (stderr += d.toString()));
        rpc = createRpc(child);

        initResult = await rpc.request("initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "server.test", version: "0.0.0" },
        });
        rpc.notify("notifications/initialized");
    });

    after(async () => {
        if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
        }
        if (mock) {
            await new Promise<void>((resolve) => mock.close(() => resolve()));
        }
    });

    it("initialize reports the server identity", () => {
        assert.equal(initResult.result.serverInfo.name, "translatize");
        assert.equal(initResult.result.serverInfo.version, "0.1.0");
        assert.equal(stderr, "", `server should be silent on stderr, got: ${stderr}`);
    });

    it("tools/list advertises exactly the eighteen Translatize tools", async () => {
        const res = await rpc.request("tools/list", {});
        const names = (res.result.tools as Array<{ name: string; inputSchema: unknown }>).map((t) => t.name).sort();
        assert.deepEqual(names, EXPECTED_TOOLS);
        for (const tool of res.result.tools) {
            assert.equal((tool.inputSchema as { type?: string }).type, "object", `${tool.name} exposes an object input schema`);
            assert.ok(typeof tool.description === "string" && tool.description.length > 0, `${tool.name} has a description`);
        }
    });

    it("tools/list carries human titles and correct MCP annotations (readOnly / destructive hints)", async () => {
        const res = await rpc.request("tools/list", {});
        const tools = res.result.tools as Array<{
            name: string;
            title?: string;
            annotations?: { title?: string; readOnlyHint?: boolean; destructiveHint?: boolean };
        }>;
        assert.equal(tools.length, EXPECTED_TOOLS.length);

        let readOnlyCount = 0;
        let destructiveCount = 0;
        for (const tool of tools) {
            const expected = EXPECTED_ANNOTATIONS[tool.name];
            assert.ok(expected, `${tool.name} is a known tool`);

            // Human title surfaces at BOTH the top level (MCP 2025-06-18+) and in annotations
            // (older clients), so it displays across every client.
            assert.equal(tool.title, expected.title, `${tool.name} top-level title`);
            assert.ok(tool.annotations, `${tool.name} has an annotations block`);
            assert.equal(tool.annotations!.title, expected.title, `${tool.name} annotations.title mirrors the title`);

            // Behavioral hints.
            assert.equal(tool.annotations!.readOnlyHint, expected.readOnly, `${tool.name} readOnlyHint`);
            if (expected.readOnly) {
                readOnlyCount++;
                assert.equal(
                    tool.annotations!.destructiveHint,
                    undefined,
                    `${tool.name} omits destructiveHint (meaningless when read-only)`,
                );
            } else {
                assert.equal(tool.annotations!.destructiveHint, expected.destructive, `${tool.name} destructiveHint`);
                if (expected.destructive) destructiveCount++;
            }
        }
        // Exactly the split the Anthropic directory review expects.
        assert.equal(readOnlyCount, 11, "eleven read-only tools");
        assert.equal(destructiveCount, 2, "two destructive tools (merge_branch, delete_branch)");
    });

    it("tools/call get_project_info returns the formatted project overview", async () => {
        const res = await rpc.request("tools/call", { name: "get_project_info", arguments: {} });
        assert.ok(!res.result.isError, "result is not an error");
        assert.equal(res.result.content[0].type, "text");

        const info = JSON.parse(res.result.content[0].text);
        assert.equal(info.project.id, "proj_abc");
        assert.equal(info.project.name, "Demo Shop");
        assert.deepEqual(info.project.languages, ["en", "lv"]);
        assert.equal(info.branch, "main");
        assert.equal(info.role, "developer");
        assert.equal(info.branchScope, "create-own");
        assert.deepEqual(info.writableBranches, ["main", "feature-x"]);
        assert.equal(info.token.name, "ci-token");
        assert.equal(info.totalKeys, 3);

        const byLang: Record<string, any> = Object.fromEntries((info.languages as any[]).map((l: any) => [l.lang, l]));
        assert.equal(byLang.en.translated, 3);
        assert.equal(byLang.en.percent, 100);
        assert.equal(byLang.lv.translated, 2);
        assert.equal(byLang.lv.percent, 67); // 2/3 rounded
    });

    it("tools/call translation_status samples the missing keys per language", async () => {
        const res = await rpc.request("tools/call", { name: "translation_status", arguments: {} });
        assert.ok(!res.result.isError, "result is not an error");

        const status = JSON.parse(res.result.content[0].text);
        assert.equal(status.branch, "main");
        assert.equal(status.totalKeys, 3);
        const byLang: Record<string, any> = Object.fromEntries((status.languages as any[]).map((l: any) => [l.lang, l]));
        assert.equal(byLang.en.missing, 0);
        assert.deepEqual(byLang.en.missingKeys, []);
        assert.equal(byLang.lv.missing, 1);
        assert.deepEqual(byLang.lv.missingKeys, ["app.subtitle"]);
    });

    it("list_labels omits values by default and includes them on request", async () => {
        const bare = await rpc.request("tools/call", { name: "list_labels", arguments: {} });
        const bareOut = JSON.parse(bare.result.content[0].text);
        assert.equal(bareOut.total, 3);
        assert.equal(bareOut.count, 3);
        assert.equal(bareOut.labels[0].values, undefined);
        assert.ok(typeof bareOut.labels[0].key === "string");

        const full = await rpc.request("tools/call", { name: "list_labels", arguments: { include_values: true } });
        const fullOut = JSON.parse(full.result.content[0].text);
        const title = (fullOut.labels as any[]).find((l: any) => l.key === "app.title");
        assert.deepEqual(title.values, { en: "Title", lv: "Nosaukums" });
    });

    it("get_labels separates found keys from not_found", async () => {
        const res = await rpc.request("tools/call", {
            name: "get_labels",
            arguments: { keys: ["app.title", "does.not.exist"] },
        });
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.labels.length, 1);
        assert.equal(out.labels[0].key, "app.title");
        assert.deepEqual(out.labels[0].values, { en: "Title", lv: "Nosaukums" });
        assert.deepEqual(out.not_found, ["does.not.exist"]);
    });

    it("search_labels matches by value substring, case-insensitively", async () => {
        const res = await rpc.request("tools/call", { name: "search_labels", arguments: { query: "ATCELT" } });
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.total_matches, 1);
        assert.equal(out.count, 1);
        assert.equal(out.labels[0].key, "common.cancel");
    });

    it("upsert_label reports the created label and echoes its state", async () => {
        const res = await rpc.request("tools/call", {
            name: "upsert_label",
            arguments: { key: "app.new", values: { en: "New" }, status: "draft" },
        });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.action, "created");
        assert.equal(out.key, "app.new");
        assert.equal(out.branch, "main");
        assert.deepEqual(out.values, { en: "New" });
    });

    it("upsert_labels returns aggregated batch counts", async () => {
        const res = await rpc.request("tools/call", {
            name: "upsert_labels",
            arguments: {
                labels: [
                    { key: "a", values: { en: "A" } },
                    { key: "b", values: { en: "B" } },
                ],
            },
        });
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.created, 2);
        assert.equal(out.updated, 0);
        assert.deepEqual(out.failed, []);
    });

    it("list_branches surfaces the base branch, scope and per-branch flags", async () => {
        const res = await rpc.request("tools/call", { name: "list_branches", arguments: {} });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.baseBranch, "main");
        assert.equal(out.branchScope, "create-own");
        const byName: Record<string, any> = Object.fromEntries((out.branches as any[]).map((b: any) => [b.name, b]));
        assert.equal(byName["feature-x"].createdByThisToken, true);
        assert.equal(byName["feature-x"].writable, true);
        assert.equal(byName["release"].writable, false);
    });

    it("create_branch forwards the name and echoes the created branch", async () => {
        const res = await rpc.request("tools/call", {
            name: "create_branch",
            arguments: { name: "feature-y", description: "New feature" },
        });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.created, true);
        assert.equal(out.branch.name, "feature-y");
        assert.equal(out.branch.basedOn, "main");
        assert.equal(out.branch.description, "New feature");
    });

    it("get_missing_translations reports keys with untranslated target values", async () => {
        const res = await rpc.request("tools/call", { name: "get_missing_translations", arguments: {} });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.sourceLang, "en");
        assert.deepEqual(out.targetLanguages, ["lv"]);
        assert.equal(out.total, 1);
        assert.equal(out.count, 1);
        assert.equal(out.missing[0].key, "app.subtitle");
        assert.deepEqual(out.missing[0].source, { lang: "en", value: "Subtitle" });
        assert.deepEqual(out.missing[0].missing, ["lv"]);
    });

    it("review_changes formats a review packet with a platform URL", async () => {
        const res = await rpc.request("tools/call", { name: "review_changes", arguments: { branch: "feature-x" } });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.branch, "feature-x");
        assert.equal(out.base, "main");
        assert.equal(out.summary.total, 3);
        assert.equal(out.platformUrl, "https://app.translatize.com/app/projects/proj_abc/branches");
        assert.ok(typeof out.reviewPrompt === "string" && out.reviewPrompt.length > 0);

        const byKey: Record<string, any> = Object.fromEntries((out.changes as any[]).map((c: any) => [c.key, c]));
        assert.equal(byKey["app.hero"].change, "added");
        assert.deepEqual(byKey["app.hero"].values, { en: "Hero", lv: "Varonis" });
        assert.equal(byKey["app.title"].change, "changed");
        assert.equal(byKey["app.title"].values.en, "New Title");
        assert.equal(byKey["app.title"].previousValues.en, "Title");
        assert.deepEqual(out.deletedKeys, ["app.old"]);
    });

    it("auto_translate maps feature_not_available to actionable guidance", async () => {
        const res = await rpc.request("tools/call", {
            name: "auto_translate",
            arguments: { target_languages: ["lv"] },
        });
        assert.equal(res.result.isError, true, "feature_not_available should surface as a tool error");
        const text = res.result.content[0].text as string;
        assert.match(text, /\[feature_not_available\]/);
        assert.match(text, /get_missing_translations/);
    });

    it("auto_translate hides internal server detail when the API returns a 5xx error", async () => {
        const res = await rpc.request("tools/call", {
            name: "auto_translate",
            arguments: { target_languages: ["lv"], label_keys: ["__server_error__"] },
        });
        assert.equal(res.result.isError, true, "a 5xx server failure should surface as a tool error");
        const text = res.result.content[0].text as string;
        // Internal server configuration state must never reach the external client.
        assert.doesNotMatch(text, /provider/i);
        assert.doesNotMatch(text, /ai_provider_not_configured/);
        // The message is still generic and actionable.
        assert.match(text, /server-side error/);
        assert.match(text, /get_missing_translations/);
    });

    it("translation_job_status returns the job state and the AI quota", async () => {
        const res = await rpc.request("tools/call", { name: "translation_job_status", arguments: {} });
        assert.ok(!res.result.isError, "result is not an error");
        const out = JSON.parse(res.result.content[0].text);
        assert.equal(out.activeJob, null);
        assert.equal(out.lastJob, null);
        assert.deepEqual(out.aiQuota, { used: 0, limit: 100000, remaining: 100000 });
    });
});
