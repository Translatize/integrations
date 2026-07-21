/** Environment variable holding the Translatize integration API token (an `mcni_…` string). */
export const TOKEN_ENV_VAR = "TRANSLATIZE_API_TOKEN";
/** Environment variable overriding the API base URL. */
export const API_URL_ENV_VAR = "TRANSLATIZE_API_URL";
/** Environment variable overriding the human-facing web app URL (used to build review links). */
export const APP_URL_ENV_VAR = "TRANSLATIZE_APP_URL";
/** Default API base URL (includes the `/v1` version segment). */
export const DEFAULT_API_URL = "https://api.translatize.com/v1";
/** Default web app URL — where a human opens a project/branch to review changes. */
export const DEFAULT_APP_URL = "https://app.translatize.com";

/** Resolved server configuration derived entirely from the environment. */
export interface ResolvedConfig {
    apiToken: string;
    apiUrl: string;
    /** Base URL of the Translatize web app, used to build `platformUrl` review links (no trailing slash). */
    appUrl: string;
}

/**
 * Thrown when required configuration is missing or invalid. The entry point prints
 * `.message` to stderr and exits non-zero.
 */
export class ConfigError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

/**
 * Read the token and API URL from the environment. Throws {@link ConfigError} with an
 * actionable message when the token is absent — the server cannot run without one.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ResolvedConfig {
    const apiToken = (env[TOKEN_ENV_VAR] ?? "").trim();
    if (apiToken === "") {
        throw new ConfigError(
            `${TOKEN_ENV_VAR} is not set. Set it to a Translatize integration API token (an "mcni_..." string). ` +
                "Create a branch-bound token under Project Settings -> Integrations at https://app.translatize.com.",
        );
    }
    const apiUrl = (env[API_URL_ENV_VAR] ?? "").trim() || DEFAULT_API_URL;
    const appUrl = ((env[APP_URL_ENV_VAR] ?? "").trim() || DEFAULT_APP_URL).replace(/\/+$/, "");
    return { apiToken, apiUrl, appUrl };
}
