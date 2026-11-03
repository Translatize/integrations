import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initCommand } from "../src/commands/init.js";

function tmp(): string {
    return mkdtempSync(join(tmpdir(), "tz-cli-init-"));
}

// initCommand() writes progress lines with info() (process.stdout.write); silence
// them for the duration of a test so `npm test` output stays about assertions.
// It also calls the real API when a token is available (--token or
// TRANSLATIZE_API_TOKEN) to enrich the config – none of these tests pass a
// token, so also hide any token left in the environment, to keep the test
// offline regardless of the shell it runs in.
async function withQuietStdout<T>(fn: () => Promise<T>): Promise<T> {
    const originalWrite = process.stdout.write.bind(process.stdout);
    const hadToken = "TRANSLATIZE_API_TOKEN" in process.env;
    const originalToken = process.env.TRANSLATIZE_API_TOKEN;
    process.stdout.write = (() => true) as typeof process.stdout.write;
    delete process.env.TRANSLATIZE_API_TOKEN;
    try {
        return await fn();
    } finally {
        process.stdout.write = originalWrite;
        if (hadToken) process.env.TRANSLATIZE_API_TOKEN = originalToken;
    }
}

test("initCommand --force preserves unknown top-level keys (e.g. the GitHub App's block)", async () => {
    const dir = tmp();
    try {
        const configPath = join(dir, "translatize.config.json");
        const github = { sourceLanguage: "en", autoTranslate: true, commitTranslations: "on-request" };
        writeFileSync(
            configPath,
            JSON.stringify(
                {
                    apiUrl: "https://api.example.com/v1",
                    projectId: "old-project",
                    format: "json-nested",
                    files: "locales/{lang}.json",
                    github,
                },
                null,
                2,
            ) + "\n",
        );

        const code = await withQuietStdout(() =>
            initCommand({
                config: configPath,
                force: true,
                projectId: "new-project",
                format: "json-flat",
                files: "i18n/{lang}.json",
            }),
        );

        assert.equal(code, 0);
        const rewritten = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(rewritten.projectId, "new-project");
        assert.equal(rewritten.format, "json-flat");
        assert.deepEqual(rewritten.github, github, "the github block must survive the --force rewrite");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("initCommand --force on a config with no unknown keys writes a plain config (no extra noise)", async () => {
    const dir = tmp();
    try {
        const configPath = join(dir, "translatize.config.json");
        writeFileSync(
            configPath,
            JSON.stringify({ apiUrl: "https://api.example.com/v1", projectId: "p1", format: "json-nested", files: "locales/{lang}.json" }, null, 2) + "\n",
        );

        await withQuietStdout(() => initCommand({ config: configPath, force: true, format: "json-flat", files: "i18n/{lang}.json" }));

        const rewritten = JSON.parse(readFileSync(configPath, "utf8"));
        assert.deepEqual(Object.keys(rewritten), ["apiUrl", "projectId", "format", "files"]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("initCommand without --force on a missing file writes a fresh config", async () => {
    const dir = tmp();
    try {
        const configPath = join(dir, "translatize.config.json");
        const code = await withQuietStdout(() => initCommand({ config: configPath, format: "json-flat", files: "i18n/{lang}.json" }));
        assert.equal(code, 0);
        const written = JSON.parse(readFileSync(configPath, "utf8"));
        assert.equal(written.format, "json-flat");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
