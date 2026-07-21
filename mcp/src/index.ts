#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

/**
 * Start the stdio MCP server. The JSON-RPC protocol owns stdout, so all diagnostics go to
 * stderr — never write to stdout outside the transport.
 */
async function main(): Promise<void> {
    const config = loadConfig();
    const server = createServer(config);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    // `connect` keeps the process alive by listening on stdin; nothing else to do here.
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`translatize-mcp: ${message}\n`);
    process.exit(1);
});
