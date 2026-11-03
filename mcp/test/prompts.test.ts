import { test } from "node:test";
import assert from "node:assert/strict";
import { localizeRepoPrompt, parseLanguages, prepareBranchForMergePrompt } from "../src/prompts.js";

function text(result: ReturnType<typeof localizeRepoPrompt>): string {
    const content = result.messages[0].content as { type: string; text: string };
    assert.equal(content.type, "text");
    return content.text;
}

test("parseLanguages splits on commas, semicolons and spaces", () => {
    assert.deepEqual(parseLanguages("lv, de;fr  es"), ["lv", "de", "fr", "es"]);
    assert.deepEqual(parseLanguages(""), []);
    assert.deepEqual(parseLanguages(undefined), []);
});

test("localizeRepoPrompt has exactly the ten FR-4.7 steps, in order", () => {
    const body = text(localizeRepoPrompt({ target_languages: "lv,de" }));
    const steps = body.split("\n").filter((line) => /^\d+\. /.test(line));
    assert.equal(steps.length, 10);
    steps.forEach((line, i) => assert.ok(line.startsWith(`${i + 1}. `), `step ${i + 1}`));
    const expectations = [
        /framework and i18n library[\s\S]*wait for my approval/,
        /hardcoded user-visible strings[\s\S]*analytics event names/,
        /dotted key names/,
        /create_branch named `agent-<topic>`/,
        /with context[\s\S]*description[\s\S]*charLimit[\s\S]*path:line/,
        /lookup call/,
        /auto_translate for the target languages \(lv, de\)/,
        /run_qa[\s\S]*fix the errors/,
        /check_merge_gate/,
        /Never merge into `main` without my explicit approval/,
    ];
    expectations.forEach((pattern, i) => assert.match(steps[i], pattern, `step ${i + 1}`));
});

test("localizeRepoPrompt scopes to a path when given", () => {
    assert.match(text(localizeRepoPrompt({ target_languages: "lv", path: " packages/web " })), /the code under `packages\/web`/);
    assert.match(text(localizeRepoPrompt({ target_languages: "lv" })), /Localize this repository/);
});

test("prepareBranchForMergePrompt runs QA, reports the gate and does not merge", () => {
    const body = text(prepareBranchForMergePrompt({ branch: "agent-copy" }));
    assert.match(body, /run_qa with branch "agent-copy"/);
    assert.match(body, /check_merge_gate for "agent-copy"/);
    assert.match(body, /Do not call merge_branch/);
    assert.doesNotMatch(body, /\u2014/);
});
