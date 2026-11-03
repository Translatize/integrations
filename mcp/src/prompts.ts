import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { GetPromptResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

/** Split a prompt argument like "lv, de fr" into language codes. Prompt arguments are always strings. */
export function parseLanguages(value: string | undefined): string[] {
    return (value ?? "")
        .split(/[\s,;]+/)
        .map((lang) => lang.trim())
        .filter((lang) => lang !== "");
}

function userMessage(description: string, text: string): GetPromptResult {
    return { description, messages: [{ role: "user", content: { type: "text", text } }] };
}

/**
 * The full "localize this repo" workflow – the same ten steps as the Claude Code
 * plugin's localize-repo skill (FR-4.7). Keep the two in step.
 */
export function localizeRepoPrompt(args: { target_languages: string; path?: string }): GetPromptResult {
    const langs = parseLanguages(args.target_languages);
    const langList = langs.length > 0 ? langs.join(", ") : "(ask me which languages)";
    const scope = args.path && args.path.trim() !== "" ? `the code under \`${args.path.trim()}\`` : "this repository";
    const text = [
        `Localize ${scope} with Translatize. Target languages: ${langList}.`,
        "",
        "Call get_project_info first to learn the project, its languages and the token's branch scope. Then follow these steps in order:",
        "",
        "1. Detect the framework and i18n library (react-i18next, next-intl, vue-i18n, Angular, Svelte, iOS strings, Android XML, Flutter ARB). If none is set up, propose a setup and wait for my approval.",
        "2. Find hardcoded user-visible strings. Exclude logs, test files, enum values, CSS classes, URLs and analytics event names.",
        "3. Propose dotted key names grouped by feature or component, e.g. `checkout.payment.submit_button`. Check existing keys with search_labels and reuse one only when the meaning is the same.",
        "4. Call create_branch named `agent-<topic>` (letters, digits, `-` and `_` only). Pass that name as `branch` in every later call.",
        "5. Upsert the source labels with upsert_labels, **with context**: `description` says which UI element and where; `charLimit` only when the UI clearly constrains it; `location` = `path:line`; `doNotTranslate: true` for product names, brands and codes that must stay the same in every language.",
        "6. Replace the strings in code with the library's lookup call.",
        `7. Run auto_translate for the target languages (${langList}) and follow it with translation_job_status. If the plan has no platform AI (feature_not_available), translate yourself: get_missing_translations, get_glossary and find_translation_memory, then upsert_labels.`,
        "8. Call run_qa on the branch, then fix the errors (rewrite the source or adjust placeholders) and run it again until no errors are left.",
        "9. Call check_merge_gate for the branch.",
        "10. Summarise for me: files changed, keys created, languages translated, the QA result, the gate verdict and the review_changes link. **Never merge into `main` without my explicit approval.**",
    ].join("\n");
    return userMessage(`Localize ${scope} into ${langList} with Translatize`, text);
}

/** Run QA on a branch, fix its errors and report the merge gate – without merging. */
export function prepareBranchForMergePrompt(args: { branch: string }): GetPromptResult {
    const branch = args.branch.trim();
    const text = [
        `Prepare the Translatize branch "${branch}" for merging into the token's base branch.`,
        "",
        `1. Call run_qa with branch "${branch}".`,
        `2. Fix every error on that branch with upsert_labels (branch "${branch}"): rewrite the translation or the source text, or adjust its placeholders. For glossary errors, check get_glossary.`,
        "3. Call run_qa again and repeat until no errors are left. List the warnings you chose to leave and why.",
        `4. Call check_merge_gate for "${branch}" and report the gate: mode, whether it applies, blocked or not, and the remaining errors and warnings.`,
        `5. Call review_changes for "${branch}" and summarise what the merge would change, with the platform link.`,
        "",
        "Do not call merge_branch – ask me first. Merging into main needs an admin-role token; if this token is not one, I merge in the web app.",
    ].join("\n");
    return userMessage(`Run QA on "${branch}", fix the errors and report the merge gate`, text);
}

/** Register the workflow prompts (FR-4.6). */
export function registerPrompts(server: McpServer): void {
    server.registerPrompt(
        "localize_repo",
        {
            title: "Localize Repository",
            description:
                "Move a repository's hardcoded UI strings into Translatize on a new branch – keys with context, AI " +
                "translation, QA – and stop for approval before merging.",
            argsSchema: {
                target_languages: z.string().min(1).describe('Languages to translate into, comma-separated, e.g. "lv, de".'),
                path: z.string().optional().describe("Only localize code under this path (defaults to the whole repository)."),
            },
        },
        (args) => localizeRepoPrompt(args),
    );

    server.registerPrompt(
        "prepare_branch_for_merge",
        {
            title: "Prepare Branch for Merge",
            description: "Run QA on a Translatize branch, fix the errors and report the merge gate, without merging.",
            argsSchema: {
                branch: z.string().min(1).describe("The Translatize branch to prepare."),
            },
        },
        (args) => prepareBranchForMergePrompt(args),
    );
}
