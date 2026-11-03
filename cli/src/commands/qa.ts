import { TranslatizeApiError, type MergeGate, type QaCounts, type QaIssue, type TranslatizeClient } from "@translatize/core";
import { UsageError } from "../config.js";
import { createColors, describeApiError, info, printJson, table, warn, type Colors } from "../ui.js";
import { buildApiContext, type GlobalOpts } from "./shared.js";

export interface QaOpts extends GlobalOpts {
    failOn?: string;
    json?: boolean;
}

/** The lowest severity that fails the command. */
export type FailOn = "error" | "warning";

/** How many issues the human output lists. */
const ISSUE_ROWS = 20;
const SEVERITY_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

export function parseFailOn(value: string | undefined): FailOn {
    const v = (value ?? "error").trim().toLowerCase();
    if (v === "error" || v === "warning") {
        return v;
    }
    throw new UsageError(`--fail-on must be "error" or "warning", got "${value}"`);
}

/** True when the counts hold an issue at `failOn` severity or above. Info never fails. */
export function failsThreshold(counts: QaCounts, failOn: FailOn): boolean {
    const errors = counts.error ?? 0;
    const warnings = counts.warning ?? 0;
    return failOn === "error" ? errors > 0 : errors + warnings > 0;
}

/** The client calls the qa command makes – a seam for tests. */
export type QaClient = Pick<TranslatizeClient, "runQa" | "listQaIssues" | "getMergeGate">;

export interface QaReport {
    branch: string;
    /** `null` when the run went to the background and the stored issues were read instead. */
    pairsChecked: number | null;
    background: boolean;
    counts: QaCounts;
    /** The issues the server returned (at most 200), ignored ones and AI score rows left out. */
    issues: QaIssue[];
    /** Gate preview for merging `branch` into the token's base branch; `null` on the base branch itself. */
    gate: MergeGate | null;
    gateTarget: string | null;
    /** Why the gate could not be read, when it could not. */
    gateNote: string | null;
    failOn: FailOn;
    failedOnIssues: boolean;
    failedOnGate: boolean;
    failed: boolean;
}

/**
 * Run QA on `branch` and, when it is not the token's base branch, read the merge
 * gate into the base too. Fails on issues at `failOn` severity or above, and on a
 * blocked gate whatever `failOn` says – a blocked gate means the merge will be refused.
 */
export async function runQaCheck(
    client: QaClient,
    opts: { branch?: string; baseBranch: string; failOn: FailOn },
): Promise<QaReport> {
    const run = await client.runQa(opts.branch !== undefined ? { branch: opts.branch } : {});
    let counts: QaCounts;
    let issues: QaIssue[];
    let pairsChecked: number | null;
    let background = false;
    if (run.background === true) {
        // Over the inline limit the server re-checks in the background; the stored
        // issues (kept current on every label change) are the best answer we have now.
        background = true;
        const page = await client.listQaIssues({ branch: run.branch, limit: 100 });
        counts = page.counts;
        issues = page.issues;
        pairsChecked = null;
    } else {
        counts = run.counts;
        issues = run.issues;
        pairsChecked = run.pairsChecked;
    }

    let gate: MergeGate | null = null;
    let gateTarget: string | null = null;
    let gateNote: string | null = null;
    if (run.branch !== opts.baseBranch) {
        try {
            const res = await client.getMergeGate(run.branch);
            gate = res.gate;
            gateTarget = res.target;
        } catch (err) {
            if (err instanceof TranslatizeApiError && (err.code === "feature_disabled" || err.status === 404)) {
                gateNote = describeApiError(err);
            } else {
                throw err;
            }
        }
    }

    const failedOnIssues = failsThreshold(counts, opts.failOn);
    const failedOnGate = gate?.blocked === true;
    return {
        branch: run.branch,
        pairsChecked,
        background,
        counts,
        // Ignored issues and the AI score rows of clean translations need no action.
        issues: sortIssues(issues.filter((issue) => !issue.ignored && issue.code !== "ai_score")),
        gate,
        gateTarget,
        gateNote,
        failOn: opts.failOn,
        failedOnIssues,
        failedOnGate,
        failed: failedOnIssues || failedOnGate,
    };
}

function sortIssues(issues: QaIssue[]): QaIssue[] {
    return [...issues].sort(
        (a, b) =>
            (SEVERITY_ORDER[a.severity] ?? 9) - (SEVERITY_ORDER[b.severity] ?? 9) ||
            a.key.localeCompare(b.key) ||
            a.lang.localeCompare(b.lang),
    );
}

/** One line for an issue: the AI message when there is one, otherwise the code plus its params. */
export function describeIssue(issue: QaIssue): string {
    if (issue.message) {
        return issue.message;
    }
    const params = Object.entries(issue.params ?? {})
        .map(([name, value]) => `${name}: ${Array.isArray(value) ? value.join(" ") : typeof value === "object" ? JSON.stringify(value) : String(value)}`)
        .join(", ");
    return params ? `${issue.code} (${params})` : issue.code;
}

/** `translatize qa` – run the QA checks on a branch; the CI gate for translation quality. */
export async function qaCommand(opts: QaOpts): Promise<number> {
    const colors = createColors();
    const failOn = parseFailOn(opts.failOn);
    const ctx = buildApiContext(opts);
    const me = await ctx.client.me();
    const report = await runQaCheck(ctx.client, { branch: ctx.branch, baseBranch: me.branch, failOn });

    if (opts.json) {
        printJson({ command: "qa", ...report, ok: !report.failed });
        return report.failed ? 1 : 0;
    }
    renderReport(colors, report);
    return report.failed ? 1 : 0;
}

function renderReport(colors: Colors, report: QaReport): void {
    const checked = report.pairsChecked !== null ? ` – ${report.pairsChecked} key × language pair(s) checked` : "";
    info(`QA for branch ${colors.bold(report.branch)}${checked}`);
    if (report.background) {
        warn(colors, "the branch is too big to check inline – a full re-check is running on the server. Showing the stored issues.");
    }
    info("");
    info(
        table(colors, ["Severity", "Count"], [
            ["error", String(report.counts.error ?? 0)],
            ["warning", String(report.counts.warning ?? 0)],
            ["info", String(report.counts.info ?? 0)],
        ]),
    );
    info("");

    if (report.issues.length > 0) {
        const rows = report.issues
            .slice(0, ISSUE_ROWS)
            .map((issue) => [issue.key, issue.lang, issue.severity, issue.checkId, describeIssue(issue)]);
        info(table(colors, ["Key", "Lang", "Severity", "Check", "Issue"], rows));
        const total = (report.counts.error ?? 0) + (report.counts.warning ?? 0) + (report.counts.info ?? 0);
        if (total > rows.length) {
            info(colors.dim(`  … ${total - rows.length} more – open the branch in the app to see them all.`));
        }
        info("");
    }

    if (report.gate && report.gateTarget) {
        const gate = report.gate;
        let state: string;
        if (!gate.applies) {
            state = colors.dim(`does not apply (mode ${gate.mode})`);
        } else if (gate.blocked) {
            state = colors.red(`blocked – ${gate.errors} error(s) on the keys the merge would change`);
        } else {
            state = colors.green(`passes (mode ${gate.mode}, ${gate.errors} error(s), ${gate.warnings} warning(s))`);
        }
        info(`Merge gate into ${colors.bold(report.gateTarget)}: ${state}`);
        info("");
    } else if (report.gateNote) {
        warn(colors, `merge gate not checked: ${report.gateNote}`);
    }

    if (report.failed) {
        const reasons: string[] = [];
        if (report.failedOnIssues) {
            reasons.push(
                report.failOn === "error"
                    ? `${report.counts.error} error(s)`
                    : `${report.counts.error} error(s) and ${report.counts.warning} warning(s)`,
            );
        }
        if (report.failedOnGate) {
            reasons.push("the merge gate blocks the merge");
        }
        info(colors.red(`FAIL: ${reasons.join("; ")} (--fail-on ${report.failOn}).`));
    } else {
        info(colors.green(`OK – no issues at "${report.failOn}" severity or above.`));
    }
}
