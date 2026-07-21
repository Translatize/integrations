import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRecord } from "@translatize/core";
import { isNonEmpty, matchesLabel, percent, summarizeLanguage } from "../src/labels.js";

function label(key: string, values: Record<string, string>): LabelRecord {
    return { key, values, status: "approved", tags: [], updatedAt: "2026-01-01T00:00:00.000Z" };
}

const LABELS: LabelRecord[] = [
    label("app.title", { en: "Title", lv: "Nosaukums" }),
    label("app.subtitle", { en: "Subtitle" }), // lv missing
    label("common.cancel", { en: "Cancel", lv: "Atcelt" }),
    label("common.blank", { en: "", lv: "" }), // both empty -> untranslated in both
];

test("summarizeLanguage counts non-empty values and lists the missing keys", () => {
    const en = summarizeLanguage(LABELS, "en", 50);
    assert.equal(en.translated, 3);
    assert.equal(en.missing, 1);
    assert.deepEqual(en.missingKeys, ["common.blank"]);

    const lv = summarizeLanguage(LABELS, "lv", 50);
    assert.equal(lv.translated, 2);
    assert.equal(lv.missing, 2);
    assert.deepEqual(lv.missingKeys, ["app.subtitle", "common.blank"]);
});

test("summarizeLanguage caps the missing-keys sample but keeps the exact count", () => {
    const lv = summarizeLanguage(LABELS, "lv", 1);
    assert.equal(lv.missing, 2);
    assert.deepEqual(lv.missingKeys, ["app.subtitle"]);
});

test("summarizeLanguage with limit 0 returns counts and no sample", () => {
    const lv = summarizeLanguage(LABELS, "lv", 0);
    assert.equal(lv.translated, 2);
    assert.deepEqual(lv.missingKeys, []);
});

test("percent rounds and treats an empty branch as complete", () => {
    assert.equal(percent(2, 3), 67);
    assert.equal(percent(0, 0), 100);
    assert.equal(percent(3, 3), 100);
    assert.equal(percent(0, 4), 0);
});

test("isNonEmpty rejects empty and undefined values", () => {
    assert.equal(isNonEmpty("x"), true);
    assert.equal(isNonEmpty(""), false);
    assert.equal(isNonEmpty(undefined), false);
});

test("matchesLabel honours the search scope and is case-insensitive", () => {
    const l = label("checkout.pay", { en: "Pay now", lv: "Maksāt" });
    assert.equal(matchesLabel(l, "pay", "keys"), true);
    assert.equal(matchesLabel(l, "now", "keys"), false);
    assert.equal(matchesLabel(l, "now", "values"), true);
    assert.equal(matchesLabel(l, "checkout", "values"), false);
    assert.equal(matchesLabel(l, "maksāt", "both"), true);
    assert.equal(matchesLabel(l, "zzz", "both"), false);
});
