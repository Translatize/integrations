import { test } from "node:test";
import assert from "node:assert/strict";
import { flatten, unflatten } from "../src/index.js";

test("flatten: nested object to dotted keys", () => {
    assert.deepEqual(flatten({ a: { b: "x", c: "y" }, d: "z" }), { "a.b": "x", "a.c": "y", d: "z" });
});

test("flatten: keys with multiple dots (deep nesting)", () => {
    assert.deepEqual(flatten({ a: { b: { c: { d: "deep" } } } }), { "a.b.c.d": "deep" });
});

test("flatten: drops empty objects", () => {
    assert.deepEqual(flatten({ a: {}, b: "keep" }), { b: "keep" });
    assert.deepEqual(flatten({ a: { b: {} }, c: "keep" }), { c: "keep" });
    assert.deepEqual(flatten({ a: {} }), {});
});

test("flatten: empty string values are preserved", () => {
    assert.deepEqual(flatten({ a: "", b: { c: "" } }), { a: "", "b.c": "" });
});

test("flatten: non-string leaf throws naming the offending path", () => {
    assert.throws(() => flatten({ a: { b: 5 as unknown as string } }), /"a\.b".*number/);
    assert.throws(() => flatten({ a: null as unknown as string }), /"a".*null/);
    assert.throws(() => flatten({ a: { b: ["x"] as unknown as string } }), /"a\.b".*array/);
    assert.throws(() => flatten({ a: true as unknown as string }), /"a".*boolean/);
});

test("unflatten: dotted keys to nested object", () => {
    assert.deepEqual(unflatten({ "a.b": "x", "a.c": "y", d: "z" }), { a: { b: "x", c: "y" }, d: "z" });
});

test("unflatten: keys with multiple dots nest deeply", () => {
    assert.deepEqual(unflatten({ "a.b.c.d": "deep" }), { a: { b: { c: { d: "deep" } } } });
});

test("unflatten: parent/child conflict throws (child key first)", () => {
    assert.throws(() => unflatten({ "a.b": "x", a: "y" }), /conflict/);
});

test("unflatten: parent/child conflict throws (parent key first)", () => {
    assert.throws(() => unflatten({ a: "y", "a.b": "x" }), /conflict/);
});

test("unflatten: non-string value throws", () => {
    assert.throws(() => unflatten({ a: 3 as unknown as string }), /"a".*number/);
});

test("round-trip: flatten then unflatten returns the original nested object", () => {
    const nested = { app: { title: "Hi", nav: { home: "Home", about: "About" } }, ok: "" };
    assert.deepEqual(unflatten(flatten(nested)), nested);
});

test("round-trip: unflatten then flatten returns the original flat map", () => {
    const flat = { "app.title": "Hi", "app.nav.home": "Home", "app.nav.about": "About", ok: "" };
    assert.deepEqual(flatten(unflatten(flat)), flat);
});

test("custom separator round-trips", () => {
    const flat = { "a/b/c": "x", "a/b/d": "y" };
    const nested = unflatten(flat, "/");
    assert.deepEqual(nested, { a: { b: { c: "x", d: "y" } } });
    assert.deepEqual(flatten(nested, "/"), flat);
});

test("flatten: a leading empty segment is preserved, not dropped", () => {
    assert.deepEqual(flatten({ "": { hidden: "Secret" } }), { ".hidden": "Secret" });
    assert.deepEqual(flatten({ "": "x" }), { "": "x" });
});

test("round-trip: leading/consecutive/trailing empty segments survive both directions", () => {
    const cases: Record<string, string>[] = [{ ".hidden": "Secret" }, { "a..b": "v" }, { "a.": "v" }, { ".a": "x", a: "y" }];
    for (const flat of cases) {
        assert.deepEqual(flatten(unflatten(flat)), flat, `round-trip failed for ${JSON.stringify(flat)}`);
    }
});

test("unflatten: rejects prototype-polluting key segments and leaves Object.prototype clean", () => {
    for (const key of ["__proto__.polluted", "a.__proto__.b", "constructor.prototype.x", "a.prototype.b"]) {
        assert.throws(() => unflatten({ [key]: "PWNED" }), /unsafe key segment/, `expected ${key} rejected`);
    }
    assert.equal(({} as Record<string, unknown>).polluted, undefined);
    assert.equal(({} as Record<string, unknown>).x, undefined);
});
