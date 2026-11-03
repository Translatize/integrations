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

// feature_not_available carries the missing plan feature in `feature`.
function featureHint(feature: string | undefined): string {
    switch (feature) {
        case "aiReview":
            return "AI review needs the Professional or Agency plan. Rule-based QA (`translatize qa`) works on every plan.";
        case "screenshotCapture":
            return "Automated screenshot capture needs the Starter plan or higher. Free projects can upload screenshots by hand in the app.";
        case "githubApp":
            return "The GitHub App needs the Professional or Agency plan.";
        case "auditExport":
            return "Audit log export needs the Professional or Agency plan.";
        case undefined:
        case "autoTranslation":
            return "This project's plan does not include AI translation.";
        default:
            return `This project's plan does not include "${feature}". Upgrade the plan to use it.`;
    }
}

function limitSuffix(err: TranslatizeApiError): string {
    return typeof err.details?.limit === "number" ? ` (${err.details.limit})` : "";
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
            hint =
                "The token's role does not permit this operation. Translator tokens cannot set label context or tags; " +
                "screenshot uploads, AI reviews and releases need the developer role or higher.";
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
            hint = "The token's project was not found – it may have been deleted. Check the token under Project Settings -> Integrations.";
            break;
        case "branch_not_found":
        case "source_branch_not_found":
            hint =
                "That branch does not exist in the project. Check the --branch value (or \"branch\" in translatize.config.json) " +
                "against the branches listed in the app.";
            break;
        case "invalid_request":
            hint = `The server rejected the request: ${err.message}.`;
            break;
        case "feature_not_available":
            hint = featureHint(typeof err.details?.feature === "string" ? err.details.feature : undefined);
            break;
        case "feature_disabled":
            hint = "This feature is switched off on this Translatize server. Ask its administrator, or skip this step.";
            break;
        case "qa_gate_blocked": {
            const gate = err.details?.gate as { errors?: unknown } | undefined;
            const errors = typeof gate?.errors === "number" ? `${gate.errors} QA error(s)` : "QA errors";
            hint =
                `The merge gate blocks this merge: ${errors} on the keys it would change. ` +
                "Run `translatize qa --branch <name>` to list them, fix them, and try again. Tokens cannot override the gate.";
            break;
        }
        case "admin_token_required_for_main":
            hint = "Merging into main needs an admin-role token. Merge in the app, or use a token with the admin role.";
            break;
        case "ai_review_quota_exceeded":
            hint = "The AI review quota for this month is used up. It resets at the start of next month, or upgrade the plan.";
            break;
        case "ai_review_in_progress":
            hint = "An AI review is already running for this project. Wait for it to finish, then try again.";
            break;
        case "screenshot_quota_exceeded":
            hint =
                "Screenshot storage for this plan is full. Delete old screenshots in Project Settings -> Screenshots, " +
                "or upgrade the plan. Existing screenshots are kept.";
            break;
        case "capture_run_limit":
            hint = `This project has reached its daily limit of capture runs${limitSuffix(err)}. Try again tomorrow (UTC).`;
            break;
        case "run_screen_limit":
            hint = `This capture run is full${limitSuffix(err)}. Split the captures into several directories and upload each one separately.`;
            break;
        case "run_not_open":
            hint = "This capture run is already completed. Run the upload again to start a new run.";
            break;
        case "run_not_found":
            hint = "The capture run no longer exists on the server. Run the upload again to start a new run.";
            break;
        case "image_too_large":
            hint = "The image is over the server's size limit (10 MB, 40 megapixels). Capture a smaller viewport, or without fullPage.";
            break;
        case "image_required":
            hint = "The server does not have this image yet, so it has to be uploaded with it.";
            break;
        case "invalid_image":
            hint = "The file is not a readable PNG, JPEG or WebP image. Capture it again with @translatize/playwright.";
            break;
        case "meta_too_large":
            hint = "The capture's text data is over the server's 1 MB limit. Capture a smaller part of the page.";
            break;
        case "invalid_meta":
            hint = `The capture JSON was rejected: ${err.message}. Capture it again with the current @translatize/playwright.`;
            break;
        case "screenshot_pipeline_busy":
            hint = "The server is busy processing other screenshots. Run the upload again in a minute.";
            break;
        case "image_processing_unavailable":
            hint = "Image processing is not available on this Translatize server. Ask its administrator.";
            break;
        case "distribution_not_found":
            hint = "That OTA distribution does not exist (or was just deleted). Check it under Project Settings -> Delivery in the app.";
            break;
        case "nothing_to_publish": {
            const approvedOnly = err.details?.publishFilter === "approved";
            hint = approvedOnly
                ? "The distribution publishes approved labels only, and none on its branch are approved yet. Approve labels in the app first."
                : "The distribution's branch has no translated values yet, so there is nothing to publish.";
            break;
        }
        case "nothing_to_review":
            hint = "There are no translated values to review in that scope.";
            break;
        case "too_many_pairs":
            hint = `That AI review is too big${limitSuffix(err)}. Narrow it to fewer keys or languages.`;
            break;
        case "ai_provider_not_configured":
            hint = "AI is not set up on this Translatize server. Rule-based QA (`translatize qa`) still works.";
            break;
        case "label_not_found":
            hint = "That key does not exist on the branch. Create it with its source value first.";
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
