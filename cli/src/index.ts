#!/usr/bin/env node
import { Command, CommanderError } from "commander";
import { DEFAULT_CONFIG_PATH } from "./config.js";
import { createColors, reportError } from "./ui.js";
import { initCommand, type InitOpts } from "./commands/init.js";
import { pullCommand, type PullOpts } from "./commands/pull.js";
import { pushCommand, type PushOpts } from "./commands/push.js";
import { statusCommand, type StatusOpts } from "./commands/status.js";

const VERSION = "0.1.0";

/** Attach the flags every command accepts. */
function withGlobals(cmd: Command): Command {
    return cmd
        .option("-c, --config <path>", "path to the config file", DEFAULT_CONFIG_PATH)
        .option("--token <token>", `API token (overrides the TRANSLATIZE_API_TOKEN env var)`)
        .option("--api-url <url>", "override the API base URL from the config");
}

/** Run a command body, mapping thrown errors to a process exit code. */
async function run(fn: () => Promise<number>): Promise<void> {
    try {
        process.exitCode = await fn();
    } catch (err) {
        process.exitCode = reportError(err, createColors());
    }
}

function build(): Command {
    const program = new Command();
    program
        .name("translatize")
        .description("Translation management with git-like branching – sync your app's translations from CI.")
        .version(VERSION, "-v, --version")
        .exitOverride();

    withGlobals(program.command("init"))
        .description("Create translatize.config.json (validates the token via /me when available)")
        .option("--project-id <id>", "project id to record in the config")
        .option("--files <pattern>", "file pattern with a {lang} placeholder (default locales/{lang}.json)")
        .option("--format <format>", "on-disk format: json-nested or json-flat (default json-nested)")
        .option("--force", "overwrite an existing config file")
        .action((opts: InitOpts) => run(() => initCommand(opts)));

    withGlobals(program.command("pull"))
        .description("Download the branch and write one file per language")
        .option("--branch <name>", "branch to operate on (overrides the config \"branch\" field and the token's default branch)")
        .option("--dry-run", "report what would change without writing files")
        .option("--json", "emit machine-readable JSON")
        .action((opts: PullOpts) => run(() => pullCommand(opts)));

    withGlobals(program.command("push"))
        .description("Upload new and changed local keys to the branch (never deletes remote keys)")
        .option("--branch <name>", "branch to operate on (overrides the config \"branch\" field and the token's default branch)")
        .option("--dry-run", "report what would be sent without sending")
        .option("--json", "emit machine-readable JSON")
        .action((opts: PushOpts) => run(() => pushCommand(opts)));

    withGlobals(program.command("status"))
        .description("Compare local files with the branch (the CI gate)")
        .option("--branch <name>", "branch to operate on (overrides the config \"branch\" field and the token's default branch)")
        .option("--fail-on-missing", "exit 1 if any language has missing translations")
        .option("--fail-on-diff", "exit 1 if local differs from the branch at all")
        .option("--json", "emit machine-readable JSON")
        .action((opts: StatusOpts) => run(() => statusCommand(opts)));

    return program;
}

async function main(): Promise<void> {
    const program = build();

    if (process.argv.slice(2).length === 0) {
        program.outputHelp();
        process.exitCode = 0;
        return;
    }

    try {
        await program.parseAsync(process.argv);
    } catch (err) {
        // exitOverride() turns commander's own exits into throws so we can pick the code.
        if (err instanceof CommanderError) {
            const zero = err.code === "commander.helpDisplayed" || err.code === "commander.version" || err.code === "commander.help";
            process.exitCode = zero ? 0 : 2;
            return;
        }
        throw err;
    }
}

void main();
