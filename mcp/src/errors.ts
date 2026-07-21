import { TranslatizeApiError } from "@translatize/core";

/**
 * Turn a {@link TranslatizeApiError} into one actionable sentence, led by the machine-readable
 * code so the agent can branch on it before reading the remedy. Server-side (5xx) failures are
 * the exception: they return a single generic sentence with no code and no internal detail, so
 * external MCP clients never see the platform's setup state.
 */
export function describeApiError(err: TranslatizeApiError): string {
    const code = err.code;
    // Server-side (5xx) failures must never leak internal setup detail to an external MCP
    // client — not the raw server message, not provider/configuration state, not even the
    // specific error code. Collapse every 5xx into one generic, actionable sentence regardless
    // of code. (Network/timeout failures carry status 0, not 5xx, so they keep their own
    // remedies below; genuinely client-fixable 4xx errors fall through to the switch.)
    if (err.status >= 500) {
        return (
            "Translatize API error: The Translatize service could not complete the request due to a server-side " +
            "error. Try again later; if it persists, the agent can translate manually via get_missing_translations " +
            "+ upsert_labels."
        );
    }
    let remedy: string;
    switch (code) {
        case "branch_not_allowed": {
            const bound = typeof err.details?.boundBranch === "string" ? err.details.boundBranch : undefined;
            const allowed = Array.isArray(err.details?.allowedBranches)
                ? (err.details.allowedBranches as unknown[]).filter((branch): branch is string => typeof branch === "string")
                : [];
            if (allowed.length > 0) {
                remedy =
                    `That branch is not in this token's allowed set. This token may only act on: ` +
                    `${allowed.map((branch) => `"${branch}"`).join(", ")}. ` +
                    (bound ? `Its base branch is "${bound}". ` : "") +
                    "To work on a fresh branch, create one with create_branch (a create-own token only), then pass that name as `branch`.";
            } else if (bound) {
                remedy =
                    `This API token is bound to the "${bound}" branch and cannot read or write any other branch. ` +
                    "It has a fixed branch scope; ask the project owner for a create-own token to branch.";
            } else {
                remedy = "This API token is bound to a single branch and cannot act on another one.";
            }
            break;
        }
        case "branch_scope_fixed":
            remedy =
                "This API token has a fixed branch scope and cannot create, merge or delete branches; it can only work on " +
                "its one bound branch. Ask the project owner to issue a create-own scoped token (Project Settings -> Integrations).";
            break;
        case "not_token_branch":
            remedy =
                "This branch was not created by this API token. A create-own token may only merge or delete branches it " +
                "created itself (list_branches marks these with createdByThisToken=true); it can never touch main or others' branches.";
            break;
        case "invalid_name":
            remedy =
                "The branch name is invalid. Use 1-100 characters matching ^[a-zA-Z0-9_-]+$, and it cannot be \"main\".";
            break;
        case "branch_exists":
            remedy = "A branch with that name already exists. Pick a different name, or work on the existing branch by passing it as `branch`.";
            break;
        case "branch_limit_reached":
            remedy =
                "The project has reached its plan's branch limit. Merge and delete branches you no longer need (merge_branch " +
                "then delete_branch), or ask the owner to upgrade the plan.";
            break;
        case "feature_not_available":
            remedy =
                "This project's plan does not include platform AI auto-translation. Do the translation yourself instead: call " +
                "get_missing_translations to see what is untranslated, translate the values, and write them with upsert_labels.";
            break;
        case "ai_quota_exceeded": {
            const numericDetail = (key: string): string =>
                typeof err.details?.[key] === "number" ? String(err.details[key]) : "?";
            remedy =
                `The AI translation quota is exhausted (used ${numericDetail("used")} of ${numericDetail("limit")}, remaining ${numericDetail("remaining")}` +
                `${typeof err.details?.estimated === "number" ? `; this request needs ~${numericDetail("estimated")}` : ""}). ` +
                "Translate manually via get_missing_translations + upsert_labels, or ask the owner to upgrade the plan / wait for the quota to reset.";
            break;
        }
        case "translation_already_running":
            remedy =
                "A translation job is already running for this project. Call translation_job_status to watch its progress, " +
                "and retry once it has finished.";
            break;
        case "access_denied":
        case "token_expired":
            remedy =
                "Authentication failed: the TRANSLATIZE_API_TOKEN is missing, wrong, or expired. " +
                "Ask the user to set a valid token (created under Project Settings -> Integrations at app.translatize.com).";
            break;
        case "token_inactive":
            remedy =
                "This API token has been deactivated. A new one must be created under " +
                "Project Settings -> Integrations at app.translatize.com.";
            break;
        case "ip_not_allowed":
            remedy = "This token is IP-allowlisted and the current IP address is not permitted. Ask the project owner to allow it.";
            break;
        case "insufficient_permissions":
            remedy =
                "The token's role does not permit this operation (for example, a translator-role token cannot create new source keys). " +
                "A token with a higher role is required.";
            break;
        case "project_mismatch":
            remedy = "The token does not belong to that project. This server only operates on the token's own project.";
            break;
        case "unknown_languages":
            remedy =
                "One or more language codes are not configured on this project. " +
                "Call get_project_info to see the allowed languages, then retry with only those.";
            break;
        case "batch_too_large":
            remedy = "Too many labels in a single request. Split the write into smaller batches and retry.";
            break;
        case "project_not_found":
        case "branch_not_found":
            remedy = err.message;
            break;
        case "timeout":
            remedy = "The request to the Translatize API timed out. Check network connectivity and the TRANSLATIZE_API_URL value.";
            break;
        case "network_error":
            remedy = `Could not reach the Translatize API: ${err.message}. Check network connectivity and the TRANSLATIZE_API_URL value.`;
            break;
        default:
            remedy = err.message;
            break;
    }
    return `Translatize API error [${code}]: ${remedy}`;
}
