// ─── Confirmation / rejection labels on accepted scans (Scanner V2) ──────────
// Until this shipped, an auto-accepted scan produced no ground truth at all:
// the review screen offered "Add to Collection" and "Scan Next", and neither
// wrote anything back, so a kept match and a rejected one were indistinguishable
// from each other and from a user who walked away.
//
// What these tests pin down, hardest invariant first:
//
//   1. NO COUNT IS CONTAMINATED. The write is an update, never an insert. Every
//      scan-volume figure in the product is a row count over ScanHistory — the
//      admin "Total Scans" tile and the per-user daily scan limit — so a label
//      that inserted would both invent scans and eat collectors' quota. And no
//      column but ocrText is touched: matchMethod in particular is read by the
//      learning-rule cron as a FAILURE signal.
//   2. OWNER SCOPING. userId is in the WHERE clause, so one collector cannot
//      label another's scan by guessing an id.
//   3. SILENCE IS NOT REJECTION. Rejection is recorded only when explicitly
//      stated; nothing infers it from a missing confirmation.
//   4. FAIL-SILENT. A label is observational — losing one costs a data point,
//      whereas throwing would cost the collector the add itself.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/scan-outcome-label.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  recordScanConfirmation,
  recordScanRejection,
  type ScanLabelDb,
} from "@/lib/scanner/scan-outcome-label";
import { buildScanTelemetry, withConfirmation, withRejection } from "@/lib/scanner/telemetry";
import { acceptDecision, disambiguateDecision } from "@/lib/scanner/decision";
import type { CandidatePrinting, ScanEvidence } from "@/lib/scanner/evidence";
import type { ScoreOutput } from "@/lib/scanner/score";

// ─── Fixtures ────────────────────────────────────────────────────────────────

const OWNER = "user-owner";

function fakeDb(rows: Array<{ id: string; userId: string; ocrText: string | null }>, opts: { throws?: boolean } = {}) {
  const calls: any[] = [];
  const db: ScanLabelDb & { calls: any[]; rows: typeof rows } = {
    calls,
    rows,
    scanHistory: {
      findFirst: async (args: any) => {
        calls.push({ op: "findFirst", args });
        if (opts.throws) throw new Error("simulated DB error");
        const w = args?.where ?? {};
        return rows.find((r) => r.id === w.id && r.userId === w.userId) ?? null;
      },
      updateMany: async (args: any) => {
        calls.push({ op: "updateMany", args });
        if (opts.throws) throw new Error("simulated DB error");
        const w = args?.where ?? {};
        const hit = rows.find((r) => r.id === w.id && r.userId === w.userId);
        if (!hit) return { count: 0 };
        Object.assign(hit, args.data);
        return { count: 1 };
      },
    },
  };
  return db;
}

const baseTelemetry = () => JSON.stringify({ v: 1, decision: { action: "accept" }, acceptedExternalId: "me1-138" });

// ─── 1. No count is contaminated ─────────────────────────────────────────────

describe("the label write can never inflate a scan count", () => {
  test("uses updateMany (which cannot insert) and never create/upsert", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "me1-138", db });
    const ops = db.calls.map((c) => c.op);
    assert.deepEqual(ops, ["findFirst", "updateMany"]);
    assert.ok(!ops.includes("create"), "a create would invent a scan that never happened");
    assert.ok(!ops.includes("upsert"), "an upsert can insert — same hazard");
  });

  test("writes ocrText and NOTHING else — matchMethod is load-bearing elsewhere", async () => {
    // api/cron/analyze-scans reads matchMethod === "user-selection" as its
    // FAILURE signal. Writing a method here would teach it that successful
    // confirmations were failures.
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "me1-138", db });
    const update = db.calls.find((c) => c.op === "updateMany");
    assert.deepEqual(Object.keys(update.args.data), ["ocrText"]);
  });

  test("a scan that does not exist writes nothing at all", async () => {
    const db = fakeDb([]);
    assert.equal(await recordScanConfirmation({ scanId: "ghost", userId: OWNER, externalId: "x", db }), false);
    assert.equal(db.calls.filter((c) => c.op === "updateMany").length, 0);
  });
});

// ─── 2. Owner scoping ────────────────────────────────────────────────────────

describe("labels are scoped to the scan's owner", () => {
  test("another user's scan is not found, and not written", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    const ok = await recordScanConfirmation({ scanId: "scan-1", userId: "user-attacker", externalId: "x", db });
    assert.equal(ok, false);
    assert.equal(db.rows[0].ocrText, baseTelemetry(), "the owner's telemetry is untouched");
  });

  test("userId is in the WHERE of the write itself, not merely checked first", async () => {
    // Checking ownership on the read and then writing by id alone would leave a
    // window where the row changed hands between the two statements.
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanRejection({ scanId: "scan-1", userId: OWNER, db });
    const update = db.calls.find((c) => c.op === "updateMany");
    assert.equal(update.args.where.userId, OWNER);
    assert.equal(update.args.where.id, "scan-1");
  });
});

// ─── 3. What the labels record ───────────────────────────────────────────────

describe("confirmation and rejection record observed facts", () => {
  test("confirmation records the card ACTUALLY added, enabling overturn detection", async () => {
    // The collector added a DIFFERENT printing than the scan accepted. Recording
    // the accepted id here instead would erase exactly that disagreement.
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "sv7-1", game: "POKEMON", db });
    const saved = JSON.parse(db.rows[0].ocrText!);
    assert.equal(saved.confirmation.externalId, "sv7-1");
    assert.equal(saved.acceptedExternalId, "me1-138", "what the scan accepted is preserved for comparison");
    assert.ok(saved.confirmation.at, "carries a timestamp");
  });

  test("rejection can name the replacement when the collector picked one", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanRejection({ scanId: "scan-1", userId: OWNER, replacedByExternalId: "sv7-1", db });
    assert.equal(JSON.parse(db.rows[0].ocrText!).rejection.replacedByExternalId, "sv7-1");
  });

  test("nothing infers rejection from an absent confirmation", async () => {
    // A scan nobody acted on carries neither label — it is unjudged, not
    // rejected. Inferring otherwise would manufacture a disagreement rate.
    const raw = baseTelemetry();
    const parsed = JSON.parse(raw);
    assert.equal(parsed.rejection, undefined);
    assert.equal(parsed.confirmation, undefined);
  });

  test("existing telemetry survives — the label is purely additive", async () => {
    const rich = JSON.stringify({ v: 1, evidence: { identity: {} }, decision: { action: "accept", method: "set-cn-verified" }, acceptedExternalId: "a-1", selection: { externalId: "a-1", at: "t" } });
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: rich }]);
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "a-1", db });
    const saved = JSON.parse(db.rows[0].ocrText!);
    assert.equal(saved.v, 1, "version is unchanged — the field is additive");
    assert.equal(saved.decision.method, "set-cn-verified");
    assert.equal(saved.selection.externalId, "a-1");
    assert.equal(saved.confirmation.externalId, "a-1");
  });

  test("a rejection then a confirmation keeps BOTH — the second does not unmake the first", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }]);
    await recordScanRejection({ scanId: "scan-1", userId: OWNER, db });
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "me1-138", db });
    const saved = JSON.parse(db.rows[0].ocrText!);
    assert.ok(saved.rejection, "the hesitation is still on the record");
    assert.ok(saved.confirmation);
  });
});

// ─── 4. Fail-silent ──────────────────────────────────────────────────────────

describe("a failed label never breaks the collector's action", () => {
  test("a DB error returns false instead of throwing", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: baseTelemetry() }], { throws: true });
    assert.equal(await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "x", db }), false);
    assert.equal(await recordScanRejection({ scanId: "scan-1", userId: OWNER, db }), false);
  });

  test("corrupt existing telemetry does not lose the new label", async () => {
    const db = fakeDb([{ id: "scan-1", userId: OWNER, ocrText: "{not json" }]);
    await recordScanConfirmation({ scanId: "scan-1", userId: OWNER, externalId: "me1-138", db });
    assert.equal(JSON.parse(db.rows[0].ocrText!).confirmation.externalId, "me1-138");
  });

  test("a null ocrText still yields a valid v:1 record", () => {
    assert.equal(JSON.parse(withConfirmation(null, { externalId: "a" })).v, 1);
    assert.equal(JSON.parse(withRejection(undefined, {})).v, 1);
  });
});

// ─── 5. acceptedExternalId is recorded only when something was accepted ──────

describe("buildScanTelemetry records the accepted printing", () => {
  const evidence = { identity: {}, printing: {} } as unknown as ScanEvidence;
  const scored = { evidenceSignals: [], evidenceCoverage: undefined, margin: 1, evidenceMass: 1, methodLabel: "m" } as unknown as ScoreOutput;
  const card = (id: string) => ({ externalId: id, name: "Vulpix", game: "POKEMON", setName: "Mega Evolution", rarity: "Common", imageUrl: null, thumbnailUrl: null, price: { marketPrice: 0 } }) as CandidatePrinting;

  test("an accept records which printing it accepted", () => {
    const t = buildScanTelemetry({ evidence, scored, decision: acceptDecision(card("me1-138"), "set-cn-verified"), printingsCount: 1 });
    assert.equal(t.acceptedExternalId, "me1-138");
  });

  test("a disambiguate records NO accepted id — it accepted nothing", () => {
    const t = buildScanTelemetry({ evidence, scored, decision: disambiguateDecision([card("a"), card("b")]), printingsCount: 2 });
    assert.equal(t.acceptedExternalId, undefined);
  });
});
