import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { TranslatizeClient, type MeResponse } from "@translatize/core";
import {
    DEFAULT_API_URL,
    DEFAULT_CONFIG_PATH,
    loadConfig,
    resolveApiUrl,
    resolveBranch,
    resolveToken,
    type TranslatizeConfig,
} from "../config.js";
import { warn, type Colors } from "../ui.js";

/** Options present on every command (the global flags). */
export interface GlobalOpts {
    config?: string;
    token?: string;
    apiUrl?: string;
    /** `--branch` – registered on every command except init. */
    branch?: string;
}

/** Everything a network command needs, resolved from flags + config. */
export interface CommandContext {
    config: TranslatizeConfig;
    client: TranslatizeClient;
    apiUrl: string;
    /** Directory that `files` patterns resolve against (the config file's directory). */
    baseDir: string;
    configPath: string;
    /** Resolved target branch (flag > config `branch` > token default). `undefined` = the token's bound branch. */
    branch?: string;
}

/** Load config, resolve the token + API URL + branch, and construct a client. */
export function buildContext(opts: GlobalOpts): CommandContext {
    const configPath = opts.config ?? DEFAULT_CONFIG_PATH;
    const config = loadConfig(configPath);
    const apiUrl = resolveApiUrl(config, opts.apiUrl);
    const token = resolveToken(opts.token);
    const client = new TranslatizeClient({ apiUrl, token });
    const baseDir = dirname(resolve(configPath));
    const branch = resolveBranch(config, opts.branch);
    return { config, client, apiUrl, baseDir, configPath, branch };
}

/** What the API-only commands (qa, screenshots, release) need. They work without a config file. */
export interface ApiContext {
    client: TranslatizeClient;
    apiUrl: string;
    /** `undefined` when no config file exists. */
    config?: TranslatizeConfig;
    /** Directory of the config file, or the working directory without one. */
    baseDir: string;
    /** Resolved branch (flag > config `branch` > token default). `undefined` = the token's bound branch. */
    branch?: string;
}

/**
 * Like {@link buildContext}, but the config file is optional: the default
 * `translatize.config.json` may be absent (apiUrl and branch then come from flags
 * and defaults). A config path given with `--config` must exist.
 */
export function buildApiContext(opts: GlobalOpts): ApiContext {
    const configPath = opts.config ?? DEFAULT_CONFIG_PATH;
    const useConfig = configPath !== DEFAULT_CONFIG_PATH || existsSync(resolve(configPath));
    const config = useConfig ? loadConfig(configPath) : undefined;
    const apiUrl = resolveApiUrl(config ?? { apiUrl: DEFAULT_API_URL }, opts.apiUrl);
    const token = resolveToken(opts.token);
    const client = new TranslatizeClient({ apiUrl, token });
    const baseDir = config ? dirname(resolve(configPath)) : process.cwd();
    const branch = resolveBranch(config ?? {}, opts.branch);
    return { client, apiUrl, config, baseDir, branch };
}

/** The `listLabels` filter for a command: the configured namespace plus the resolved branch (each omitted when absent). */
export function listOptions(ctx: CommandContext): { namespace?: string; branch?: string } {
    const opts: { namespace?: string; branch?: string } = {};
    if (ctx.config.namespace) {
        opts.namespace = ctx.config.namespace;
    }
    if (ctx.branch) {
        opts.branch = ctx.branch;
    }
    return opts;
}

/** Warn (non-fatally) when the configured projectId disagrees with the token's project. */
export function warnOnProjectMismatch(colors: Colors, config: TranslatizeConfig, me: MeResponse): void {
    if (config.projectId && config.projectId !== me.project.id) {
        warn(
            colors,
            `config projectId "${config.projectId}" does not match the token's project ` +
                `"${me.project.id}" (${me.project.name}); using the token's project.`,
        );
    }
}
