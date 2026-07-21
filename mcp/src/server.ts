import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TranslatizeClient } from "@translatize/core";
import type { ResolvedConfig } from "./config.js";
import { Session } from "./session.js";
import { registerTools } from "./tools.js";

export const SERVER_NAME = "translatize";
export const SERVER_VERSION = "0.1.2";

const INSTRUCTIONS =
    "Tools for the Translatize translation-management system. The API token is bound to exactly one project and one " +
    "base branch. Call get_project_info first to learn the project, base branch, configured languages and branch scope. " +
    "Read with list_labels/search_labels/get_labels, write with upsert_label/upsert_labels, and find gaps with " +
    "translation_status / get_missing_translations. A `create-own` scoped token can also branch: create_branch, work on " +
    "the new branch (pass its name as `branch`), then compare_with_base / get_merge_conflicts, and merge_branch back into " +
    "the base. Recommended agentic flow: create_branch -> add/edit keys on it -> translate (do it yourself from " +
    "get_missing_translations, or trigger platform AI with auto_translate) -> set_labels_status to mark them reviewed -> " +
    "review_changes and ASK THE USER whether to review in-conversation or on the platform, and to approve the merge -> " +
    "merge_branch -> delete_branch. Never merge without the user's go-ahead.";

/**
 * Build the MCP server from `config`. No network I/O happens here — the session caches
 * `/me` lazily, so the server can answer `initialize` and `tools/list` before the first API call.
 */
export function createServer(config: ResolvedConfig): McpServer {
    const client = new TranslatizeClient({ apiUrl: config.apiUrl, token: config.apiToken });
    const session = new Session(client, config.appUrl);
    const server = new McpServer(
        { name: SERVER_NAME, version: SERVER_VERSION },
        { instructions: INSTRUCTIONS },
    );
    registerTools(server, session);
    return server;
}
