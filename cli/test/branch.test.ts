import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TranslatizeApiError } from "@translatize/core";
import { statusCommand } from "../src/commands/status.js";
import { pushCommand } from "../src/commands/push.js";
import { describeApiError } from "../src/ui.js";

// --- Minimal fetch mock (a stand-in server) that records every outgoing call. ---

interface Rec {
    url: string;
    method: string;
    body: string | undefined;
}

interface Spec {
    status?: number;
    json?: unknown;
    text?: string;
}

const ORIGINAL_FETCH = globalThis.fetch;

function installFetch(handler: (rec: Rec) => Spec): Rec[] {
    const calls: Rec[] = [];
    const mock = async (input: unknown, init: Record<string, unknown> = {}): Promise<unknown> => {
        const url = typeof input === "string" ? input : String((input as { url?: string }).url ?? input);
        const method = String((init.method as string | undefined) ?? "GET").toUpperCase();
        const rec: Rec = { url, method, body: init.body as string | undefined };
        calls.push(rec);
        const spec = handler(rec);
        const status = spec.status ?? 200;
        const text = spec.text !== undefined ? spec.text : JSON.stringify(spec.json ?? {});
        return {
            ok: status >= 200 && status < 300,
            status,
            statusText: "",
            json: async () => (spec.json !== undefined ? spec.json : JSON.parse(text)),
            text: async () => text,
        };
    };
    globalThis.fetch = mock as unknown as typeof globalThis.fetch;
    return calls;
}

afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
});

const ME = {
    project: { id: "proj123", name: "Demo", langs: ["en", "lv"] },
    branch: "main",
    role: "developer",
    token: { name: "ci", autoPublish: false, expiresAt: null },
};

// Answer /me, the labels list, and the batch upsert. `listBranch` is echoed back on
// the list response so command output stays coherent.
function routes(listBranch: string): (rec: Rec) => Spec {
    return (rec) => {
        if (rec.url.endsWith("/integrations/me")) return { json: ME };
        if (rec.url.includes("/labels/batch")) return { json: { updated: 0, created: 1, failed: [] } };
        if (rec.url.includes("/labels")) return { json: { branch: listBranch, total: 0, labels: [] } };
        return { json: {} };
    };
}

// Silence the command's stdout writes (info/printJson) for the duration of a call.
function withSilencedStdout<T>(fn: () => Promise<T>): Promise<T> {
    const orig = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    return fn().finally(() => {
        process.stdout.write = orig;
    });
}

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "tz-cli-branch-"));
}

function writeConfig(dir: string, extra: Record<string, unknown> = {}): string {
    const p = join(dir, "translatize.config.json");
    writeFileSync(
        p,
        JSON.stringify({
            apiUrl: "https://api.example.com/v1",
            projectId: "proj123",
            format: "json-flat",
            files: "locales/{lang}.json",
            ...extra,
        }),
    );
    return p;
}

function labelsCall(calls: Rec[]): Rec | undefined {
    return calls.find((c) => c.method === "GET" && c.url.includes("/labels") && !c.url.includes("/batch"));
}

test("status: --branch flag flows through to the labels request query", async () => {
    const dir = tmp();
    try {
        const configPath = writeConfig(dir);
        const calls = installFetch(routes("feature-x"));
        await withSilencedStdout(() => statusCommand({ config: configPath, token: "mcni_x", branch: "feature-x", json: true }));
        const labels = labelsCall(calls);
        assert.ok(labels, "a labels request was made");
        assert.match(labels.url, /[?&]branch=feature-x/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("status: config \"branch\" field flows through when no flag is passed", async () => {
    const dir = tmp();
    try {
        const configPath = writeConfig(dir, { branch: "cfg-branch" });
        const calls = installFetch(routes("cfg-branch"));
        await withSilencedStdout(() => statusCommand({ config: configPath, token: "mcni_x", json: true }));
        const labels = labelsCall(calls);
        assert.ok(labels, "a labels request was made");
        assert.match(labels.url, /[?&]branch=cfg-branch/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("status: --branch flag overrides the config \"branch\" field", async () => {
    const dir = tmp();
    try {
        const configPath = writeConfig(dir, { branch: "cfg-branch" });
        const calls = installFetch(routes("flag-branch"));
        await withSilencedStdout(() => statusCommand({ config: configPath, token: "mcni_x", branch: "flag-branch", json: true }));
        const labels = labelsCall(calls);
        assert.ok(labels, "a labels request was made");
        assert.match(labels.url, /[?&]branch=flag-branch/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("status: no branch (flag or config) omits the branch query param", async () => {
    const dir = tmp();
    try {
        const configPath = writeConfig(dir);
        const calls = installFetch(routes("main"));
        await withSilencedStdout(() => statusCommand({ config: configPath, token: "mcni_x", json: true }));
        const labels = labelsCall(calls);
        assert.ok(labels, "a labels request was made");
        assert.equal(/[?&]branch=/.test(labels.url), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("push: --branch flag flows through to the batch upsert body", async () => {
    const dir = tmp();
    try {
        const configPath = writeConfig(dir);
        mkdirSync(join(dir, "locales"), { recursive: true });
        writeFileSync(join(dir, "locales/en.json"), JSON.stringify({ "app.title": "Hi" }));
        writeFileSync(join(dir, "locales/lv.json"), JSON.stringify({ "app.title": "Sveiki" }));
        const calls = installFetch(routes("feature-x"));
        await withSilencedStdout(() => pushCommand({ config: configPath, token: "mcni_x", branch: "feature-x", json: true }));
        const batch = calls.find((c) => c.method === "PATCH" && c.url.includes("/labels/batch"));
        assert.ok(batch, "a batch upsert request was made");
        const body = JSON.parse(batch.body as string) as { branch?: string; labels?: unknown[] };
        assert.equal(body.branch, "feature-x");
        assert.ok(Array.isArray(body.labels) && body.labels.length > 0);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("describeApiError: branch_not_allowed lists the token's allowed branches and suggests --branch", () => {
    const err = new TranslatizeApiError("nope", 400, "branch_not_allowed", {
        error: "branch_not_allowed",
        boundBranch: "main",
        allowedBranches: ["main", "feature-x"],
    });
    const msg = describeApiError(err);
    assert.match(msg, /main/);
    assert.match(msg, /feature-x/);
    assert.match(msg, /--branch/);
    assert.match(msg, /\(branch_not_allowed\)$/);
});

test("describeApiError: branch_not_allowed falls back to boundBranch when allowedBranches is absent", () => {
    const err = new TranslatizeApiError("nope", 400, "branch_not_allowed", {
        error: "branch_not_allowed",
        boundBranch: "main",
    });
    const msg = describeApiError(err);
    assert.match(msg, /main/);
    assert.match(msg, /--branch/);
});
