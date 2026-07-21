import pc from "picocolors";
import { TranslatizeApiError } from "@translatize/core";
import { UsageError } from "./config.js";

export type Colors = ReturnType<typeof pc.createColors>;

/** Colors are on only for an interactive stdout with NO_COLOR unset. */
export function colorEnabled(): boolean {
    return Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
}

export function createColors(): Colors {
    return pc.createColors(colorEnabled());
}

/** Write a machine-readable JSON document to stdout (stable two-space indent). */
export function printJson(value: unknown): void {
    process.stdout.write(JSON.stringify(value, null, 2) + "\n");
}

export function info(line = ""): void {
    process.stdout.write(line + "\n");
}

export function warn(colors: Colors, line: string): void {
    process.stderr.write(colors.yellow(`warning: ${line}`) + "\n");
}

/** Render an aligned, left-justified table. `head` is styled dim; columns pad to their widest cell. */
export function table(colors: Colors, head: string[], rows: string[][]): string {
    const widths = head.map((header, columnIndex) => Math.max(header.length, ...rows.map((row) => (row[columnIndex] ?? "").length)));
    const pad = (cell: string, columnIndex: number): string => cell.padEnd(widths[columnIndex]);
    const lines: string[] = [];
    lines.push("  " + colors.dim(head.map(pad).join("  ").trimEnd()));
    for (const row of rows) {
        lines.push("  " + row.map(pad).join("  ").trimEnd());
    }
    return lines.join("\n");
}

/** Up to `limit` keys, comma-joined, with an "and N more" suffix when truncated. */
export function sampleKeys(keys: string[], limit = 10): string {
    if (keys.length === 0) {
        return "";
    }
    const shown = keys.slice(0, limit).join(", ");
    return keys.length > limit ? `${shown}, and ${keys.length - limit} more` : shown;
}

/**
 * Turn a {@link TranslatizeApiError} into an actionable, human sentence. The raw
 * `code` is appended in parentheses so logs stay greppable.
 */
export function describeApiError(err: TranslatizeApiError): string {
    const code = err.code;
    let hint: string;
    switch (code) {
        case "branch_not_allowed": {
            const details = err.details;
            const bound = typeof details?.boundBranch === "string" ? details.boundBranch : undefined;
            const allowed =
                details && Array.isArray(details.allowedBranches)
                    ? (details.allowedBranches as unknown[]).filter((branch): branch is string => typeof branch === "string")
                    : [];
            const allowedPart =
                allowed.length > 0
                    ? `This token may target: ${allowed.join(", ")}. `
                    : bound
                      ? `This token is bound to the "${bound}" branch. `
                      : "This token is bound to a single branch. ";
            hint =
                "The requested branch is outside this token's allowed set. " +
                allowedPart +
                'Pass --branch <name> (or set "branch" in translatize.config.json) to one of the allowed branches, ' +
                "or mint a token for the branch you are syncing under Project Settings -> Integrations.";
            break;
        }
        case "access_denied":
        case "token_expired":
            hint =
                "Authentication failed. Check the TRANSLATIZE_API_TOKEN environment variable (or --token) " +
                "– the token may be missing, wrong, or expired.";
            break;
        case "token_inactive":
            hint = "This API token has been deactivated. Create a new one under Project Settings -> Integrations.";
            break;
        case "ip_not_allowed":
            hint = "This token is IP-allowlisted and the current IP address is not permitted.";
            break;
        case "insufficient_permissions":
            hint = "The token's role does not permit this operation (translator tokens cannot create source keys).";
            break;
        case "project_mismatch":
            hint = "The token does not belong to the project in your config. Check projectId in translatize.config.json.";
            break;
        case "unknown_languages":
            hint =
                "One or more languages in your files are not configured on the project. " +
                "Add them in Translatize, or remove those files.";
            break;
        case "batch_too_large":
            hint = "Too many labels in a single request. This is a CLI bug – please report it.";
            break;
        case "project_not_found":
        case "branch_not_found":
            hint = err.message;
            break;
        case "timeout":
            hint = "The request timed out. Check your network connection and the --api-url value.";
            break;
        case "network_error":
            hint = `Could not reach the API: ${err.message}. Check your network connection and the --api-url value.`;
            break;
        default:
            hint = err.message;
            break;
    }
    return `${hint} (${code})`;
}

/**
 * Print `err` and return the process exit code: 2 for {@link UsageError}, 1 for API
 * errors and everything else.
 */
export function reportError(err: unknown, colors: Colors): number {
    if (err instanceof UsageError) {
        process.stderr.write(colors.red("Error: ") + err.message + "\n");
        return 2;
    }
    if (err instanceof TranslatizeApiError) {
        process.stderr.write(colors.red("Error: ") + describeApiError(err) + "\n");
        return 1;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(colors.red("Unexpected error: ") + message + "\n");
    return 1;
}
