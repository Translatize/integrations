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
