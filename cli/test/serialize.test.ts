import { test } from "node:test";
import assert from "node:assert/strict";
import { UsageError } from "../src/config.js";
import { parseTranslationFile, serializeTranslationFile } from "../src/serialize.js";

test("serialize json-nested: dotted keys become nested objects, sorted, trailing newline", () => {
    const text = serializeTranslationFile({ "app.title": "Hi", "app.nav.home": "Home" }, "json-nested");
    assert.equal(text, '{\n  "app": {\n    "nav": {\n      "home": "Home"\n    },\n    "title": "Hi"\n  }\n}\n');
});

test("serialize json-flat: keys stay flat and sorted", () => {
    const text = serializeTranslationFile({ b: "2", a: "1" }, "json-flat");
    assert.equal(text, '{\n  "a": "1",\n  "b": "2"\n}\n');
});

test("serialize json-nested: parent/child key conflict raises a UsageError pointing at json-flat", () => {
    assert.throws(
        () => serializeTranslationFile({ a: "x", "a.b": "y" }, "json-nested"),
        (err: unknown) => {
            assert.ok(err instanceof UsageError);
            assert.match((err as Error).message, /json-flat/);
            return true;
        },
    );
});

test("parse: a nested file flattens to dotted keys", () => {
    assert.deepEqual(parseTranslationFile('{"app":{"title":"Hi"}}', "en.json"), { "app.title": "Hi" });
});

test("parse: an already-flat file passes through", () => {
    assert.deepEqual(parseTranslationFile('{"app.title":"Hi","x":"y"}', "en.json"), { "app.title": "Hi", x: "y" });
});

test("parse: invalid JSON throws a UsageError naming the file", () => {
    assert.throws(() => parseTranslationFile("{ bad", "broken.json"), /broken\.json: not valid JSON/);
});

test("parse: a non-object root is rejected", () => {
    assert.throws(() => parseTranslationFile("[1,2]", "arr.json"), /expected a JSON object/);
    assert.throws(() => parseTranslationFile('"str"', "str.json"), /expected a JSON object/);
});

test("parse: a non-string leaf is rejected naming the path", () => {
    assert.throws(() => parseTranslationFile('{"a":{"b":5}}', "n.json"), /a\.b/);
});

test("round-trip: serialize then parse is identity for both formats", () => {
    const flat = { "app.title": "Hi", "app.nav.home": "Home", ok: "" };
    assert.deepEqual(parseTranslationFile(serializeTranslationFile(flat, "json-nested"), "f"), flat);
    assert.deepEqual(parseTranslationFile(serializeTranslationFile(flat, "json-flat"), "f"), flat);
});
