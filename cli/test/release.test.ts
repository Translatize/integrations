import { test } from "node:test";
import assert from "node:assert/strict";
import type { OtaDistribution } from "@translatize/core";
import { pickDistribution, publishOta, type ReleaseClient } from "../src/commands/release.js";
import { UsageError } from "../src/config.js";

function dist(id: string, overrides: Partial<OtaDistribution> = {}): OtaDistribution {
    return {
        id,
        name: `Dist ${id}`,
        publicId: `${id}`.padEnd(22, "x"),
        branch: "main",
        publishFilter: "all",
        format: "json-flat",
        autoPublishOnMerge: false,
        status: "active",
        latestVersion: null,
        manifestUrl: `https://cdn.translatize.com/d/${id}/manifest.json`,
        ...overrides,
    };
}

test("pickDistribution: the only distribution is picked without flags", () => {
    assert.equal(pickDistribution([dist("d1")], {}).id, "d1");
});

test("pickDistribution: no distributions is a usage error pointing at the Delivery tab", () => {
    assert.throws(() => pickDistribution([], {}), (err: unknown) => err instanceof UsageError && /Delivery/.test(err.message));
});

test("pickDistribution: several without --distribution lists them", () => {
    assert.throws(() => pickDistribution([dist("d1"), dist("d2")], {}), /--distribution[\s\S]*d1[\s\S]*d2/);
});

test("pickDistribution: --branch narrows the choice", () => {
    const list = [dist("d1"), dist("d2", { branch: "staging" })];
    assert.equal(pickDistribution(list, { branch: "staging" }).id, "d2");
    assert.throws(() => pickDistribution(list, { branch: "nope" }), /No distribution publishes branch "nope"/);
});

test("pickDistribution: --distribution matches id, public id or name", () => {
    const list = [dist("d1", { name: "Web" }), dist("d2", { name: "Mobile", publicId: "PUBLICID00000000000002" })];
    assert.equal(pickDistribution(list, { distribution: "d2" }).id, "d2");
    assert.equal(pickDistribution(list, { distribution: "PUBLICID00000000000002" }).id, "d2");
    assert.equal(pickDistribution(list, { distribution: "Web" }).id, "d1");
    assert.throws(() => pickDistribution(list, { distribution: "Desktop" }), /No distribution "Desktop"/);
});

test("pickDistribution: a duplicate name asks for the id; a branch mismatch is refused", () => {
    const list = [dist("d1", { name: "Web" }), dist("d2", { name: "Web" })];
    assert.throws(() => pickDistribution(list, { distribution: "Web" }), /Several distributions/);
    assert.throws(() => pickDistribution([dist("d1")], { distribution: "d1", branch: "staging" }), /publishes branch "main"/);
});

test("publishOta: lists, picks, publishes the picked id", async () => {
    const published: string[] = [];
    const client: ReleaseClient = {
        async listDistributions() {
            return { distributions: [dist("d1"), dist("d2", { branch: "staging" })] };
        },
        async publishRelease(id) {
            published.push(id);
            return { release: { version: 7, labelCount: 3, languages: {}, createdAt: "x" }, manifestUrl: "m" };
        },
    };
    const out = await publishOta(client, { branch: "staging" });
    assert.deepEqual(published, ["d2"]);
    assert.equal(out.result.release.version, 7);
});
