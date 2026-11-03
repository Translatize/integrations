import { TranslatizeApiError } from "@translatize/core";

// feature_not_available names the missing plan feature in `feature`; without one it is AI translation.
function featureRemedy(feature: string | undefined): string {
    switch (feature) {
        case undefined:
        case "autoTranslation":
            return (
                "This project's plan does not include platform AI auto-translation. Do the translation yourself instead: call " +
                "get_missing_translations to see what is untranslated, translate the values, and write them with upsert_labels."
            );
        case "aiReview":
            return (
                "AI review needs the Professional or Agency plan. Rule-based QA (run_qa) works on every plan; you can also " +
                "review the translations yourself from get_labels."
            );
        case "screenshotCapture":
            return "Automated screenshot capture needs the Starter plan or higher. Screenshots can still be uploaded by hand in the web app.";
        default:
            return `This project's plan does not include the "${feature}" feature. Tell the user; it needs a plan upgrade.`;
    }
}

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
            remedy = featureRemedy(typeof err.details?.feature === "string" ? err.details.feature : undefined);
            break;
        case "feature_disabled":
            remedy =
                "This feature is switched off on this Translatize server. Skip this step and tell the user; the rest of " +
                "the tools still work.";
            break;
        case "qa_gate_blocked": {
            const gate = err.details?.gate as { errors?: unknown; mode?: unknown } | undefined;
            const errors = typeof gate?.errors === "number" ? `${gate.errors} QA error(s)` : "QA errors";
            remedy =
                `The QA merge gate blocks this merge: ${errors} on the keys it would change. Call check_merge_gate (or ` +
                "run_qa on the branch) to list them, fix each one on the branch (rewrite the value or fix its placeholders), " +
                "then try again. API tokens can never override the gate; an admin can override it in the web app with a reason.";
            break;
        }
        case "admin_token_required_for_main":
            remedy =
                "Merging into main needs an admin-role API token, and this token is not one. Do not retry. Tell the user: " +
                "they can merge the branch in the Translatize web app (review_changes gives the link), or issue an admin token.";
            break;
        case "ai_review_quota_exceeded": {
            const numericDetail = (key: string): string =>
                typeof err.details?.[key] === "number" ? String(err.details[key]) : "?";
            remedy =
                `The AI review quota is used up for this month (used ${numericDetail("used")} of ${numericDetail("limit")}). ` +
                "Rule-based QA (run_qa) still works. Tell the user; the quota resets next month or with a plan upgrade.";
            break;
        }
        case "ai_review_in_progress":
            remedy = "An AI review is already running for this project. Poll ai_review_status and retry once it has finished.";
            break;
        case "screenshot_quota_exceeded":
            remedy =
                "The plan's screenshot storage is full; new screenshots are refused and existing ones are kept. Tell the user " +
                "to delete old screenshots (Project Settings -> Screenshots) or upgrade the plan.";
            break;
        case "capture_run_limit":
            remedy = "The project has reached its daily limit of screenshot capture runs. Try again tomorrow (UTC).";
            break;
        case "run_screen_limit":
            remedy = "This capture run is full. Upload the remaining screens in a new run.";
            break;
        case "nothing_to_review":
            remedy = "There are no translated values to review in that scope. Translate first, or widen `keys` / `langs`.";
            break;
        case "too_many_pairs": {
            const limit = typeof err.details?.limit === "number" ? ` (max ${err.details.limit} key × language pairs)` : "";
            remedy = `That AI review is too big${limit}. Call start_ai_review again with fewer \`keys\` or \`langs\`.`;
            break;
        }
        case "nothing_to_publish":
            remedy =
                err.details?.publishFilter === "approved"
                    ? "Nothing to publish: the distribution publishes approved labels only, and none on its branch are approved. " +
                      "Approve them first (set_labels_status), with the user's go-ahead."
                    : "Nothing to publish: the distribution's branch has no translated values yet.";
            break;
        case "distribution_not_found":
            remedy = "That distribution does not exist. Call list_distributions and use one of its ids.";
            break;
        case "source_branch_not_found":
            remedy = "That branch does not exist in the project. Call list_branches to see the existing ones.";
            break;
        case "invalid_request":
            remedy = `The server rejected the arguments: ${err.message}. Fix them and retry.`;
            break;
        case "label_not_found":
            remedy =
                "That key does not exist on the branch, so its context cannot be set. Create it first with upsert_labels " +
                "(with its source value), or check the key name with search_labels.";
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
                "The token's role does not permit this operation (for example, a translator-role token cannot set context or " +
                "tags, and creating or merging branches, starting an AI review or publishing a release needs the developer " +
                "role). A token with a higher role is required.";
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
            remedy = "The token's project was not found – it may have been deleted. Ask the user to check the token.";
            break;
        case "branch_not_found":
            remedy = "That branch does not exist in the project. Call list_branches to see the existing ones.";
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
