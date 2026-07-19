// Recognition Benchmark loader/validator tests (Scanner V2 · Milestone 0).
//
// The dataset is the regression suite for every future recognizer, so its
// integrity gate is itself tested: a malformed entry must be REJECTED, not
// silently averaged into a score. Also asserts the shipped manifest.json is
// valid, so a dirty dataset fails CI.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/benchmark/loader.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { validateManifest, entriesByCategory } from "@/lib/scanner/benchmark/loader";
import type { BenchmarkEntry } from "@/lib/scanner/benchmark/types";

function entry(over: Partial<BenchmarkEntry> = {}): BenchmarkEntry {
  return {
    id: "pokemon-base-charizard-holo",
    image: "pokemon-base-charizard-holo.jpg",
    game: "POKEMON",
    expectedName: "Charizard",
    expectedExternalId: "base1-4",
    expectedPrinting: "Base Set #4",
    categories: ["holo", "vintage"],
    ...over,
  };
}

function manifest(entries: BenchmarkEntry[]) {
  return { v: 1, description: "test", entries };
}

describe("manifest shape", () => {
  test("a well-formed manifest validates", () => {
    const r = validateManifest(manifest([entry()]));
    assert.equal(r.ok, true);
    assert.deepEqual(r.errors, []);
  });

  test("non-object manifest is rejected", () => {
    assert.equal(validateManifest(null).ok, false);
    assert.equal(validateManifest(42).ok, false);
  });

  test("wrong version and missing entries array are rejected", () => {
    assert.equal(validateManifest({ v: 2, description: "x", entries: [] }).ok, false);
    assert.equal(validateManifest({ v: 1, description: "x" }).ok, false);
  });
});

describe("entry integrity", () => {
  test("missing identity (expectedName) is rejected", () => {
    const r = validateManifest(manifest([entry({ expectedName: "" })]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /expectedName/.test(e.message)));
  });

  test("unknown difficulty category is rejected", () => {
    const r = validateManifest(manifest([entry({ categories: ["sparkly" as never] })]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /unknown difficulty category/.test(e.message)));
  });

  test("empty categories is rejected", () => {
    const r = validateManifest(manifest([entry({ categories: [] })]));
    assert.equal(r.ok, false);
  });

  test("duplicate ids are rejected", () => {
    const r = validateManifest(manifest([entry(), entry({ image: "other.jpg" })]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /duplicate id/.test(e.message)));
  });

  test("image must be a bare filename, not a path", () => {
    const r = validateManifest(manifest([entry({ image: "sub/dir/x.jpg" })]));
    assert.equal(r.ok, false);
    assert.ok(r.errors.some((e) => /bare filename/.test(e.message)));
  });

  test("printing truth is optional — identity-only entries are valid", () => {
    const r = validateManifest(manifest([entry({ expectedExternalId: undefined, expectedPrinting: undefined })]));
    assert.equal(r.ok, true);
  });
});

describe("entriesByCategory", () => {
  test("an entry appears under each of its categories", () => {
    const r = validateManifest(manifest([entry({ categories: ["holo", "vintage"] })]));
    assert.ok(r.manifest);
    const grouped = entriesByCategory(r.manifest);
    assert.equal(grouped.holo.length, 1);
    assert.equal(grouped.vintage.length, 1);
    assert.equal(grouped.easy.length, 0);
  });
});

describe("the shipped manifest.json is valid", () => {
  test("repo manifest passes validation (dirty dataset must fail CI)", () => {
    const path = fileURLToPath(new URL("./manifest.json", import.meta.url));
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    const r = validateManifest(parsed);
    assert.equal(r.ok, true, `manifest.json invalid: ${JSON.stringify(r.errors)}`);
  });
});
