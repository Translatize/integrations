import { test } from "node:test";
import assert from "node:assert/strict";
import { TranslatizeApiError } from "@translatize/core";
import { describeApiError } from "../src/ui.js";

function msg(code: string, status = 400, details?: Record<string, unknown>): string {
    return describeApiError(new TranslatizeApiError(code, status, code, details));
}

test("describeApiError: every Q4 error code gets a helpful hint and keeps its code", () => {
    const cases: Array<[string, number, Record<string, unknown> | undefined, RegExp]> = [
        ["feature_not_available", 403, { feature: "aiReview" }, /Professional/],
        ["feature_not_available", 403, { feature: "screenshotCapture" }, /Starter/],
        ["feature_not_available", 403, undefined, /AI translation/],
        ["feature_disabled", 404, undefined, /switched off/],
        ["qa_gate_blocked", 409, { gate: { errors: 3 } }, /3 QA error\(s\)/],
        ["admin_token_required_for_main", 403, undefined, /admin-role token/],
        ["ai_review_quota_exceeded", 403, undefined, /quota/],
        ["screenshot_quota_exceeded", 403, undefined, /storage/],
        ["capture_run_limit", 429, { limit: 30 }, /daily limit of capture runs \(30\)/],
        ["run_screen_limit", 429, undefined, /Split the captures/],
        ["branch_not_allowed", 400, { boundBranch: "main" }, /--branch/],
        ["branch_not_found", 404, undefined, /does not exist/],
        ["image_required", 400, undefined, /uploaded/],
        ["meta_too_large", 413, undefined, /1 MB/],
        ["run_not_found", 404, undefined, /new run/],
        ["screenshot_pipeline_busy", 503, undefined, /busy/],
        ["nothing_to_publish", 422, { publishFilter: "approved" }, /approved labels only/],
        ["nothing_to_publish", 422, { publishFilter: "all" }, /no translated values/],
        ["distribution_not_found", 404, undefined, /Delivery/],
        ["nothing_to_review", 400, undefined, /nothing|no translated/i],
        ["too_many_pairs", 400, { limit: 20000 }, /\(20000\)/],
        ["ai_provider_not_configured", 503, undefined, /translatize qa/],
    ];
    for (const [code, status, details, pattern] of cases) {
        const text = msg(code, status, details);
        assert.match(text, pattern, code);
        assert.ok(text.endsWith(`(${code})`), `${code} keeps its code`);
        assert.doesNotMatch(text, /\u2014/, `${code}: no em dash`);
    }
});
