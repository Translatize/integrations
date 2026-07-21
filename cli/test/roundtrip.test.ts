import { test } from "node:test";
import assert from "node:assert/strict";
import type { LabelRecord } from "@translatize/core";
import { assembleLocal, assemblePull, computePushDiff, type FilesByLang } from "../src/diff.js";
import { parseTranslationFile, serializeTranslationFile } from "../src/serialize.js";
import type { TranslationFormat } from "../src/config.js";

function label(key: string, values: Record<string, string>): LabelRecord {
    return { key, values, status: "approved", tags: [], updatedAt: "2026-01-01T00:00:00.000Z" };
}

const LANGS = ["en", "lv"];
const REMOTE: LabelRecord[] = [
    label("app.title", { en: "Title", lv: "Nosaukums" }),
    label("app.nav.home", { en: "Home", lv: "Sākums" }),
    label("common.cancel", { en: "Cancel", lv: "Atcelt" }),
    label("common.ok", { en: "OK" }), // lv missing -> omitted for lv, key survives via en
];

// Simulate `pull` (assemble + serialize to disk) then `push` (read + parse + assemble + diff).
function roundTrip(format: TranslationFormat): FilesByLang {
    const pulled = assemblePull(REMOTE, LANGS);
    const reread: FilesByLang = {};
    for (const lang of LANGS) {
        const text = serializeTranslationFile(pulled[lang], format);
        reread[lang] = parseTranslationFile(text, `${lang}.json`);
    }
    return reread;
}

test("round-trip: a leading-dot key survives pull -> push with zero drift (json-nested)", () => {
    const remote: LabelRecord[] = [label(".hidden", { en: "Secret" }), label("app.title", { en: "Title" })];
    const pulled = assemblePull(remote, ["en"]);
    const text = serializeTranslationFile(pulled.en, "json-nested");
    const reread = parseTranslationFile(text, "en.json");
    const plan = computePushDiff(assembleLocal({ en: reread }), remote);

    assert.deepEqual(plan.create, [], "nothing to create");
    assert.deepEqual(plan.update, [], "nothing to update");
    assert.deepEqual(plan.remoteOnly, [], "the leading-dot key round-trips locally");
    assert.deepEqual([...plan.unchanged].sort(), [".hidden", "app.title"]);
});

for (const format of ["json-nested", "json-flat"] as const) {
    test(`round-trip pull -> push produces zero changes (${format})`, () => {
        const local = assembleLocal(roundTrip(format));
        const plan = computePushDiff(local, REMOTE);

        assert.deepEqual(plan.create, [], "nothing to create");
        assert.deepEqual(plan.update, [], "nothing to update");
        assert.deepEqual(plan.remoteOnly, [], "every remote key round-trips locally");
        assert.deepEqual(
            [...plan.unchanged].sort(),
            ["app.nav.home", "app.title", "common.cancel", "common.ok"],
            "all keys classified unchanged",
        );
    });

    test(`round-trip pull assembly reconstructs per-language values (${format})`, () => {
        const reread = roundTrip(format);
        // en carries all four keys; lv carries the three it has translations for.
        assert.deepEqual(reread.en, {
            "app.title": "Title",
            "app.nav.home": "Home",
            "common.cancel": "Cancel",
            "common.ok": "OK",
        });
        assert.deepEqual(reread.lv, {
            "app.title": "Nosaukums",
            "app.nav.home": "Sākums",
            "common.cancel": "Atcelt",
        });
    });
}
