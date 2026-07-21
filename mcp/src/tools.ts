import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { TranslatizeApiError } from "@translatize/core";
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
                "configured languages, the base branch the API token is bound to, the token's role, the branch scope " +
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
                    project: { id: me.project.id, name: me.project.name, languages: me.project.langs },
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
                "one. Writes to the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                key: z.string().min(1).describe('The dotted label key, e.g. "checkout.pay_button".'),
                values: z
                    .record(z.string(), z.string())
                    .optional()
                    .describe("Per-language values as { languageCode: string }; only configured languages are allowed."),
                status: z.string().optional().describe("Optional status string to set on the label."),
                tags: z.array(z.string()).optional().describe("Optional tags to set on the label."),
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
                };
            }),
    );

    server.registerTool(
        "upsert_labels",
        {
            ...mutatingTool("Create or Update Labels (Batch)"),
            description:
                "Create or update many labels on a branch in one call (batched automatically, with no client-side " +
                "size limit). Pass labels as an array of { key, values?, status?, tags? }. Returns counts of created " +
                "and updated labels plus a failed list of any individual items the server rejected (for example, an " +
                "unknown language on one item). Use this instead of repeated upsert_label calls when writing more than " +
                "a couple of keys. Writes to the token's base branch unless `branch` names another allowed branch.",
            inputSchema: {
                labels: z
                    .array(
                        z.object({
                            key: z.string().min(1),
                            values: z.record(z.string(), z.string()).optional(),
                            status: z.string().optional(),
                            tags: z.array(z.string()).optional(),
                        }),
                    )
                    .min(1)
                    .describe("The labels to create or update (at least one)."),
                branch: branchArg(),
            },
        },
        async (args) =>
            run(async () => {
                const result = await session.client.upsertLabels(args.labels, { branch: args.branch });
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
                "get_merge_conflicts), and replace (DESTRUCTIVE: the base becomes an exact copy of the source; use only " +
                "when the user explicitly asks to replace). Only merge after the user has reviewed and approved the changes.",
            inputSchema: {
                branch: z.string().min(1).describe("The branch to merge into the base (must be one this token created)."),
                strategy: z
                    .enum(["overwrite", "replace", "keep-newer", "manual"])
                    .optional()
                    .describe("Merge strategy (default overwrite). Use replace only when explicitly told; it is destructive."),
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
                "language is the project's first configured language. Optionally restrict to specific `languages` and " +
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
                const sourceLang = langs[0];
                const requested = args.languages && args.languages.length > 0 ? args.languages : langs.slice(1);
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
                "AI quota. Optionally scope to specific target_languages (defaults to every project language except " +
                "the source), specific label_keys, and set overwrite_translated to re-translate values that already " +
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
                let targetLangs = args.target_languages;
                if (!targetLangs || targetLangs.length === 0) {
                    const me = await session.me();
                    targetLangs = me.project.langs.slice(1);
                }
                if (targetLangs.length === 0) {
                    return {
                        started: false,
                        nothingToTranslate: true,
                        reason: "no_target_languages",
                        note: "The project has only one language, so there is nothing to auto-translate into.",
                    };
                }
                return session.client.autoTranslate({
                    branch: args.branch,
                    targetLangs,
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
}
