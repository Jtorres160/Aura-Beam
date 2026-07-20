// Fingerprint shadow-wiring tests (Scanner V2 · M2-B).
//
// These lock in the shadow sensor's SAFETY contract — the whole reason it ships
// dark by default:
//
//   • Gating is one predicate. Flag off, non-Pokémon, or no row ⇒ shouldRun is
//     false, which is exactly what stops the route from scheduling any after(),
//     loading any model, or touching the DB. Proving the predicate proves the
//     no-op.
//   • When it DOES run (flag on + Pokémon), it calls the matcher and appends a
//     fingerprintShadow block onto the row's existing ocrText — merged, not
//     overwritten.
//   • It is fully isolated: a throwing matcher or a failing DB write is caught
//     and logged, never rethrown. A shadow sensor may go dark; it may not crash
//     its caller.
//
// All dependencies (matcher, row read/write, clock, logger) are injected — no
// real MobileCLIP model and no real database are touched.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/fingerprint-shadow.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  base64ImageToBuffer,
  runFingerprintShadow,
  shouldRunFingerprintShadow,
  type ShadowDeps,
} from "@/lib/scanner/fingerprint-shadow";
import type { FingerprintMatch } from "@/lib/scanner/fingerprint-match";

const IMAGE = "data:image/jpeg;base64,QUJD"; // "ABC"

// A recording set of deps: captures every call so tests can assert on them.
function makeDeps(over: Partial<ShadowDeps> = {}): ShadowDeps & {
  calls: { matcher: Array<{ game: string; bytes: number }>; saved: Array<{ id: string; ocrText: string }>; warns: number };
} {
  const calls = { matcher: [] as Array<{ game: string; bytes: number }>, saved: [] as Array<{ id: string; ocrText: string }>, warns: 0 };
  const deps: ShadowDeps = {
    matcher: async (buffer, game) => {
      calls.matcher.push({ game, bytes: buffer.length });
      return [
        { externalId: "sv1-25", distance: 0.021 },
        { externalId: "sv1-99", distance: 0.4 },
      ];
    },
    loadOcrText: async () => JSON.stringify({ v: 1, decision: { action: "accept" }, game: "POKEMON" }),
    saveOcrText: async (id, ocrText) => { calls.saved.push({ id, ocrText }); },
    now: () => "2026-07-20T00:00:00.000Z",
    warn: () => { calls.warns++; },
    ...over,
  };
  return Object.assign(deps, { calls });
}

describe("shouldRunFingerprintShadow — the no-op gate", () => {
  test("flag OFF ⇒ false even for Pokémon with a row (proves the route schedules nothing)", () => {
    assert.equal(shouldRunFingerprintShadow("POKEMON", "row1", false), false);
  });

  test("flag ON + Pokémon + row ⇒ true", () => {
    assert.equal(shouldRunFingerprintShadow("POKEMON", "row1", true), true);
  });

  test("flag ON but non-Pokémon game ⇒ false", () => {
    assert.equal(shouldRunFingerprintShadow("MTG", "row1", true), false);
    assert.equal(shouldRunFingerprintShadow("YUGIOH", "row1", true), false);
    assert.equal(shouldRunFingerprintShadow("", "row1", true), false);
  });

  test("Pokémon spelled/cased as the pipeline emits it still gates on (canonicalGame vocabulary)", () => {
    assert.equal(shouldRunFingerprintShadow("Pokemon", "row1", true), true);
    assert.equal(shouldRunFingerprintShadow("pokémon", "row1", true), true);
  });

  test("no row to attach to ⇒ false", () => {
    assert.equal(shouldRunFingerprintShadow("POKEMON", null, true), false);
  });
});

describe("runFingerprintShadow — flag-on Pokémon path", () => {
  test("calls the matcher with the decoded image bytes + POKEMON, and appends the block", async () => {
    const deps = makeDeps();
    await runFingerprintShadow(
      { rowId: "row1", imageUrl: IMAGE, pipelineExternalId: "sv1-25", pipelinePickSource: "accept" },
      deps,
    );

    // Matcher invoked exactly once, on the decoded bytes (3 = "ABC"), game POKEMON.
    assert.equal(deps.calls.matcher.length, 1);
    assert.equal(deps.calls.matcher[0].game, "POKEMON");
    assert.equal(deps.calls.matcher[0].bytes, 3);

    // Exactly one row write, carrying the merged block.
    assert.equal(deps.calls.saved.length, 1);
    assert.equal(deps.calls.saved[0].id, "row1");
    const written = JSON.parse(deps.calls.saved[0].ocrText);

    // The original record survived the merge (additive, not overwrite).
    assert.equal(written.v, 1);
    assert.equal(written.decision.action, "accept");
    assert.equal(written.game, "POKEMON");

    // The shadow block carries the top match + the pipeline pick, raw (no
    // derived agreement boolean).
    assert.deepEqual(written.fingerprintShadow, {
      topMatchExternalId: "sv1-25",
      topMatchDistance: 0.021,
      matches: [
        { externalId: "sv1-25", distance: 0.021 },
        { externalId: "sv1-99", distance: 0.4 },
      ],
      pipelineExternalId: "sv1-25",
      pipelinePickSource: "accept",
      at: "2026-07-20T00:00:00.000Z",
    });
  });

  test("disambiguate pick source is threaded through unchanged", async () => {
    const deps = makeDeps();
    await runFingerprintShadow(
      { rowId: "row2", imageUrl: IMAGE, pipelineExternalId: "sv1-25", pipelinePickSource: "disambiguate" },
      deps,
    );
    const written = JSON.parse(deps.calls.saved[0].ocrText);
    assert.equal(written.fingerprintShadow.pipelinePickSource, "disambiguate");
    assert.equal(written.fingerprintShadow.pipelineExternalId, "sv1-25");
  });

  test("no pipeline pick (not-found / provider-unavailable) records null identity", async () => {
    const deps = makeDeps();
    await runFingerprintShadow(
      { rowId: "row3", imageUrl: IMAGE, pipelineExternalId: null, pipelinePickSource: "none" },
      deps,
    );
    const written = JSON.parse(deps.calls.saved[0].ocrText);
    assert.equal(written.fingerprintShadow.pipelineExternalId, null);
    assert.equal(written.fingerprintShadow.pipelinePickSource, "none");
  });

  test("matcher going dark (null) still records a block — the silence is the observation", async () => {
    const deps = makeDeps({ matcher: async () => null as FingerprintMatch[] | null });
    await runFingerprintShadow(
      { rowId: "row4", imageUrl: IMAGE, pipelineExternalId: "sv1-25", pipelinePickSource: "accept" },
      deps,
    );
    assert.equal(deps.calls.saved.length, 1, "still writes the row");
    const written = JSON.parse(deps.calls.saved[0].ocrText);
    assert.equal(written.fingerprintShadow.topMatchExternalId, null);
    assert.equal(written.fingerprintShadow.topMatchDistance, null);
    assert.equal(written.fingerprintShadow.matches, undefined);
  });

  test("merges onto a missing/corrupt original without losing the block", async () => {
    const deps = makeDeps({ loadOcrText: async () => "not-json{" });
    await runFingerprintShadow(
      { rowId: "row5", imageUrl: IMAGE, pipelineExternalId: null, pipelinePickSource: "none" },
      deps,
    );
    const written = JSON.parse(deps.calls.saved[0].ocrText);
    assert.equal(written.v, 1);
    assert.equal(written.fingerprintShadow.pipelinePickSource, "none");
  });
});

describe("runFingerprintShadow — failure isolation (never rejects)", () => {
  test("a throwing matcher is caught and logged, no row write", async () => {
    const deps = makeDeps({ matcher: async () => { throw new Error("model exploded"); } });
    await runFingerprintShadow(
      { rowId: "row6", imageUrl: IMAGE, pipelineExternalId: "sv1-25", pipelinePickSource: "accept" },
      deps,
    );
    assert.equal(deps.calls.saved.length, 0, "no write when the match failed");
    assert.equal(deps.calls.warns, 1, "the failure was logged, not thrown");
  });

  test("a failing DB write is caught and logged (does not reject)", async () => {
    const deps = makeDeps({ saveOcrText: async () => { throw new Error("db down"); } });
    await assert.doesNotReject(
      runFingerprintShadow(
        { rowId: "row7", imageUrl: IMAGE, pipelineExternalId: null, pipelinePickSource: "none" },
        deps,
      ),
    );
    assert.equal(deps.calls.warns, 1);
  });
});

describe("base64ImageToBuffer", () => {
  test("strips the data-URI header and decodes the payload", () => {
    assert.equal(base64ImageToBuffer("data:image/jpeg;base64,QUJD").toString(), "ABC");
  });
  test("tolerates bare base64 without a header", () => {
    assert.equal(base64ImageToBuffer("QUJD").toString(), "ABC");
  });
});
