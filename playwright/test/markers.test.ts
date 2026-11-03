import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { markerHash, wrapWithMarker, decodeMarkers, stripMarkers, postProcessor } from "../src/markers.js";
import { sha256Hex } from "../src/sha256.js";

const node = (s: string) => createHash("sha256").update(s).digest("hex");

test("sha256 matches node crypto", () => {
    const vectors = ["", "abc", "home.title", "ünïcödé ✓ 😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)];
    for (const v of vectors) assert.equal(sha256Hex(v), node(v), JSON.stringify(v.slice(0, 20)));
});

test("markerHash is the first 10 hex chars", () => {
    assert.equal(markerHash("nav.home"), node("nav.home").slice(0, 10));
    assert.equal(markerHash("nav.home").length, 10);
});

test("wrap and decode round-trip", () => {
    const wrapped = wrapWithMarker("nav.home", "Home");
    assert.notEqual(wrapped, "Home");
    assert.ok(wrapped.startsWith("Home"));
    const d = decodeMarkers(wrapped);
    assert.equal(d.text, "Home");
    assert.deepEqual(d.markers, [markerHash("nav.home")]);
});

test("several markers in one string", () => {
    const s = wrapWithMarker("a", "One") + " and " + wrapWithMarker("b", "Two");
    const d = decodeMarkers(s);
    assert.equal(d.text, "One and Two");
    assert.deepEqual(d.markers, [markerHash("a"), markerHash("b")]);
});

test("stripMarkers leaves plain text alone", () => {
    assert.equal(stripMarkers("plain"), "plain");
    assert.equal(stripMarkers(wrapWithMarker("k", "Hi")), "Hi");
});

test("marker uses only the documented invisible characters", () => {
    const tail = wrapWithMarker("k", "").split("");
    assert.equal(tail.length, 42);
    assert.equal(tail[0], "⁠");
    assert.equal(tail[41], "⁤");
    assert.ok(tail.slice(1, 41).every((c) => c === "​" || c === "‌"));
});

test("postProcessor is off by default", () => {
    delete process.env.TRANSLATIZE_MARKERS;
    assert.equal(postProcessor.type, "postProcessor");
    assert.equal(postProcessor.name, "translatizeMarkers");
    assert.equal(postProcessor.process("Home", "nav.home"), "Home");
});

test("postProcessor wraps when TRANSLATIZE_MARKERS=1 and drops the ns prefix", () => {
    process.env.TRANSLATIZE_MARKERS = "1";
    try {
        const out = postProcessor.process("Home", "common:nav.home");
        assert.deepEqual(decodeMarkers(out), { text: "Home", markers: [markerHash("nav.home")] });
        // i18next passes keys as an array, and the resolved key with postProcessPassResolved
        assert.deepEqual(decodeMarkers(postProcessor.process("Home", ["nav.home"])).markers, [markerHash("nav.home")]);
        const resolved = postProcessor.process("Back", ["nav.missing", "nav.back"], { i18nResolved: { usedKey: "nav.back" } });
        assert.deepEqual(decodeMarkers(resolved).markers, [markerHash("nav.back")]);
    } finally {
        delete process.env.TRANSLATIZE_MARKERS;
    }
});
