import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslatizeApiError } from "@translatize/core";
import { describeApiError } from "../src/errors.js";

test("describeApiError names the bound branch for branch_not_allowed", () => {
    const err = new TranslatizeApiError("nope", 400, "branch_not_allowed", { boundBranch: "release" });
    const msg = describeApiError(err);
    assert.match(msg, /\[branch_not_allowed\]/);
    assert.match(msg, /"release"/);
});

test("describeApiError points at get_project_info for unknown_languages", () => {
    const msg = describeApiError(new TranslatizeApiError("bad", 400, "unknown_languages"));
    assert.match(msg, /\[unknown_languages\]/);
    assert.match(msg, /get_project_info/);
});

test("describeApiError falls back to the raw message for unknown 4xx codes", () => {
    const msg = describeApiError(new TranslatizeApiError("weird failure", 422, "http_422"));
    assert.match(msg, /\[http_422\]/);
    assert.match(msg, /weird failure/);
});

test("describeApiError hides internal detail behind a generic message for 5xx server errors", () => {
    // A server-side failure whose code and message both name internal setup state.
    const msg = describeApiError(
        new TranslatizeApiError("no AI provider key configured on the server", 500, "ai_provider_not_configured"),
    );
    // None of the internal detail — the code, the word "provider", or the raw message — may leak.
    assert.doesNotMatch(msg, /ai_provider_not_configured/);
    assert.doesNotMatch(msg, /provider/i);
    assert.doesNotMatch(msg, /\[/); // no bracketed code is echoed for 5xx
    // But the message is still generic and actionable.
    assert.match(msg, /server-side error/);
    assert.match(msg, /get_missing_translations/);
});

test("describeApiError collapses any 5xx code to the same generic message", () => {
    // Even a plain http_5xx fallback code (no server error body) must not surface its status.
    const msg = describeApiError(new TranslatizeApiError("Bad Gateway", 502, "http_502"));
    assert.doesNotMatch(msg, /http_502/);
    assert.doesNotMatch(msg, /Bad Gateway/);
    assert.match(msg, /server-side error/);
});

test("describeApiError gives every Q4 error code a remedy that keeps the code", () => {
    const cases: Array<[string, number, Record<string, unknown> | undefined, RegExp]> = [
        ["qa_gate_blocked", 409, { gate: { errors: 2, mode: "block" } }, /2 QA error\(s\)[\s\S]*check_merge_gate/],
        ["admin_token_required_for_main", 403, undefined, /admin-role API token[\s\S]*web app/],
        ["feature_not_available", 403, { feature: "aiReview" }, /Professional[\s\S]*run_qa/],
        ["feature_not_available", 403, { feature: "screenshotCapture" }, /Starter/],
        ["feature_disabled", 404, undefined, /switched off/],
        ["ai_review_quota_exceeded", 403, { used: 5, limit: 5 }, /used 5 of 5/],
        ["ai_review_in_progress", 409, undefined, /ai_review_status/],
        ["screenshot_quota_exceeded", 403, undefined, /storage is full/],
        ["capture_run_limit", 429, undefined, /daily limit/],
        ["run_screen_limit", 429, undefined, /new run/],
        ["label_not_found", 400, undefined, /upsert_labels/],
        ["nothing_to_review", 400, undefined, /nothing to review|no translated/i],
        ["too_many_pairs", 400, { limit: 20000 }, /max 20000/],
        ["nothing_to_publish", 422, { publishFilter: "approved" }, /approved labels only/],
        ["distribution_not_found", 404, undefined, /list_distributions/],
        ["branch_not_found", 404, undefined, /list_branches/],
        ["invalid_request", 400, undefined, /rejected the arguments/],
    ];
    for (const [code, status, details, pattern] of cases) {
        const msg = describeApiError(new TranslatizeApiError(code, status, code, details));
        assert.ok(msg.startsWith(`Translatize API error [${code}]`), `${code} leads with its code`);
        assert.match(msg, pattern, code);
        assert.doesNotMatch(msg, /\u2014/, `${code}: no em dash`);
    }
});

test("describeApiError keeps the AI-translation fallback for feature_not_available without a feature", () => {
    const msg = describeApiError(new TranslatizeApiError("nope", 403, "feature_not_available"));
    assert.match(msg, /get_missing_translations/);
});
