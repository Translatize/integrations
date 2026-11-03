import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AGENTS_END, AGENTS_START, agentsSection, upsertMarkedSection, writeAgentFiles } from "../src/agents.js";
import { UsageError } from "../src/config.js";

const SECTION = `${AGENTS_START}\nnew rules\n${AGENTS_END}`;

test("agentsSection: carries the markers and the FR-4.4 rules", () => {
    const text = agentsSection();
    assert.ok(text.startsWith(AGENTS_START));
    assert.ok(text.endsWith(AGENTS_END));
    assert.match(text, /Never hardcode user-visible strings/);
    assert.match(text, /description/);
    assert.match(text, /charLimit/);
    assert.match(text, /dotted key names/);
    assert.match(text, /branch/);
    assert.doesNotMatch(text, /\u2014/, "no em dash");
});

test("upsertMarkedSection: a missing file is created with just the section", () => {
    assert.deepEqual(upsertMarkedSection(null, SECTION), { content: `${SECTION}\n`, action: "created" });
});

test("upsertMarkedSection: appends after existing text with one blank line", () => {
    assert.equal(upsertMarkedSection("# Agents\n", SECTION).content, `# Agents\n\n${SECTION}\n`);
    assert.equal(upsertMarkedSection("# Agents", SECTION).content, `# Agents\n\n${SECTION}\n`);
    assert.equal(upsertMarkedSection("# Agents\n\n", SECTION).content, `# Agents\n\n${SECTION}\n`);
    assert.equal(upsertMarkedSection("# Agents\n", SECTION).action, "appended");
});

test("upsertMarkedSection: replaces only the marked part and is idempotent", () => {
    const before = `# Agents\n\n${AGENTS_START}\nold rules\n${AGENTS_END}\n\n## Other\nkeep me\n`;
    const once = upsertMarkedSection(before, SECTION);
    assert.equal(once.action, "updated");
    assert.equal(once.content, `# Agents\n\n${SECTION}\n\n## Other\nkeep me\n`);
    const twice = upsertMarkedSection(once.content, SECTION);
    assert.equal(twice.action, "unchanged");
    assert.equal(twice.content, once.content);
});

test("upsertMarkedSection: broken markers are a usage error", () => {
    assert.throws(() => upsertMarkedSection(`${AGENTS_START}\nno end`, SECTION, "AGENTS.md"), UsageError);
    assert.throws(() => upsertMarkedSection(`${AGENTS_END}\n${AGENTS_START}`, SECTION), /broken/);
    assert.throws(() => upsertMarkedSection(`${AGENTS_START}${AGENTS_END}${AGENTS_START}${AGENTS_END}`, SECTION), /exactly one/);
});

test("writeAgentFiles: creates AGENTS.md, leaves a missing CLAUDE.md alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "tz-cli-agents-"));
    try {
        const results = writeAgentFiles(dir);
        assert.deepEqual(results, [{ file: "AGENTS.md", action: "created" }]);
        assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").includes(AGENTS_START));
        assert.equal(existsSync(join(dir, "CLAUDE.md")), false);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test("writeAgentFiles: updates an existing CLAUDE.md too, and a re-run changes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "tz-cli-agents-"));
    try {
        writeFileSync(join(dir, "CLAUDE.md"), "# Project\n\nBuild with npm.\n");
        assert.deepEqual(writeAgentFiles(dir), [
            { file: "AGENTS.md", action: "created" },
            { file: "CLAUDE.md", action: "appended" },
        ]);
        const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
        assert.ok(claude.startsWith("# Project\n\nBuild with npm.\n\n"));
        assert.ok(claude.includes(AGENTS_END));
        assert.deepEqual(writeAgentFiles(dir), [
            { file: "AGENTS.md", action: "unchanged" },
            { file: "CLAUDE.md", action: "unchanged" },
        ]);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});
