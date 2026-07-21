import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    ConfigError,
    UsageError,
    DEFAULT_API_URL,
    loadConfig,
    resolveApiUrl,
    resolveBranch,
    resolveToken,
    serializeConfig,
    validateConfig,
} from "../src/config.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "tz-cli-cfg-"));
}

test("validateConfig: accepts a full config and trims strings", () => {
    const cfg = validateConfig({
        apiUrl: " https://api.example.com/v1 ",
        projectId: " proj123 ",
        format: "json-flat",
        files: "i18n/{lang}.json",
        namespace: " app ",
        branch: " feature-x ",
    });
    assert.deepEqual(cfg, {
        apiUrl: "https://api.example.com/v1",
        projectId: "proj123",
        format: "json-flat",
        files: "i18n/{lang}.json",
        namespace: "app",
        branch: "feature-x",
    });
});

test("validateConfig: defaults apiUrl and leaves namespace + branch undefined", () => {
    const cfg = validateConfig({ format: "json-nested", files: "locales/{lang}.json" });
    assert.equal(cfg.apiUrl, DEFAULT_API_URL);
    assert.equal(cfg.projectId, "");
    assert.equal(cfg.namespace, undefined);
    assert.equal(cfg.branch, undefined);
});

test("validateConfig: blank branch is treated as absent; a non-string branch throws", () => {
    assert.equal(validateConfig({ format: "json-flat", files: "{lang}.json", branch: "   " }).branch, undefined);
    assert.throws(() => validateConfig({ format: "json-flat", files: "{lang}.json", branch: 5 }), /"branch"/);
});

test("validateConfig: blank namespace is treated as absent", () => {
    const cfg = validateConfig({ format: "json-flat", files: "{lang}.json", namespace: "   " });
    assert.equal(cfg.namespace, undefined);
});

test("validateConfig: rejects a non-object root", () => {
    assert.throws(() => validateConfig(null), ConfigError);
    assert.throws(() => validateConfig([1, 2]), /expected a JSON object/);
    assert.throws(() => validateConfig("nope"), ConfigError);
});

test("validateConfig: format is required and constrained", () => {
    assert.throws(() => validateConfig({ files: "{lang}.json" }), /"format" is required/);
    assert.throws(() => validateConfig({ files: "{lang}.json", format: "yaml" }), /"format" must be/);
});

test("validateConfig: files is required and must contain {lang}", () => {
    assert.throws(() => validateConfig({ format: "json-flat" }), /"files" is required/);
    assert.throws(() => validateConfig({ format: "json-flat", files: "" }), /non-empty string/);
    assert.throws(() => validateConfig({ format: "json-flat", files: "locales/en.json" }), /\{lang\} placeholder/);
});

test("validateConfig: type errors for apiUrl / projectId / namespace", () => {
    assert.throws(() => validateConfig({ format: "json-flat", files: "{lang}.json", apiUrl: 5 }), /"apiUrl"/);
    assert.throws(() => validateConfig({ format: "json-flat", files: "{lang}.json", apiUrl: "" }), /"apiUrl"/);
    assert.throws(() => validateConfig({ format: "json-flat", files: "{lang}.json", projectId: 5 }), /"projectId"/);
    assert.throws(() => validateConfig({ format: "json-flat", files: "{lang}.json", namespace: 5 }), /"namespace"/);
});

test("validateConfig: error messages carry the source label", () => {
    assert.throws(() => validateConfig({}, "my.json"), /^.*my\.json:/);
});

test("serializeConfig: stable key order, omits absent namespace, trailing newline", () => {
    const text = serializeConfig({ apiUrl: "u", projectId: "p", format: "json-nested", files: "{lang}.json" });
    assert.equal(text, '{\n  "apiUrl": "u",\n  "projectId": "p",\n  "format": "json-nested",\n  "files": "{lang}.json"\n}\n');
    const withNs = serializeConfig({ apiUrl: "u", projectId: "p", format: "json-flat", files: "{lang}.json", namespace: "app" });
    assert.match(withNs, /"namespace": "app"/);
});

test("serializeConfig: includes branch after namespace, omits it when absent", () => {
    const withBranch = serializeConfig({ apiUrl: "u", projectId: "p", format: "json-flat", files: "{lang}.json", namespace: "app", branch: "feature-x" });
    assert.equal(
        withBranch,
        '{\n  "apiUrl": "u",\n  "projectId": "p",\n  "format": "json-flat",\n  "files": "{lang}.json",\n  "namespace": "app",\n  "branch": "feature-x"\n}\n',
    );
    const noBranch = serializeConfig({ apiUrl: "u", projectId: "p", format: "json-flat", files: "{lang}.json" });
    assert.equal(noBranch.includes("branch"), false);
});

test("loadConfig: round-trips a written config", () => {
    const dir = tmp();
    try {
        const p = join(dir, "translatize.config.json");
        writeFileSync(p, serializeConfig({ apiUrl: "https://x/v1", projectId: "p1", format: "json-flat", files: "l/{lang}.json" }));
        const cfg = loadConfig(p);
        assert.equal(cfg.projectId, "p1");
        assert.equal(cfg.format, "json-flat");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("loadConfig: missing file and invalid JSON both raise ConfigError", () => {
    const dir = tmp();
    try {
        assert.throws(() => loadConfig(join(dir, "nope.json")), /Config file not found/);
        const bad = join(dir, "bad.json");
        writeFileSync(bad, "{ not json");
        assert.throws(() => loadConfig(bad), /not valid JSON/);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("resolveToken: flag beats env, env is the fallback, absence throws UsageError naming both", () => {
    assert.equal(resolveToken("mcni_flag", { TRANSLATIZE_API_TOKEN: "mcni_env" }), "mcni_flag");
    assert.equal(resolveToken(undefined, { TRANSLATIZE_API_TOKEN: "mcni_env" }), "mcni_env");
    assert.equal(resolveToken("  mcni_trim  ", {}), "mcni_trim");
    assert.throws(
        () => resolveToken(undefined, {}),
        (err: unknown) => {
            assert.ok(err instanceof UsageError);
            assert.match((err as Error).message, /--token/);
            assert.match((err as Error).message, /TRANSLATIZE_API_TOKEN/);
            return true;
        },
    );
});

test("resolveApiUrl: flag beats config beats default", () => {
    assert.equal(resolveApiUrl({ apiUrl: "https://cfg/v1" }, "https://flag/v1"), "https://flag/v1");
    assert.equal(resolveApiUrl({ apiUrl: "https://cfg/v1" }, undefined), "https://cfg/v1");
    assert.equal(resolveApiUrl({ apiUrl: "" }, "  "), DEFAULT_API_URL);
});

test("resolveBranch: flag beats config field beats undefined (token default), trimming both", () => {
    assert.equal(resolveBranch({ branch: "cfg-branch" }, "flag-branch"), "flag-branch");
    assert.equal(resolveBranch({ branch: "cfg-branch" }, "  spaced  "), "spaced");
    assert.equal(resolveBranch({ branch: "cfg-branch" }, undefined), "cfg-branch");
    assert.equal(resolveBranch({ branch: "  cfg-branch  " }, "   "), "cfg-branch");
    assert.equal(resolveBranch({ branch: undefined }, undefined), undefined);
    assert.equal(resolveBranch({}, ""), undefined);
});
