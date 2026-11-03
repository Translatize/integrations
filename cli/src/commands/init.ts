import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TranslatizeClient, TranslatizeApiError } from "@translatize/core";
import {
    DEFAULT_API_URL,
    DEFAULT_CONFIG_PATH,
    DEFAULT_FILES,
    DEFAULT_FORMAT,
    UsageError,
    optionalToken,
    serializeConfig,
    validateConfig,
} from "../config.js";
import { writeAgentFiles } from "../agents.js";
import { createColors, describeApiError, info, type Colors } from "../ui.js";
import type { GlobalOpts } from "./shared.js";

export interface InitOpts extends GlobalOpts {
    projectId?: string;
    files?: string;
    format?: string;
    force?: boolean;
    agents?: boolean;
}

/** `translatize init` – scaffold translatize.config.json, validating the token when available. */
export async function initCommand(opts: InitOpts): Promise<number> {
    const colors = createColors();
    const configPath = opts.config ?? DEFAULT_CONFIG_PATH;
    const abs = resolve(configPath);

    if (opts.agents) {
        return initAgents(colors, dirname(abs));
    }

    const exists = existsSync(abs);
    if (exists && !opts.force) {
        throw new UsageError(`${configPath} already exists. Re-run with --force to overwrite it.`);
    }

    // `--force` rewrites the file from these flags; keep any top-level keys this
    // CLI version does not know about (e.g. the GitHub App's "github" block) so
    // rewriting the config does not silently drop another tool's settings.
    let extra: Record<string, unknown> | undefined;
    if (exists) {
        try {
            extra = validateConfig(JSON.parse(readFileSync(abs, "utf8")), configPath).extra;
        } catch {
            // Existing file is unreadable or invalid – nothing to carry forward.
        }
    }

    const format = opts.format ?? DEFAULT_FORMAT;
    if (format !== "json-nested" && format !== "json-flat") {
        throw new UsageError(`--format must be "json-nested" or "json-flat", got "${format}"`);
    }
    const files = opts.files ?? DEFAULT_FILES;
    if (!files.includes("{lang}")) {
        throw new UsageError(`--files must contain the {lang} placeholder, e.g. "locales/{lang}.json"`);
    }

    const apiUrl = (opts.apiUrl ?? "").trim() || DEFAULT_API_URL;
    let projectId = (opts.projectId ?? "").trim();

    // If a token is available, validate it against /me and enrich the config.
    const token = optionalToken(opts.token);
    if (token) {
        try {
            const me = await new TranslatizeClient({ apiUrl, token }).me();
            if (!projectId) {
                projectId = me.project.id;
            } else if (projectId !== me.project.id) {
                info(colors.yellow(`warning: --project-id "${projectId}" does not match the token's project "${me.project.id}".`));
            }
            info(colors.green("Token verified.") + ` Project "${colors.bold(me.project.name)}" (${me.project.id})`);
            info(`  bound branch: ${colors.bold(me.branch)}`);
            info(`  role:         ${me.role}`);
            info(`  languages:    ${me.project.langs.join(", ") || "(none configured)"}`);
            info("");
        } catch (err) {
            if (err instanceof TranslatizeApiError) {
                info(colors.yellow("warning: could not verify the token: ") + describeApiError(err));
                info(colors.yellow("Writing the config anyway; fix the token and re-run to verify."));
                info("");
            } else {
                throw err;
            }
        }
    }

    const config = validateConfig({ apiUrl, projectId, format, files, ...extra }, "init");
    writeFileSync(abs, serializeConfig(config), "utf8");
    info(colors.green("Wrote ") + configPath);

    info("");
    info(colors.bold("Next steps:"));
    if (!token) {
        info("  1. Create a branch-bound API token: Project Settings -> Integrations at https://app.translatize.com");
        info("  2. export TRANSLATIZE_API_TOKEN=mcni_...");
        info("  3. translatize pull");
    } else {
        info("  1. Review translatize.config.json (especially the `files` pattern).");
        info("  2. translatize pull    # download translations");
        info("  3. translatize status  # compare local files with Translatize");
    }
    if (!projectId) {
        info("");
        info(
            colors.dim(
                'Note: projectId is empty – it will be derived from your token at runtime. ' +
                    "Set it in the config to pin the project.",
            ),
        );
    }
    return 0;
}

/**
 * `translatize init --agents` – write the coding-agent rules into AGENTS.md (and
 * CLAUDE.md when the project has one), next to the config file. Leaves the config
 * alone, so it can be re-run at any time to refresh the section.
 */
function initAgents(colors: Colors, dir: string): number {
    const results = writeAgentFiles(dir);
    for (const { file, action } of results) {
        const verb =
            action === "created" ? "Created" : action === "appended" ? "Added the Translatize section to" : action === "updated" ? "Updated the Translatize section in" : "Already up to date:";
        info(`${action === "unchanged" ? colors.dim(verb) : colors.green(verb)} ${file}`);
    }
    if (!results.some((r) => r.file === "CLAUDE.md")) {
        info(colors.dim("No CLAUDE.md here. For Claude Code, add a CLAUDE.md with the line @AGENTS.md, or install the Translatize plugin."));
    }
    info("");
    info("Coding agents now get the Translatize rules: no hardcoded strings, keys with context, branches and QA before merge.");
    info(`Connect them to the Translatize MCP server: ${colors.bold("claude mcp add translatize -e TRANSLATIZE_API_TOKEN=mcni_xxx -- npx -y @translatize/mcp")}`);
    return 0;
}
