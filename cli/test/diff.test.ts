import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRecord } from "@translatize/core";
import {
    assembleLocal,
    assemblePull,
    computeFilePlan,
    computePushDiff,
    computeStatus,
    filterFilesByNamespace,
    valuesDiffer,
} from "../src/diff.js";

function label(key: string, values: Record<string, string>): LabelRecord {
    return { key, values, status: "approved", tags: [], updatedAt: "2026-01-01T00:00:00.000Z" };
}

test("assembleLocal: merges languages, drops empty values, skips all-empty keys, sorts by key", () => {
    const out = assembleLocal({
        en: { b: "B", a: "A", empty: "" },
        lv: { a: "Ā", empty: "" },
    });
    assert.deepEqual(out, [
        { key: "a", values: { en: "A", lv: "Ā" } },
        { key: "b", values: { en: "B" } },
    ]);
});

test("computePushDiff: classifies new / changed / unchanged and reports remote-only", () => {
    const local = assembleLocal({
        en: { "a.new": "New", "a.changed": "Local", "a.same": "Same" },
    });
    const remote = [
        label("a.changed", { en: "Remote" }),
        label("a.same", { en: "Same" }),
        label("a.remoteonly", { en: "Ghost" }),
    ];
    const plan = computePushDiff(local, remote);
    assert.deepEqual(plan.create.map((l) => l.key), ["a.new"]);
    assert.deepEqual(plan.update.map((l) => l.key), ["a.changed"]);
    assert.deepEqual(plan.unchanged, ["a.same"]);
    assert.deepEqual(plan.remoteOnly, ["a.remoteonly"]);
});

test("computePushDiff: an all-empty local key is neither pushed nor counted", () => {
    const local = assembleLocal({ en: { blank: "" }, lv: { blank: "" } });
    const plan = computePushDiff(local, []);
    assert.equal(local.length, 0);
    assert.deepEqual(plan.create, []);
    assert.deepEqual(plan.update, []);
});

test("computePushDiff: adding a new language to an existing key counts as changed", () => {
    const local = assembleLocal({ en: { k: "Hi" }, lv: { k: "Sveiki" } });
    const remote = [label("k", { en: "Hi" })];
    const plan = computePushDiff(local, remote);
    assert.deepEqual(plan.update.map((l) => l.key), ["k"]);
    assert.deepEqual(plan.update[0].values, { en: "Hi", lv: "Sveiki" });
});

test("valuesDiffer: only local languages are compared; a missing remote value counts as empty", () => {
    assert.equal(valuesDiffer({ en: "Hi" }, { en: "Hi", lv: "X" }), false);
    assert.equal(valuesDiffer({ en: "Hi" }, {}), true);
    assert.equal(valuesDiffer({ en: "A" }, { en: "B" }), true);
});

test("assemblePull: one map per language, omitting empty/missing values", () => {
    const labels = [
        label("a", { en: "A", lv: "Ā" }),
        label("b", { en: "B", lv: "" }),
        label("c", { en: "C" }),
    ];
    const byLang = assemblePull(labels, ["en", "lv"]);
    assert.deepEqual(byLang.en, { a: "A", b: "B", c: "C" });
    assert.deepEqual(byLang.lv, { a: "Ā" });
});

test("computeFilePlan: a missing file is all-added", () => {
    assert.deepEqual(computeFilePlan(null, { a: "1", b: "2" }), { exists: false, added: 2, changed: 0, removed: 0, total: 2 });
});

test("computeFilePlan: added / changed / removed against an existing file", () => {
    const plan = computeFilePlan({ a: "1", b: "2", gone: "3" }, { a: "1", b: "CHANGED", c: "new" });
    assert.deepEqual(plan, { exists: true, added: 1, changed: 1, removed: 1, total: 3 });
});

test("computeStatus: completeness per language plus only-local / only-remote / differing", () => {
    const byLang = {
        en: { a: "A", b: "B-local", localonly: "L" }, // b disagrees with remote
        lv: { a: "Ā" }, // lv missing b -> counts as missing, not differing
    };
    const remote = [label("a", { en: "A", lv: "Ā" }), label("b", { en: "B", lv: "B-remote" }), label("remoteonly", { en: "R" })];
    const status = computeStatus(byLang, remote, ["en", "lv"]);
    assert.equal(status.totalRemoteKeys, 3);

    const en = status.languages.find((l) => l.lang === "en");
    const lv = status.languages.find((l) => l.lang === "lv");
    assert.deepEqual(en, { lang: "en", translated: 2, total: 3, missing: 1 }); // a,b present; remoteonly missing
    assert.deepEqual(lv, { lang: "lv", translated: 1, total: 3, missing: 2 }); // only a

    assert.deepEqual(status.onlyLocal, ["localonly"]);
    assert.deepEqual(status.onlyRemote, ["remoteonly"]);
    // b differs on the en value it does provide; lv absence is "missing", handled separately.
    assert.deepEqual(status.differing, ["b"]);
    assert.equal(status.hasMissing, true);
    assert.equal(status.hasDiff, true);
});

test("computeStatus: fully in-sync reports no missing and no diff", () => {
    const byLang = { en: { a: "A" }, lv: { a: "Ā" } };
    const remote = [label("a", { en: "A", lv: "Ā" })];
    const status = computeStatus(byLang, remote, ["en", "lv"]);
    assert.equal(status.hasMissing, false);
    assert.equal(status.hasDiff, false);
    assert.equal(status.languages.every((l) => l.missing === 0), true);
});

test("filterFilesByNamespace: keeps only prefixed keys and counts drops", () => {
    const { files, dropped } = filterFilesByNamespace({ en: { "app.a": "1", "other.b": "2" } }, "app");
    assert.deepEqual(files.en, { "app.a": "1" });
    assert.equal(dropped, 1);
});
