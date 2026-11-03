import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslatizeApiError, type MergeGate, type QaIssue, type QaRunResult } from "@translatize/core";
import { describeIssue, failsThreshold, parseFailOn, runQaCheck, type QaClient } from "../src/commands/qa.js";
import { UsageError } from "../src/config.js";

function issue(overrides: Partial<QaIssue> = {}): QaIssue {
    return {
        id: "i1",
        branch: "feature",
        key: "app.count",
        lang: "lv",
        checkId: "placeholders",
        severity: "error",
        code: "placeholder_missing",
        params: { missing: ["{count}"] },
        source: "rule",
        ignored: false,
        createdAt: "2026-10-27T00:00:00.000Z",
        ...overrides,
    };
}

const PASSING_GATE: MergeGate = { mode: "warn", applies: true, blocked: false, errors: 0, warnings: 0, pairsChecked: 2, issues: [] };

// A fake client that records its calls and answers from the given fixtures.
function fakeClient(opts: { run: QaRunResult; gate?: MergeGate | Error; stored?: QaIssue[] }) {
    const calls: string[] = [];
    const client: QaClient = {
        async runQa(args = {}) {
            calls.push(`runQa:${args.branch ?? "-"}`);
            return opts.run;
        },
        async listQaIssues(args = {}) {
            calls.push(`listQaIssues:${args.branch ?? "-"}:${args.limit ?? "-"}`);
            const issues = opts.stored ?? [];
            return {
                issues,
                nextCursor: null,
                counts: {
                    error: issues.filter((i) => i.severity === "error").length,
                    warning: issues.filter((i) => i.severity === "warning").length,
                    info: issues.filter((i) => i.severity === "info").length,
                },
            };
        },
        async getMergeGate(branch) {
            calls.push(`getMergeGate:${branch}`);
            if (opts.gate instanceof Error) throw opts.gate;
            return { target: "main", gate: opts.gate ?? PASSING_GATE };
        },
    };
    return { client, calls };
}

test("parseFailOn: defaults to error, accepts warning, rejects anything else", () => {
    assert.equal(parseFailOn(undefined), "error");
    assert.equal(parseFailOn(" Warning "), "warning");
    assert.throws(() => parseFailOn("info"), UsageError);
    assert.throws(() => parseFailOn("none"), /--fail-on/);
});

test("failsThreshold: error fails only on errors, warning also on warnings, info never", () => {
    assert.equal(failsThreshold({ error: 0, warning: 3, info: 9 }, "error"), false);
    assert.equal(failsThreshold({ error: 1, warning: 0, info: 0 }, "error"), true);
    assert.equal(failsThreshold({ error: 0, warning: 1, info: 0 }, "warning"), true);
    assert.equal(failsThreshold({ error: 0, warning: 0, info: 5 }, "warning"), false);
});

test("runQaCheck: base branch – no gate read; warnings pass with --fail-on error", async () => {
    const { client, calls } = fakeClient({
        run: { branch: "main", pairsChecked: 10, counts: { error: 0, warning: 2, info: 1 }, issues: [issue({ severity: "warning" })] },
    });
    const report = await runQaCheck(client, { baseBranch: "main", failOn: "error" });
    assert.deepEqual(calls, ["runQa:-"]);
    assert.equal(report.gate, null);
    assert.equal(report.failed, false);
    assert.equal(report.pairsChecked, 10);
});

test("runQaCheck: --fail-on warning fails on warnings", async () => {
    const { client } = fakeClient({
        run: { branch: "main", pairsChecked: 10, counts: { error: 0, warning: 2, info: 0 }, issues: [] },
    });
    const report = await runQaCheck(client, { baseBranch: "main", failOn: "warning" });
    assert.equal(report.failedOnIssues, true);
    assert.equal(report.failed, true);
});

test("runQaCheck: another branch reads the gate into the base; a blocked gate fails even with no counted errors", async () => {
    const blocked: MergeGate = { mode: "block", applies: true, blocked: true, errors: 1, warnings: 0, pairsChecked: 1, issues: [issue()] };
    const { client, calls } = fakeClient({
        run: { branch: "feature", pairsChecked: 4, counts: { error: 0, warning: 0, info: 0 }, issues: [] },
        gate: blocked,
    });
    const report = await runQaCheck(client, { branch: "feature", baseBranch: "main", failOn: "error" });
    assert.deepEqual(calls, ["runQa:feature", "getMergeGate:feature"]);
    assert.equal(report.gateTarget, "main");
    assert.equal(report.failedOnIssues, false);
    assert.equal(report.failedOnGate, true);
    assert.equal(report.failed, true);
});

test("runQaCheck: errors fail; ignored issues are left out of the list; errors sort first", async () => {
    const { client } = fakeClient({
        run: {
            branch: "feature",
            pairsChecked: 4,
            counts: { error: 1, warning: 1, info: 0 },
            issues: [issue({ id: "w", severity: "warning", key: "a" }), issue({ id: "e", key: "z" }), issue({ id: "x", ignored: true })],
        },
    });
    const report = await runQaCheck(client, { branch: "feature", baseBranch: "main", failOn: "error" });
    assert.equal(report.failed, true);
    assert.deepEqual(report.issues.map((i) => i.id), ["e", "w"]);
});

test("runQaCheck: a background run reads the stored issues instead", async () => {
    const { client, calls } = fakeClient({ run: { branch: "main", background: true }, stored: [issue({ branch: "main" })] });
    const report = await runQaCheck(client, { baseBranch: "main", failOn: "error" });
    assert.deepEqual(calls, ["runQa:-", "listQaIssues:main:100"]);
    assert.equal(report.background, true);
    assert.equal(report.pairsChecked, null);
    assert.equal(report.counts.error, 1);
    assert.equal(report.failed, true);
});

test("runQaCheck: a switched-off gate is noted, not fatal; other gate errors propagate", async () => {
    const off = fakeClient({
        run: { branch: "feature", pairsChecked: 1, counts: { error: 0, warning: 0, info: 0 }, issues: [] },
        gate: new TranslatizeApiError("feature_disabled", 404, "feature_disabled"),
    });
    const report = await runQaCheck(off.client, { branch: "feature", baseBranch: "main", failOn: "error" });
    assert.equal(report.gate, null);
    assert.match(report.gateNote ?? "", /feature_disabled/);
    assert.equal(report.failed, false);

    const denied = fakeClient({
        run: { branch: "feature", pairsChecked: 1, counts: { error: 0, warning: 0, info: 0 }, issues: [] },
        gate: new TranslatizeApiError("nope", 400, "branch_not_allowed"),
    });
    await assert.rejects(() => runQaCheck(denied.client, { branch: "feature", baseBranch: "main", failOn: "error" }), /nope/);
});

test("describeIssue: the AI message wins; otherwise code plus params", () => {
    assert.equal(describeIssue(issue()), "placeholder_missing (missing: {count})");
    assert.equal(describeIssue(issue({ params: {} })), "placeholder_missing");
    assert.equal(describeIssue(issue({ source: "ai", message: "Too formal" })), "Too formal");
    assert.equal(describeIssue(issue({ code: "length_exceeded", params: { limit: 20, length: 31 } })), "length_exceeded (limit: 20, length: 31)");
});
