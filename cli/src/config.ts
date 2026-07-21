import { readFileSync } from "node:fs";

/** The two on-disk shapes the CLI reads and writes. */
export type TranslationFormat = "json-nested" | "json-flat";

/** Parsed and validated `translatize.config.json`. Never contains the token. */
export interface TranslatizeConfig {
    apiUrl: string;
    projectId: string;
    format: TranslationFormat;
    /** File pattern with a `{lang}` placeholder, e.g. `locales/{lang}.json`. */
    files: string;
    namespace?: string;
    /**
     * Default branch for pull/push/status. Must be in the token's allowed set. When
     * absent, commands operate on the token's bound branch. Overridden by `--branch`.
     */
    branch?: string;
}

export const DEFAULT_CONFIG_PATH = "translatize.config.json";
export const DEFAULT_API_URL = "https://api.translatize.com/v1";
export const DEFAULT_FILES = "locales/{lang}.json";
export const DEFAULT_FORMAT: TranslationFormat = "json-nested";
export const TOKEN_ENV_VAR = "TRANSLATIZE_API_TOKEN";

/**
 * A problem with the user's input – bad flags, an invalid or missing config, a
 * malformed local file, or a missing token. Maps to process exit code 2.
 */
export class UsageError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "UsageError";
    }
}

/** A specifically config-file-shaped {@link UsageError}. */
export class ConfigError extends UsageError {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate a parsed config object, filling defaults. Throws {@link ConfigError}
 * (with `source` in the message) for any invalid field.
 */
export function validateConfig(raw: unknown, source = "config"): TranslatizeConfig {
    if (!isRecord(raw)) {
        throw new ConfigError(`${source}: expected a JSON object`);
    }

    let apiUrl = DEFAULT_API_URL;
    if (raw.apiUrl !== undefined) {
        if (typeof raw.apiUrl !== "string" || raw.apiUrl.trim() === "") {
            throw new ConfigError(`${source}: "apiUrl" must be a non-empty string`);
        }
        apiUrl = raw.apiUrl.trim();
    }

    let projectId = "";
    if (raw.projectId !== undefined && raw.projectId !== null) {
        if (typeof raw.projectId !== "string") {
            throw new ConfigError(`${source}: "projectId" must be a string`);
        }
        projectId = raw.projectId.trim();
    }

    if (raw.format === undefined) {
        throw new ConfigError(`${source}: "format" is required (one of "json-nested", "json-flat")`);
    }
    if (raw.format !== "json-nested" && raw.format !== "json-flat") {
        throw new ConfigError(`${source}: "format" must be "json-nested" or "json-flat", got ${JSON.stringify(raw.format)}`);
    }
    const format = raw.format;

    if (raw.files === undefined) {
        throw new ConfigError(`${source}: "files" is required (e.g. "locales/{lang}.json")`);
    }
    if (typeof raw.files !== "string" || raw.files.trim() === "") {
        throw new ConfigError(`${source}: "files" must be a non-empty string`);
    }
    if (!raw.files.includes("{lang}")) {
        throw new ConfigError(`${source}: "files" must contain the {lang} placeholder, e.g. "locales/{lang}.json"`);
    }
    const files = raw.files;

    let namespace: string | undefined;
    if (raw.namespace !== undefined && raw.namespace !== null) {
        if (typeof raw.namespace !== "string") {
            throw new ConfigError(`${source}: "namespace" must be a string`);
        }
        if (raw.namespace.trim() !== "") {
            namespace = raw.namespace.trim();
        }
    }

    let branch: string | undefined;
    if (raw.branch !== undefined && raw.branch !== null) {
        if (typeof raw.branch !== "string") {
            throw new ConfigError(`${source}: "branch" must be a string`);
        }
        if (raw.branch.trim() !== "") {
            branch = raw.branch.trim();
        }
    }

    return { apiUrl, projectId, format, files, namespace, branch };
}

/** Read, JSON-parse and validate a config file. Throws {@link ConfigError} on any failure. */
export function loadConfig(configPath: string): TranslatizeConfig {
    let text: string;
    try {
        text = readFileSync(configPath, "utf8");
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            throw new ConfigError(`Config file not found: ${configPath}\nRun "translatize init" to create one.`);
        }
        throw new ConfigError(`Could not read config file ${configPath}: ${(err as Error).message}`);
    }
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (err) {
        throw new ConfigError(`Config file ${configPath} is not valid JSON: ${(err as Error).message}`);
    }
    return validateConfig(raw, configPath);
}

/** Serialize a config back to the canonical committed form (stable key order, trailing newline). */
export function serializeConfig(config: TranslatizeConfig): string {
    const ordered: Record<string, unknown> = {
        apiUrl: config.apiUrl,
        projectId: config.projectId,
        format: config.format,
        files: config.files,
    };
    if (config.namespace !== undefined) {
        ordered.namespace = config.namespace;
    }
    if (config.branch !== undefined) {
        ordered.branch = config.branch;
    }
    return JSON.stringify(ordered, null, 2) + "\n";
}

/**
 * Resolve the API token: `--token` flag beats the `TRANSLATIZE_API_TOKEN` env var.
 * Throws {@link UsageError} naming both when neither is present.
 */
export function resolveToken(flagToken: string | undefined, env: NodeJS.ProcessEnv = process.env): string {
    const fromFlag = typeof flagToken === "string" ? flagToken.trim() : "";
    if (fromFlag !== "") {
        return fromFlag;
    }
    const fromEnv = (env[TOKEN_ENV_VAR] ?? "").trim();
    if (fromEnv !== "") {
        return fromEnv;
    }
    throw new UsageError(
        `No API token found. Pass --token <mcni_...> or set the ${TOKEN_ENV_VAR} environment variable.\n` +
            "Create a branch-bound token under Project Settings -> Integrations at https://app.translatize.com.",
    );
}

/** Like {@link resolveToken} but returns `undefined` instead of throwing when absent. */
export function optionalToken(flagToken: string | undefined, env: NodeJS.ProcessEnv = process.env): string | undefined {
    try {
        return resolveToken(flagToken, env);
    } catch {
        return undefined;
    }
}

/** The effective API URL: `--api-url` flag beats the config value beats the built-in default. */
export function resolveApiUrl(config: Pick<TranslatizeConfig, "apiUrl">, flagApiUrl?: string): string {
    const fromFlag = typeof flagApiUrl === "string" ? flagApiUrl.trim() : "";
    if (fromFlag !== "") {
        return fromFlag;
    }
    return config.apiUrl || DEFAULT_API_URL;
}

/**
 * The effective branch: `--branch` flag beats the config `branch` field beats
 * `undefined` (in which case commands operate on the token's bound branch).
 */
export function resolveBranch(config: Pick<TranslatizeConfig, "branch">, flagBranch?: string): string | undefined {
    const fromFlag = typeof flagBranch === "string" ? flagBranch.trim() : "";
    if (fromFlag !== "") {
        return fromFlag;
    }
    const fromConfig = typeof config.branch === "string" ? config.branch.trim() : "";
    return fromConfig !== "" ? fromConfig : undefined;
}
