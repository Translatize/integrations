import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TranslatizeClient } from "@translatize/core";
import type { ResolvedConfig } from "./config.js";
import { Session } from "./session.js";
import { registerTools } from "./tools.js";
import { registerPrompts } from "./prompts.js";

export const SERVER_NAME = "translatize";
export const SERVER_VERSION = "0.2.0";

const INSTRUCTIONS =
    "Tools for the Translatize translation-management system. The API token is bound to exactly one project and one " +
    "base branch. Call get_project_info first to learn the project, base branch, configured languages, source language and branch scope. " +
    "Read with list_labels/search_labels/get_labels, write with upsert_label/upsert_labels, and find gaps with " +
    "translation_status / get_missing_translations. Give every key you create its context – a description of the UI " +
    "element and where it appears, a charLimit when the UI limits the length, and location as path:line – either as " +
    "`context` in upsert_labels or afterwards with set_label_context. For consistent wording, check get_glossary and " +
    "find_translation_memory before translating yourself. A `create-own` scoped token can also branch: create_branch, " +
    "work on the new branch (pass its name as `branch`), then compare_with_base / get_merge_conflicts, and merge_branch " +
    "back into the base. Recommended agentic flow: create_branch -> add/edit keys with context on it -> translate (do it " +
    "yourself from get_missing_translations, or trigger platform AI with auto_translate) -> QA loop: run_qa on the " +
    "branch, fix every error (rewrite the value or fix its placeholders), run_qa again until no errors are left -> " +
    "check_merge_gate (merge_branch is refused with qa_gate_blocked while the gate blocks; tokens cannot override it) -> " +
    "set_labels_status to mark them reviewed -> review_changes and ASK THE USER whether to review in-conversation or on " +
    "the platform, and to approve the merge -> merge_branch -> delete_branch. Merging into main needs an admin-role " +
    "token. Optional: start_ai_review + ai_review_status for an AI quality review (Professional plan, own quota), and " +
    "list_distributions / publish_release for over-the-air delivery (publishing is public and needs confirm: true and " +
    "the user's explicit request). Never merge or publish without the user's go-ahead. The prompts localize_repo and " +
    "prepare_branch_for_merge walk through the full workflows.";

/**
 * Build the MCP server from `config`. No network I/O happens here – the session caches
 * `/me` lazily, so the server can answer `initialize`, `tools/list` and `prompts/list` before the first API call.
 */
export function createServer(config: ResolvedConfig): McpServer {
    const client = new TranslatizeClient({ apiUrl: config.apiUrl, token: config.apiToken });
    const session = new Session(client, config.appUrl);
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: INSTRUCTIONS },
    );
    registerTools(server, session);
    registerPrompts(server);
    return server;
}
