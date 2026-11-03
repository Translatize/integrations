import { test } from "node:test";
import assert from "node:assert/strict";
import { slugify, buildRegions, buildCaptureJson } from "../src/regions.js";
import { wrapWithMarker, markerHash } from "../src/markers.js";

test("slugify makes safe filenames", () => {
    assert.equal(slugify("Checkout / Step 1"), "checkout-step-1");
    assert.equal(slugify("../../etc/passwd"), "etc-passwd");
    assert.equal(slugify("Café Ünï"), "cafe-uni");
    assert.equal(slugify("a\\b:c"), "a-b-c");
    assert.equal(slugify("   "), "capture");
    assert.equal(slugify("..."), "capture");
    assert.ok(!slugify("x".repeat(300)).includes("/"));
    assert.ok(slugify("x".repeat(300)).length <= 100);
});

test("buildRegions strips markers into marker and trims text", () => {
    const r = buildRegions([{ text: "  " + wrapWithMarker("nav.home", "Home") + " ", rect: { x: 1, y: 2, w: 30, h: 10 } }], {
        fullPage: false,
    });
    assert.deepEqual(r, [{ text: "Home", marker: markerHash("nav.home"), rect: { x: 1, y: 2, w: 30, h: 10 } }]);
});

test("buildRegions drops empty and zero-size, dedupes text+rect", () => {
    const rect = { x: 0, y: 0, w: 10, h: 10 };
    const r = buildRegions(
        [
            { text: "Hi", rect },
            { text: "Hi", rect: { ...rect } },
            { text: "  ", rect },
            { text: "Zero", rect: { x: 0, y: 0, w: 0, h: 5 } },
            { text: "Hi", rect: { ...rect, x: 5 } },
        ],
        { fullPage: false },
    );
    assert.equal(r.length, 2);
});

test("buildRegions keeps attr and adds scroll offset for fullPage only", () => {
    const raw = [{ text: "Search", attr: "placeholder" as const, rect: { x: 10, y: 20, w: 100, h: 30 } }];
    assert.deepEqual(buildRegions(raw, { fullPage: true, scrollX: 5, scrollY: 400 })[0].rect, { x: 15, y: 420, w: 100, h: 30 });
    const plain = buildRegions(raw, { fullPage: false, scrollX: 5, scrollY: 400 })[0];
    assert.deepEqual(plain.rect, { x: 10, y: 20, w: 100, h: 30 });
    assert.equal(plain.attr, "placeholder");
});

test("a marker-only region is kept without text", () => {
    const r = buildRegions([{ text: wrapWithMarker("k", ""), rect: { x: 0, y: 0, w: 4, h: 4 } }], { fullPage: false });
    assert.deepEqual(r, [{ marker: markerHash("k"), rect: { x: 0, y: 0, w: 4, h: 4 } }]);
});

test("buildCaptureJson follows the contract shape", () => {
    const j = buildCaptureJson({
        name: "Home",
        viewport: { width: 1280, height: 720 },
        clientHash: "ab",
        fullPage: false,
        capturedAt: "2026-10-27T00:00:00.000Z",
        regions: [],
    });
    assert.deepEqual(Object.keys(j), ["name", "viewport", "clientHash", "fullPage", "capturedAt", "regions"]);
    const withLocale = buildCaptureJson({ ...j, locale: "de" });
    assert.equal(withLocale.locale, "de");
});
