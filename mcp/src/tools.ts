import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TranslatizeApiError, type LabelContext, type MeResponse, type QaIssue } from "@translatize/core";
import { describeApiError } from "./errors.js";
import { isNonEmpty, matchesLabel, percent, summarizeLanguage } from "./labels.js";
import type { Session } from "./session.js";

/** Wrap a JSON-serializable value as a successful text tool result. */
function ok(data: unknown): CallToolResult {
    return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

/** An error tool result (`isError: true`) carrying a plain-text message for the agent. */
function fail(message: string): CallToolResult {
    return { content: [{ type: "text", text: message }], isError: true };
}

/**
 * Run a tool body, mapping any {@link TranslatizeApiError} to an error result with the
 * API's code and a remedy, and any other throw to a generic error result. Handlers never
 * throw out of this wrapper, so the transport only ever sees well-formed tool results.
 */
async function run(fn: () => Promise<unknown>): Promise<CallToolResult> {
    try {
        return ok(await fn());
    } catch (err) {
        if (err instanceof TranslatizeApiError) {
            return fail(describeApiError(err));
        }
        return fail(`Unexpected error: ${err instanceof Error ? err.message : String(err)}`);
    }
}

const LIST_VALUES_LIMIT = 300;
const SEARCH_LIMIT = 100;
const MISSING_KEYS_LIMIT = 50;
const MISSING_TRANSLATIONS_DEFAULT_LIMIT = 200;
const REVIEW_KEYS_LIMIT = 100;

const BRANCH_ARG_DESC =
    "Branch to operate on. Defaults to the token's base (bound) branch. May name any branch in the token's allowed " +
    "set: its base branch, plus branches this token created (only when the token's scope is create-own; see " +
    "list_branches). Naming any other branch fails with branch_not_allowed.";

/** A fresh optional `branch` argument schema (one instance per tool). */
const branchArg = () => z.string().min(1).optional().describe(BRANCH_ARG_DESC);

/** One manual merge-conflict resolution, matching the API's `conflicts[]` shape. */
const mergeConflictSchema = z.object({
    key: z.string().min(1).describe("The conflicting label key."),
    lang: z.string().min(1).describe("The conflicting language code."),
    resolution: z
        .enum(["source", "target", "custom"])
        .describe('Take the source (branch) value, the target (base) value, or a "custom" value.'),
    customValue: z.string().optional().describe('The value to use when resolution is "custom".'),
});

/** Translator context for a key, matching the API's `context` object. */
const contextSchema = () =>
    z
        .object({
            description: z
                .string()
                .max(1000)
                .optional()
                .describe("Which UI element this is and where it appears, e.g. \"Submit button of the checkout payment form\"."),
            charLimit: z
                .number()
                .int()
                .min(1)
                .max(10000)
                .optional()
                .describe("Maximum length of every translation. Set it only when the UI clearly limits the length."),
            location: z.string().max(300).optional().describe('Where the string is used, as "path:line".'),
            doNotTranslate: z
                .boolean()
                .optional()
                .describe(
                    "true when the text must stay the same in every language (a product name, brand or code): AI " +
                        "translation then copies the source text instead of translating it. false clears it.",
                ),
        })
        .describe("Translator context (developer role or higher). AI translation and the QA length check use it.");

// The fields of a QA issue an agent needs to act on it.
function slimIssue(issue: QaIssue): Record<string, unknown> {
    const out: Record<string, unknown> = {
        key: issue.key,
        lang: issue.lang,
        severity: issue.severity,
        check: issue.checkId,
        code: issue.code,
        params: issue.params,
        source: issue.source,
    };
    if (issue.message) out.message = issue.message;
    if (issue.suggestion) out.suggestion = issue.suggestion;
    return out;
}

// Ignored issues and the AI score rows of clean translations need no action.
// The language translations are made from: the project's setting (servers since
// 0.2.0 report it), else the first configured language.
function sourceLanguageOf(me: MeResponse): string | undefined {
    return me.sourceLanguage && me.project.langs.includes(me.sourceLanguage) ? me.sourceLanguage : me.project.langs[0];
}

function activeIssues(issues: QaIssue[] | undefined): Record<string, unknown>[] {
    return (issues ?? []).filter((issue) => !issue.ignored && issue.code !== "ai_score").map(slimIssue);
}

// The server refuses an empty context object, so leave one out.
function nonEmptyContext(context: LabelContext | undefined): LabelContext | undefined {
    return context && Object.keys(context).length > 0 ? context : undefined;
}

/** Tags as the API accepts them: at most 20, each 1–50 characters. */
const tagsArg = () => z.array(z.string().min(1).max(50)).max(20);

// Each tool's title is set twice on purpose: top-level (MCP spec 2025-06-18+ clients)
// and mirrored into annotations.title (older clients), so it shows in every client.

/** Read-only tool: reports the environment without modifying it. */
function readOnlyTool(title: string): { title: string; annotations: ToolAnnotations } {
    return { title, annotations: { title, readOnlyHint: true } };
}

/** Mutating but non-destructive tool: creates/edits data (additive), never deletes or replaces wholesale. */
function mutatingTool(title: string): { title: string; annotations: ToolAnnotations } {
    return { title, annotations: { title, readOnlyHint: false, destructiveHint: false } };
}

/** Destructive tool: may delete or wholesale-overwrite existing data. */
function destructiveTool(title: string): { title: string; annotations: ToolAnnotations } {
    return { title, annotations: { title, readOnlyHint: false, destructiveHint: true } };
}

/** Register all Translatize tools on `server`, backed by `session` (which owns the API client). */
export function registerTools(server: McpServer, session: Session): void {
    server.registerTool(
        "get_project_info",
        {
            ...readOnlyTool("Get Project Info"),
            description:
                "Get an overview of the Translatize project this server is connected to: its name and id, the " +
                "configured languages and the source language, the base branch the API token is bound to, the token's role, the branch scope " +
                "(fixed = only the base branch is writable; create-own = the token may also create and manage its own " +
                "branches), the names of the branches this token may write to, the total number of label " +
                "(translation-key) records, and per-language completeness percentages. Use this first to learn which " +
                "project, branch, languages and scope you are working with. Takes no arguments.",
            inputSchema: {},
        },
        async () =>
            run(async () => {
                const me = await session.me();
                const list = await session.client.listLabels();
                const branches = await session.client.listBranches();
                const total = list.labels.length;
                const languages = me.project.langs.map((lang) => {
                    const { translated } = summarizeLanguage(list.labels, lang, 0);
                    return { lang, translated, total, percent: percent(translated, total) };
                });
                return {
                    project: { id: me.project.id, name: me.project.name, languages: me.project.langs, sourceLanguage: sourceLanguageOf(me) ?? null },
                    branch: me.branch,
                    role: me.role,
                    branchScope: branches.branchScope,
                    writableBranches: branches.branches.filter((branch) => branch.writable).map((branch) => branch.name),
                    token: { name: me.token.name, autoPublish: me.token.autoPublish, expiresAt: me.token.expiresAt },
                    totalKeys: total,
                    languages,
                };
            }),
    );

    server.registerTool(
        "list_labels",
        {
            ...readOnlyTool("List Labels"),
            description:
                "List translation label keys on a branch, optionally filtered by namespace (a dotted key " +
                'prefix, so "checkout" matches "checkout.title") and/or status. Returns each label\'s key, status and ' +
                "tags; pass include_values=true to also get the per-language translation strings. Use this to browse " +
                "or enumerate keys. Values are omitted by default to keep the response small. When include_values is " +
                `true and more than ${LIST_VALUES_LIMIT} labels match, only the first ${LIST_VALUES_LIMIT} are returned ` +
                "with a note; narrow the result using the namespace filter. Reads the token's base branch unless " +
                "`branch` names another allowed branch.",
            inputSchema: {
                namespace: z.string().optional().describe('Only keys beginning with "<namespace>." (a dotted prefix).'),
                status: z.string().optional().describe("Only labels carrying this exact status string."),
                include_values: z
                    .boolean()
                    .optional()
                    .default(false)
                    .describe("Include the per-language translation values (defaults to false)."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const list = await session.client.listLabels({
                    namespace: args.namespace,
                    status: args.status,
                    branch: args.branch,
                });
                const includeValues = args.include_values;
                let labels = list.labels;
                let truncated = false;
                if (includeValues && labels.length > LIST_VALUES_LIMIT) {
                    labels = labels.slice(0, LIST_VALUES_LIMIT);
                    truncated = true;
                }
                const mapped = labels.map((label) =>
                    includeValues
                        ? { key: label.key, status: label.status, tags: label.tags, values: label.values }
                        : { key: label.key, status: label.status, tags: label.tags },
                );
                const result: Record<string, unknown> = {
                    branch: list.branch,
                    total: list.total,
                    count: mapped.length,
                    labels: mapped,
                };
                if (truncated) {
                    result.truncated = true;
                    result.note =
                        `Returned the first ${LIST_VALUES_LIMIT} of ${list.total} labels (values included). ` +
                        'Narrow the result with the "namespace" filter (a dotted key prefix), or omit include_values to list keys only.';
                }
                return result;
            }),
    );

    server.registerTool(
        "get_labels",
        {
            ...readOnlyTool("Get Labels"),
            description:
                "Fetch the full record (all per-language values, status and tags) for a specific set of label keys on " +
                "a branch. Use this when you already know the exact keys you need, for example from " +
                "list_labels or search_labels, and want their complete translations. Returns the found labels plus a " +
                "not_found list of any requested keys that do not exist on the branch. Reads the token's base branch " +
                "unless `branch` names another allowed branch.",
            inputSchema: {
                keys: z.array(z.string().min(1)).min(1).describe("The exact label keys to fetch (at least one)."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const list = await session.client.listLabels({ branch: args.branch });
                const byKey = new Map(list.labels.map((label) => [label.key, label] as const));
                const labels: unknown[] = [];
                const notFound: string[] = [];
                for (const key of args.keys) {
                    const found = byKey.get(key);
                    if (found) {
                        labels.push({ key: found.key, values: found.values, status: found.status, tags: found.tags });
                    } else {
                        notFound.push(key);
                    }
                }
                return { branch: list.branch, labels, not_found: notFound };
            }),
    );

    server.registerTool(
        "search_labels",
        {
            ...readOnlyTool("Search Labels"),
            description:
                "Case-insensitive substring search across labels on a branch. Set in='keys' to match only key " +
                "names, in='values' to match only translation text, or in='both' (the default) for either. Returns " +
                `matching labels with their full values, capped at ${SEARCH_LIMIT} matches. Use this to find keys by a ` +
                "fragment of the key path or by the wording of an existing translation. Reads the token's base branch " +
                "unless `branch` names another allowed branch.",
            inputSchema: {
                query: z.string().min(1).describe("The substring to look for (case-insensitive)."),
                in: z
                    .enum(["keys", "values", "both"])
                    .optional()
                    .default("both")
                    .describe("Where to search: key names, translation values, or both (default)."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const scope = args.in;
                const query = args.query.toLowerCase();
                const list = await session.client.listLabels({ branch: args.branch });
                const labels: unknown[] = [];
                let totalMatches = 0;
                for (const label of list.labels) {
                    if (matchesLabel(label, query, scope)) {
                        totalMatches++;
                        if (labels.length < SEARCH_LIMIT) {
                            labels.push({ key: label.key, values: label.values, status: label.status, tags: label.tags });
                        }
                    }
                }
                const result: Record<string, unknown> = {
                    branch: list.branch,
                    query: args.query,
                    in: scope,
                    total_matches: totalMatches,
                    count: labels.length,
                    labels,
                };
                if (totalMatches > labels.length) {
                    result.truncated = true;
                    result.note = `Showing the first ${SEARCH_LIMIT} of ${totalMatches} matches. Refine the query to narrow the results.`;
                }
                return result;
            }),
    );

    server.registerTool(
        "upsert_label",
        {
            ...mutatingTool("Create or Update Label"),
            description:
                "Create or update a single label on a branch (upsert by key). Provide the key plus any of values " +
                "(an object of languageCode -> string), status, or tags. Every language in values must be configured " +
                "on the project, or the call is rejected with unknown_languages. Returns whether the label was created or " +
                "updated and its resulting stored state. Use this to add a new translation key or change an existing " +
                "one. Give every NEW key its `context` (a description of the UI element, plus charLimit/location when " +
                "known) so translators and the AI get it right. Writes to the token's base branch unless `branch` names " +
                "another allowed branch.",
            inputSchema: {
                key: z.string().min(1).describe('The dotted label key, e.g. "checkout.pay_button".'),
                values: z
                    .record(z.string(), z.string())
                    .optional()
                    .describe("Per-language values as { languageCode: string }; only configured languages are allowed."),
                status: z.string().optional().describe("Optional status string to set on the label."),
                tags: tagsArg().optional().describe("Optional tags to set on the label (developer role or higher)."),
                context: contextSchema().optional(),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const result = await session.client.upsertLabel(
                    {
                        key: args.key,
                        values: args.values,
                        status: args.status,
                        tags: args.tags,
                        context: nonEmptyContext(args.context),
                    },
                    { branch: args.branch },
                );
                return {
                    action: result.created ? "created" : "updated",
                    key: result.key,
                    branch: result.branch,
                    created: result.created,
                    values: result.values,
                    status: result.status,
                    tags: result.tags,
                    ...(result.context !== undefined ? { context: result.context } : {}),
                };
            }),
    );

    server.registerTool(
        "upsert_labels",
        {
            ...mutatingTool("Create or Update Labels (Batch)"),
            description:
                "Create or update many labels on a branch in one call (batched automatically, with no client-side " +
                "size limit). Pass labels as an array of { key, values?, status?, tags?, context? }. Returns counts of " +
                "created and updated labels plus a failed list of any individual items the server rejected (for example, " +
                "an unknown language on one item). Use this instead of repeated upsert_label calls when writing more than " +
                "a couple of keys, and give every new key its `context` (description, plus charLimit/location when known). " +
                "Writes to the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                labels: z
                    .array(
                        z.object({
                            key: z.string().min(1),
                            values: z.record(z.string(), z.string()).optional(),
                            status: z.string().optional(),
                            tags: tagsArg().optional(),
                            context: contextSchema().optional(),
                        }),
                    )
                    .min(1)
                    .describe("The labels to create or update (at least one)."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const labels = args.labels.map(({ context, ...rest }) => {
                    const given = nonEmptyContext(context);
                    return given ? { ...rest, context: given } : rest;
                });
                const result = await session.client.upsertLabels(labels, { branch: args.branch });
                return { updated: result.updated, created: result.created, failed: result.failed };
            }),
    );

    server.registerTool(
        "translation_status",
        {
            ...readOnlyTool("Translation Coverage"),
            description:
                "Report translation coverage on a branch: for every configured language, the total number of " +
                "keys, how many are translated (have a non-empty value), how many are missing, and up to " +
                `${MISSING_KEYS_LIMIT} example missing keys. Use this for a quick coverage overview; use ` +
                "get_missing_translations to get the actual keys and source text to translate. Reads the token's base " +
                "branch unless `branch` names another allowed branch.",
            inputSchema: {
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const me = await session.me();
                const list = await session.client.listLabels({ branch: args.branch });
                const total = list.labels.length;
                const languages = me.project.langs.map((lang) => {
                    const summary = summarizeLanguage(list.labels, lang, MISSING_KEYS_LIMIT);
                    return {
                        lang,
                        total,
                        translated: summary.translated,
                        missing: summary.missing,
                        missingKeys: summary.missingKeys,
                    };
                });
                return { branch: list.branch, totalKeys: total, languages };
            }),
    );

    // ------------------------------------------------------------------------
    // Branching (create-own scope)
    // ------------------------------------------------------------------------

    server.registerTool(
        "list_branches",
        {
            ...readOnlyTool("List Branches"),
            description:
                "List every branch in the project, each flagged with writable (whether this token may read/write/export " +
                "it) and createdByThisToken (whether this token created it). Also returns baseBranch (the branch the " +
                "token is bound to) and branchScope (fixed = only the base branch is writable; create-own = the token " +
                "may additionally create branches and manage the ones it creates). Use this to see which branches exist " +
                "and which you are allowed to act on before compare/merge/delete. Takes no arguments.",
            inputSchema: {},
        },
        async () =>
            run(async () => {
                return session.client.listBranches();
            }),
    );

    server.registerTool(
        "create_branch",
        {
            ...mutatingTool("Create Branch"),
            description:
                "Create a new branch, forked from the token's base branch (you cannot choose a different base), then " +
                "work on it by passing its name as `branch` to the label tools. Requires a create-own scoped token " +
                "and the developer role or higher. A fixed-scope token fails with branch_scope_fixed; when that " +
                "happens, tell the user to issue a create-own token under Project Settings -> Integrations. Name " +
                'rules: 1-100 characters matching ^[a-zA-Z0-9_-]+$, and not "main". Returns the created branch. This ' +
                "is the typical first step of a change: create a branch, edit/translate on it, review_changes, then " +
                "merge_branch back into the base and delete_branch.",
            inputSchema: {
                name: z
                    .string()
                    .min(1)
                    .max(100)
                    .describe('New branch name: 1-100 chars matching ^[a-zA-Z0-9_-]+$, and not "main".'),
                description: z.string().max(500).optional().describe("Optional human-readable description (max 500 chars)."),
            },
        },
        async (args) =>
            run(async () => {
                const result = await session.client.createBranch({ name: args.name, description: args.description });
                return { created: true, branch: result.branch };
            }),
    );

    server.registerTool(
        "compare_with_base",
        {
            ...readOnlyTool("Compare Branch With Base"),
            description:
                "Compare a branch (the source) against the token's base branch (the target): returns the changed, added " +
                "and deleted keys, each with the differing per-language source/target values, plus a summary of " +
                "counts. The branch must be in the token's allowed set. Use this to see exactly what a branch would " +
                "bring into the base before merging. For a capped, human-oriented review view, use review_changes instead.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch to compare against the base (the source of the diff)."),
            },
        },
        async (args) =>
            run(async () => {
                return session.client.compareBranch(args.branch);
            }),
    );

    server.registerTool(
        "get_merge_conflicts",
        {
            ...readOnlyTool("Get Merge Conflicts"),
            description:
                "List the per-key, per-language merge conflicts between a branch (source) and the token's base branch " +
                "(target): the cases where both sides hold a different non-empty value. Returns a flat conflicts array " +
                "plus hasConflicts / conflictCount. An empty list means the branch is safe to merge with the default " +
                '(overwrite) strategy. When there ARE conflicts and you want to resolve each one explicitly, use this ' +
                'first, then pass the resolutions to merge_branch with strategy "manual". The branch must be in the ' +
                "token's allowed set.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch to check for conflicts against the base (the source)."),
            },
        },
        async (args) =>
            run(async () => {
                return session.client.branchConflicts(args.branch);
            }),
    );

    server.registerTool(
        "merge_branch",
        {
            ...destructiveTool("Merge Branch Into Base"),
            description:
                "Merge a branch this token created back into the token's base branch (the implicit, only-allowed " +
                "target). Requires a create-own token with the developer role or higher. The merge does NOT delete the " +
                "source branch. Call delete_branch afterwards to clean it up. Strategies: overwrite (default; a " +
                "non-destructive union where the source wins conflicts and keys only on the base are kept), keep-newer " +
                "(whichever side changed more recently wins), manual (you supply per-conflict resolutions obtained from " +
                "get_merge_conflicts), branch-changes (only labels created or changed on the branch since it was created " +
                "are applied, the source winning for those; everything else on the base stays as it is and deletions are " +
                "not carried over; the result's overlappingKeys lists merged keys the base also changed meanwhile – show " +
                "them to the user to recheck), and replace (DESTRUCTIVE: the base becomes an exact copy of the source; use only " +
                "when the user explicitly asks to replace). Merging into main needs an ADMIN-role token; any other token " +
                "fails with admin_token_required_for_main, and then the user merges in the web app instead. The QA merge " +
                "gate can refuse the merge with qa_gate_blocked: call run_qa and check_merge_gate first and fix the errors " +
                "(tokens cannot override the gate). Only merge after the user has reviewed and approved the changes.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch to merge into the base (must be one this token created)."),
                strategy: z
                    .enum(["overwrite", "replace", "keep-newer", "manual", "branch-changes"])
                    .optional()
                    .describe(
                        "Merge strategy (default overwrite). branch-changes applies only what changed on the branch. Use replace " +
                            "only when explicitly told; it is destructive.",
                    ),
                conflicts: z
                    .array(mergeConflictSchema)
                    .optional()
                    .describe('Per-conflict resolutions; only consulted with strategy "manual" (get them from get_merge_conflicts).'),
            },
        },
        async (args) =>
            run(async () => {
                return session.client.mergeBranch(args.branch, { strategy: args.strategy, conflicts: args.conflicts });
            }),
    );

    server.registerTool(
        "delete_branch",
        {
            ...destructiveTool("Delete Branch"),
            description:
                "Delete a branch this token created (createdByThisToken=true in list_branches). Requires the developer " +
                "role or higher. The base branch and any branch the token did not create can never be deleted; " +
                "deleting them fails with not_token_branch. Use this to clean up after a successful merge_branch.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch to delete (must be one this token created)."),
            },
        },
        async (args) =>
            run(async () => {
                return session.client.deleteBranch(args.branch);
            }),
    );

    // ------------------------------------------------------------------------
    // Translation (missing-work discovery + platform AI)
    // ------------------------------------------------------------------------

    server.registerTool(
        "get_missing_translations",
        {
            ...readOnlyTool("Find Missing Translations"),
            description:
                "Find labels that still need translation on a branch. For each key with at least one empty " +
                "target-language value, returns { key, source: { lang, value }, missing: [languages] }, where the source " +
                "language is the project's source language (see get_project_info). Optionally restrict to specific `languages` and " +
                `cap the rows with \`limit\` (default ${MISSING_TRANSLATIONS_DEFAULT_LIMIT}); the response reports the true ` +
                "total and notes truncation. Use this to translate the missing values YOURSELF (works on any plan) and " +
                "then write them back with upsert_labels. For server-side AI on paid plans, use auto_translate instead. " +
                "Reads the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                branch: branchArg(),
                languages: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Restrict to these target languages; omit to check every non-source project language."),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe(`Maximum rows to return (default ${MISSING_TRANSLATIONS_DEFAULT_LIMIT}).`),
            },
        },
        async (args) =>
            run(async () => {
                const me = await session.me();
                const langs = me.project.langs;
                const sourceLang = sourceLanguageOf(me) ?? "";
                const requested = args.languages && args.languages.length > 0 ? args.languages : langs;
                const targets = requested.filter((lang) => lang !== sourceLang && langs.includes(lang));
                const limit = args.limit ?? MISSING_TRANSLATIONS_DEFAULT_LIMIT;
                const list = await session.client.listLabels({ branch: args.branch });

                const rows: Array<{ key: string; source: { lang: string; value: string }; missing: string[] }> = [];
                let total = 0;
                for (const label of list.labels) {
                    const missing = targets.filter((lang) => !isNonEmpty(label.values?.[lang]));
                    if (missing.length === 0) {
                        continue;
                    }
                    total++;
                    if (rows.length < limit) {
                        rows.push({
                            key: label.key,
                            source: { lang: sourceLang, value: label.values?.[sourceLang] ?? "" },
                            missing,
                        });
                    }
                }
                const result: Record<string, unknown> = {
                    branch: list.branch,
                    sourceLang,
                    targetLanguages: targets,
                    total,
                    count: rows.length,
                    missing: rows,
                };
                if (targets.length === 0) {
                    result.note =
                        "No target languages to check (the project has only the source language, or none of the requested languages are configured).";
                } else if (total > rows.length) {
                    result.truncated = true;
                    result.note =
                        `Showing the first ${limit} of ${total} keys with missing translations. ` +
                        'Raise "limit", or narrow with "languages"/"branch", to see more.';
                }
                return result;
            }),
    );

    server.registerTool(
        "auto_translate",
        {
            ...mutatingTool("Auto-Translate (Platform AI)"),
            description:
                "Trigger Translatize's PLATFORM AI to fill in missing translations on a branch as a background job. " +
                "It is available only on plans that include it (professional/agency), and it is metered against the " +
                "AI quota. It translates from the project's source language. Optionally scope to specific target_languages " +
                "(defaults to every project language except the source), specific label_keys, and set overwrite_translated to re-translate values that already " +
                "exist. Returns the started job (poll it with translation_job_status) or a no-op when nothing needs " +
                "translating. If it fails with feature_not_available, the plan has no platform AI; fall back to " +
                "get_missing_translations and translate the values yourself. Other failures: ai_quota_exceeded (the " +
                "quota is exhausted; report used/limit to the user) and translation_already_running (a job is already " +
                "in flight; check translation_job_status). Targets the token's base branch unless `branch` names " +
                "another allowed branch.",
            inputSchema: {
                branch: branchArg(),
                target_languages: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Languages to translate INTO; defaults to every project language except the source."),
                label_keys: z
                    .array(z.string().min(1))
                    .optional()
                    .describe("Restrict to these label keys; omit to translate every label needing work."),
                overwrite_translated: z
                    .boolean()
                    .optional()
                    .describe("Re-translate values that already have a translation (default false)."),
            },
        },
        async (args) =>
            run(async () => {
                // Name the source explicitly, so the job and the default targets agree on it.
                const me = await session.me();
                const sourceLang = sourceLanguageOf(me);
                const requested = args.target_languages && args.target_languages.length > 0 ? args.target_languages : me.project.langs;
                const targetLangs = requested.filter((lang) => lang !== sourceLang);
                if (targetLangs.length === 0) {
                    return {
                        started: false,
                        nothingToTranslate: true,
                        reason: "no_target_languages",
                        note: `There is no language to translate into other than the source language (${sourceLang ?? "none"}).`,
                    };
                }
                return session.client.autoTranslate({
                    branch: args.branch,
                    targetLangs,
                    ...(sourceLang ? { sourceLang } : {}),
                    labelKeys: args.label_keys,
                    overwriteTranslated: args.overwrite_translated,
                });
            }),
    );

    server.registerTool(
        "translation_job_status",
        {
            ...readOnlyTool("AI Translation Job Status"),
            description:
                "Report the project's current or most-recent AI translation job: its status (queued/running/completed/" +
                "failed), target languages, progress counts, and (while queued) its position in the global queue. Also " +
                "returns the AI quota (used / limit / remaining; a limit of -1 means unlimited). Use this to watch a job " +
                "started by auto_translate, or to check the remaining quota before starting one. Takes no arguments.",
            inputSchema: {},
        },
        async () =>
            run(async () => {
                return session.client.translationStatus();
            }),
    );

    server.registerTool(
        "set_labels_status",
        {
            ...mutatingTool("Set Labels Status"),
            description:
                "Set the workflow status of many labels at once (draft, review, approved or rejected) WITHOUT changing " +
                "their translation values. Pass the keys and the target status. Use this to mark keys as reviewed or " +
                "approved as part of a review workflow. Returns the updated/created counts and any per-key failures. " +
                "Writes to the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                keys: z.array(z.string().min(1)).min(1).describe("The label keys whose status to set (at least one)."),
                status: z
                    .enum(["draft", "review", "approved", "rejected"])
                    .describe("The workflow status to apply to every listed key."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const inputs = args.keys.map((key) => ({ key, status: args.status }));
                const result = await session.client.upsertLabels(inputs, { branch: args.branch });
                return {
                    status: args.status,
                    requested: args.keys.length,
                    updated: result.updated,
                    created: result.created,
                    failed: result.failed,
                };
            }),
    );

    server.registerTool(
        "review_changes",
        {
            ...readOnlyTool("Review Branch Changes"),
            description:
                "Produce a review packet for a branch: the added and changed keys (with their new per-language values, " +
                "and the previous values for changed keys), a summary of counts, the deleted keys, and a platformUrl a " +
                `human can open to review on the Translatize web app. Capped at ${REVIEW_KEYS_LIMIT} keys with a ` +
                "truncation note. After you finish translation work on a branch, use this, then ASK THE USER whether they " +
                "want to review the changes here in the conversation or on the Translatize platform (share the " +
                "platformUrl). Wait for their decision, and for their approval to merge, before calling merge_branch. " +
                "Defaults to the token's base branch when `branch` is omitted.",
            inputSchema: {
                branch: z
                    .string()
                    .min(1)
                    .optional()
                    .describe("The branch to review against the base; defaults to the token's base branch."),
            },
        },
        async (args) =>
            run(async () => {
                const me = await session.me();
                const branch = args.branch ?? me.branch;
                const comparison = await session.client.compareBranch(branch);

                const changes: Array<Record<string, unknown>> = [];
                let truncated = false;
                const consider = (entry: (typeof comparison.differences.added)[number], change: "added" | "changed"): void => {
                    if (changes.length >= REVIEW_KEYS_LIMIT) {
                        truncated = true;
                        return;
                    }
                    const values: Record<string, string> = {};
                    const previousValues: Record<string, string> = {};
                    for (const [lang, cell] of Object.entries(entry.languages)) {
                        if (cell.sourceValue !== null) {
                            values[lang] = cell.sourceValue;
                        }
                        if (cell.targetValue !== null) {
                            previousValues[lang] = cell.targetValue;
                        }
                    }
                    const record: Record<string, unknown> = { key: entry.key, change, values };
                    if (change === "changed") {
                        record.previousValues = previousValues;
                    }
                    changes.push(record);
                };
                for (const entry of comparison.differences.added) {
                    consider(entry, "added");
                }
                for (const entry of comparison.differences.changed) {
                    consider(entry, "changed");
                }

                const platformUrl = `${session.appUrl}/app/projects/${encodeURIComponent(me.project.id)}/branches`;
                const packet: Record<string, unknown> = {
                    branch: comparison.source,
                    base: comparison.target,
                    summary: comparison.summary,
                    changes,
                    deletedKeys: comparison.differences.deleted.map((entry) => entry.key),
                    platformUrl,
                    reviewPrompt:
                        "Ask the user whether they want to review these changes here in the conversation or on the " +
                        "Translatize platform (open platformUrl), and to confirm before you merge.",
                };
                if (truncated) {
                    packet.truncated = true;
                    packet.note =
                        `Showing the first ${REVIEW_KEYS_LIMIT} added/changed keys of ${comparison.summary.added + comparison.summary.changed}. ` +
                        "Open platformUrl to review the rest.";
                }
                return packet;
            }),
    );

    // ------------------------------------------------------------------------
    // Context, glossary and translation memory
    // ------------------------------------------------------------------------

    server.registerTool(
        "set_label_context",
        {
            ...mutatingTool("Set Label Context"),
            description:
                "Set translator context on existing keys in one batch, without touching their values: a description of " +
                "which UI element the key is and where it appears, a charLimit when the UI clearly limits the length, the " +
                "source location as path:line, doNotTranslate for text that stays the same in every language (product " +
                "names, brands, codes), and tags. AI translation and the QA length check use this context, so give " +
                "every key you create one. Only the fields you pass are sent. A key that does not exist fails with " +
                "label_not_found (create it with upsert_labels first). Needs the developer role or higher. Writes to the " +
                "token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                labels: z
                    .array(
                        z.object({
                            key: z.string().min(1).describe("The existing label key."),
                            description: z.string().max(1000).optional().describe("Which UI element this is and where it appears."),
                            charLimit: z.number().int().min(1).max(10000).optional().describe("Maximum length of every translation."),
                            location: z.string().max(300).optional().describe('Where the string is used, as "path:line".'),
                            doNotTranslate: z
                                .boolean()
                                .optional()
                                .describe("true: the text stays the same in every language (AI copies the source). false clears it."),
                            tags: tagsArg().optional().describe("Tags to set (replaces the key's tags)."),
                        }),
                    )
                    .min(1)
                    .describe("One entry per key; each needs at least one of description, charLimit, location, doNotTranslate or tags."),
                branch: branchArg(),
            },
        },
        async (args) => {
            const isEmpty = (item: (typeof args.labels)[number]): boolean =>
                item.description === undefined &&
                item.charLimit === undefined &&
                item.location === undefined &&
                item.doNotTranslate === undefined &&
                item.tags === undefined;
            const skipped = args.labels.filter(isEmpty).map((item) => item.key);
            if (skipped.length === args.labels.length) {
                return fail("Nothing to set: give each entry at least one of description, charLimit, location, doNotTranslate or tags.");
            }
            return run(async () => {
                const inputs = args.labels
                    .filter((item) => !isEmpty(item))
                    .map((item) => {
                        const context: LabelContext = {};
                        if (item.description !== undefined) context.description = item.description;
                        if (item.charLimit !== undefined) context.charLimit = item.charLimit;
                        if (item.location !== undefined) context.location = item.location;
                        if (item.doNotTranslate !== undefined) context.doNotTranslate = item.doNotTranslate;
                        return {
                            key: item.key,
                            ...(Object.keys(context).length > 0 ? { context } : {}),
                            ...(item.tags !== undefined ? { tags: item.tags } : {}),
                        };
                    });
                const result = await session.client.upsertLabels(inputs, { branch: args.branch });
                const out: Record<string, unknown> = { requested: args.labels.length, updated: result.updated, failed: result.failed };
                if (skipped.length > 0) {
                    out.skipped = skipped;
                    out.note = "Skipped entries had nothing to set.";
                }
                return out;
            });
        },
    );

    server.registerTool(
        "get_glossary",
        {
            ...readOnlyTool("Get Glossary"),
            description:
                "Get the project's glossary (project terms plus its workspace's): each term with its required translation " +
                "per language, whether it is case-sensitive, and whether it is prohibited. A translation equal to the term " +
                "means \"do not translate\"; a prohibited term must never appear in a translation. Read it before writing " +
                "or translating copy so terminology stays consistent – the QA glossary check enforces it. Takes no arguments.",
            inputSchema: {},
        },
        async () => run(async () => session.client.getGlossary()),
    );

    server.registerTool(
        "find_translation_memory",
        {
            ...readOnlyTool("Find Translation Memory"),
            description:
                "Look up earlier approved or human-edited translations of similar source texts (fuzzy, placeholder-aware). " +
                "For each text, returns up to 3 matches with the stored translation, a match score (100 = exact) and its " +
                "quality. Use it when translating yourself, to reuse wording the project already uses. source_lang defaults " +
                "to the project's source language. Takes no branch – the memory is shared across branches.",
            inputSchema: {
                texts: z.array(z.string().min(1).max(10000)).min(1).max(500).describe("Source texts to look up (sent in chunks of 100)."),
                target_lang: z.string().min(1).describe("The language to find translations in."),
                source_lang: z.string().min(1).optional().describe("The language of `texts`; defaults to the project's source language."),
                threshold: z.number().int().min(50).max(100).optional().describe("Minimum match score, 50–100 (server default 75)."),
            },
        },
        async (args) =>
            run(async () => {
                const sourceLang = args.source_lang ?? sourceLanguageOf(await session.me()) ?? "";
                const result = await session.client.findTranslationMemory({
                    texts: args.texts,
                    sourceLang,
                    targetLang: args.target_lang,
                    threshold: args.threshold,
                });
                return { sourceLang, targetLang: args.target_lang, results: result.results };
            }),
    );

    // ------------------------------------------------------------------------
    // Quality: QA checks, merge gate, AI review
    // ------------------------------------------------------------------------

    server.registerTool(
        "run_qa",
        {
            ...readOnlyTool("Run QA Checks"),
            description:
                "Run the rule-based QA checks on a branch now and return the result: counts per severity (error / warning / " +
                "info) and the issues, each with key, language, check, code and params. Checks: placeholders, ICU syntax " +
                "and plural categories, HTML tags, length vs charLimit, whitespace, untranslated, glossary, numbers and " +
                "punctuation. It changes no translation. Use it after translating: fix every error (rewrite the value or fix " +
                "its placeholders), run it again, then call check_merge_gate before merging. Pass `keys` to re-check only " +
                "some keys. Checks the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                branch: branchArg(),
                keys: z.array(z.string().min(1)).optional().describe("Only re-check these keys."),
            },
        },
        async (args) =>
            run(async () => {
                const result = await session.client.runQa({ branch: args.branch, keys: args.keys });
                if (result.background === true) {
                    return {
                        branch: result.branch,
                        background: true,
                        note: "The branch is too big to check inline; QA runs in the background. Call get_qa_issues in a minute.",
                    };
                }
                const issues = activeIssues(result.issues);
                const errors = result.counts?.error ?? 0;
                return {
                    branch: result.branch,
                    pairsChecked: result.pairsChecked,
                    counts: result.counts,
                    issues,
                    next:
                        errors > 0
                            ? `Fix the ${errors} error(s) on the branch, then call run_qa again.`
                            : "No errors. Call check_merge_gate before merging into the base branch.",
                };
            }),
    );

    server.registerTool(
        "get_qa_issues",
        {
            ...readOnlyTool("Get QA Issues"),
            description:
                "List the stored QA issues of a branch, one page at a time, with the counts per severity. Filter by " +
                "severity, key, language or source (rule = the built-in checks, ai = AI review findings). Pass nextCursor back as " +
                "`cursor` for the next page. Reads the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                branch: branchArg(),
                severity: z.enum(["error", "warning", "info"]).optional().describe("Only this severity."),
                key: z.string().min(1).optional().describe("Only issues on this key."),
                lang: z.string().min(2).optional().describe("Only issues in this target language."),
                source: z.enum(["rule", "ai"]).optional().describe("rule = QA checks, ai = AI review findings."),
                cursor: z.string().min(1).optional().describe("The nextCursor of the previous page."),
                limit: z.number().int().min(1).max(500).optional().describe("Page size, max 500 (default 100)."),
            },
        },
        async (args) =>
            run(async () => {
                const page = await session.client.listQaIssues({
                    branch: args.branch,
                    severity: args.severity,
                    key: args.key,
                    lang: args.lang,
                    source: args.source,
                    cursor: args.cursor,
                    limit: args.limit,
                });
                return { counts: page.counts, issues: activeIssues(page.issues), nextCursor: page.nextCursor };
            }),
    );

    server.registerTool(
        "check_merge_gate",
        {
            ...readOnlyTool("Check Merge Gate"),
            description:
                "Preview the QA merge gate for merging a branch into the token's base branch. The gate re-checks only the " +
                "key × language pairs the merge would change. Returns its mode (off / warn / block), whether it applies " +
                "to this target, whether it would BLOCK the merge, and the error and warning counts with the issues. When " +
                "blocked, merge_branch fails with qa_gate_blocked until the errors are fixed. Pass the strategy you will " +
                "give merge_branch: the pairs differ per strategy (branch-changes checks only what changed on the branch, " +
                "overwrite every key that differs from the base). Call it after run_qa and before asking the user to " +
                "approve a merge.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch you want to merge into the base (the source)."),
                strategy: z
                    .enum(["overwrite", "replace", "keep-newer", "manual", "branch-changes"])
                    .optional()
                    .describe("The merge strategy to preview (default overwrite) – the same one you will pass to merge_branch."),
            },
        },
        async (args) =>
            run(async () => {
                const { target, gate } = await session.client.getMergeGate(args.branch, { strategy: args.strategy });
                let verdict: string;
                if (!gate.applies) {
                    verdict = `The gate does not apply to a merge into "${target}" (mode ${gate.mode}).`;
                } else if (gate.blocked) {
                    verdict = `BLOCKED: merge_branch will be refused until the ${gate.errors} error(s) are fixed on "${args.branch}".`;
                } else if (gate.errors > 0) {
                    verdict = `The merge will go through (mode ${gate.mode}), but tell the user about the ${gate.errors} error(s) first.`;
                } else {
                    verdict = "Passes – no QA errors on the changed keys.";
                }
                return {
                    branch: args.branch,
                    target,
                    gate: {
                        mode: gate.mode,
                        applies: gate.applies,
                        blocked: gate.blocked,
                        errors: gate.errors,
                        warnings: gate.warnings,
                        pairsChecked: gate.pairsChecked,
                        issues: activeIssues(gate.issues),
                    },
                    verdict,
                };
            }),
    );

    server.registerTool(
        "start_ai_review",
        {
            ...mutatingTool("Start AI Review"),
            description:
                "Start a platform AI review of a branch's translations as a background job: each key × language pair gets a " +
                "score and findings (accuracy, fluency, terminology, style, length, placeholders). Findings are warnings at " +
                "most and never block a merge. Professional plan or higher, billed on its own AI review quota by the " +
                "characters of target text reviewed – so scope it with `keys` / `langs` when you can. Needs the developer " +
                "role. Poll ai_review_status; the findings then appear in get_qa_issues with source \"ai\". Errors: " +
                "feature_not_available (plan), ai_review_quota_exceeded, ai_review_in_progress. Reviews the token's base " +
                "branch unless `branch` names another allowed branch.",
            inputSchema: {
                branch: branchArg(),
                keys: z.array(z.string().min(1)).optional().describe("Only review these keys."),
                langs: z.array(z.string().min(1)).optional().describe("Only review these target languages."),
            },
        },
        async (args) =>
            run(async () => {
                const job = await session.client.startAiReview({ branch: args.branch, keys: args.keys, langs: args.langs });
                return { ...job, next: "Poll ai_review_status until the job is completed, then read get_qa_issues with source \"ai\"." };
            }),
    );

    server.registerTool(
        "ai_review_status",
        {
            ...readOnlyTool("AI Review Status"),
            description:
                "Report the project's latest AI review job: status (queued / running / completed / failed), its branch, " +
                "progress counts (total, reviewed, failed, issues found) and the characters billed. Returns job: null when " +
                "no review has run. Takes no arguments.",
            inputSchema: {},
        },
        async () => run(async () => session.client.aiReviewStatus()),
    );

    // ------------------------------------------------------------------------
    // Delivery (OTA)
    // ------------------------------------------------------------------------

    server.registerTool(
        "list_distributions",
        {
            ...readOnlyTool("List OTA Distributions"),
            description:
                "List the project's over-the-air delivery distributions: id, name, the branch each one publishes, its " +
                "format, whether it publishes all values or approved labels only, its status, the latest published " +
                "version and the public manifest URL apps load strings from. Only distributions on branches this token may use " +
                "are listed. Takes no arguments.",
            inputSchema: {},
        },
        async () => run(async () => session.client.listDistributions()),
    );

    server.registerTool(
        "publish_release",
        {
            ...destructiveTool("Publish OTA Release"),
            description:
                "Publish a distribution's branch to the CDN as a new version. Live apps using the Translatize OTA SDK pick " +
                "it up on their next refresh, so this changes what end users see, and everything published is PUBLIC. " +
                "Only call it when the user has explicitly asked to publish, and pass confirm: true – without it nothing " +
                "is published. Needs the developer role, and the distribution's branch must be in the token's allowed set " +
                "(otherwise branch_not_allowed). Get the id from list_distributions.",
            inputSchema: {
                distribution_id: z.string().min(1).describe("The distribution id from list_distributions."),
                confirm: z
                    .boolean()
                    .describe("Must be true: confirms the user explicitly asked to publish this release to end users."),
            },
        },
        async (args) => {
            if (args.confirm !== true) {
                return fail(
                    "Not published: publish_release needs confirm: true. Ask the user to confirm that this distribution " +
                        "should go live for end users, then call it again with confirm: true.",
                );
            }
            return run(async () => {
                const { release, manifestUrl } = await session.client.publishRelease(args.distribution_id);
                return {
                    published: true,
                    version: release.version,
                    labelCount: release.labelCount,
                    languages: Object.keys(release.languages ?? {}),
                    manifestUrl,
                };
            });
        },
    );
}
