// ─── Recognition Baseline (Scanner V2 · Milestone 0) ────────────────────────
// Measurement-ONLY analysis of the CURRENT recognition pipeline, computed from
// the telemetry every scan already writes to ScanHistory.ocrText. It changes no
// scan behavior, emits no new telemetry, and is never imported by the app — it
// is read by scripts/recognition-baseline.mjs and by its unit tests.
//
// Why this exists: Scanner V2 will add a local recognizer as a new EVIDENCE
// source. Before that, we must know the ground we stand on — how the pipeline
// decides today, how safe Recognition-Memory serve would be, how much repeat
// work memory could save, and how scans fail. "Matches or beats" is unprovable
// without this baseline.
//
// Honesty boundary (the same one the rest of the telemetry layer holds): this
// module never invents a number. Where true accuracy is unmeasurable without a
// labeled dataset, it reports the OUTCOME distribution and the AGREEMENT proxies
// we can actually compute, and names the gap — it does not manufacture an
// accuracy figure out of unlabeled accepts.

import { recordKind } from "@/lib/scanner/telemetry-interpretation";

// ─── Defensive readers ───────────────────────────────────────────────────────
// Records come straight from JSON.parse of a text column written across many
// app versions. Every access is guarded; an unreadable field contributes
// nothing rather than throwing.

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}
function str(x: unknown): string | undefined {
  return typeof x === "string" ? x : undefined;
}
function num(x: unknown): number | undefined {
  return typeof x === "number" && Number.isFinite(x) ? x : undefined;
}
function bool(x: unknown): boolean {
  return x === true;
}

// ─── Result shape ────────────────────────────────────────────────────────────

/** Distribution of the scorer/gate verdict over scored records. */
export interface OutcomeBreakdown {
  /** Records where the scorer produced a decision (buildScanTelemetry). */
  scored: number;
  accept: number;
  disambiguate: number;
  /** decision.action === "not-found" — the SCORER got zero printings. Distinct
   *  from a candidate-layer "no card exists" verdict (see failureModes). */
  scorerNotFound: number;
  /** Accepts split by the method that produced them (set-cn-verified, …). */
  acceptsByMethod: Record<string, number>;
  /** Accepts and disambiguations split by scan mode. */
  autoScanAccepts: number;
  interactiveAccepts: number;
}

/** Recognition-Memory shadow audit — the serve-safety verdict lives here. */
export interface MemoryAudit {
  /** Records carrying a `memory` shadow block. */
  observed: number;
  hits: number;
  misses: number;
  byMatchedBy: { setCn: number; name: number };
  agreement: { agree: number; disagree: number; memoryOnly: number; na: number };
  /** Hits the tightened serve gate WOULD have served (eligible + over threshold). */
  wouldServe: number;
  /** Hits that would have skipped every provider on a repeat scan. */
  wouldAvoidProviders: number;
  /** Total provider sources those avoidable hits actually consulted — the raw
   *  provider-call volume memory could remove. */
  providerCallsAvoidable: number;
  /** THE gate for enabling serve: zero disagreements ⇒ clean. */
  serveSafety: "clean" | "blocked" | "no-data";
  /** externalId pairs for any disagreement, so a human can inspect them. */
  disagreements: Array<{ memory?: string; pipeline?: string }>;
}

/** Repeat-scan volume and the resilience (memory-only) subset. */
export interface RepeatScanSummary {
  /** Scans that were of an already-verified identity (a memory hit). */
  repeats: number;
  /** Of those, ones where the LIVE pipeline failed to accept but memory held the
   *  identity — the pure provider-independence win. */
  resilienceWins: number;
  /** repeats / observed, as a fraction (0 when nothing observed). */
  repeatRate: number;
}

/** What ground truth exists today — the seed of the labeled eval set. */
export interface GroundTruthSummary {
  /** Records carrying a user disambiguation pick (`selection`) — hard labels. */
  userSelections: number;
  /** Records carrying at least one failed save attempt (provider wouldn't confirm). */
  selectionFailures: number;
}

/** Truthful taxonomy of how attempts ended, across EVERY record shape. */
export interface FailureModeSummary {
  totalRecords: number;
  byKind: Record<string, number>;
  /** The card-less endings, named. */
  noCardExists: number;        // candidate layer: no_candidates
  providerUnavailable: number; // candidate layer or failure stage
  ocrFailed: number;           // OCR call errored/timed out
  noCardInFrame: number;       // OCR ran, saw no card
  databaseFailed: number;
  rateLimited: number;
  otherError: number;
}

/** Recognition-cost baseline (the latency V2 targets). */
export interface OcrCostSummary {
  /** Count of records carrying an ocrMs timing. */
  n: number;
  medianMs: number | null;
  p95Ms: number | null;
}

export interface RecognitionBaseline {
  totalRecords: number;
  outcomes: OutcomeBreakdown;
  memory: MemoryAudit;
  repeatScans: RepeatScanSummary;
  groundTruth: GroundTruthSummary;
  failureModes: FailureModeSummary;
  ocrCost: OcrCostSummary;
}

// ─── Percentile helper ───────────────────────────────────────────────────────

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

// ─── Analysis ────────────────────────────────────────────────────────────────

/**
 * Compute the recognition baseline from parsed telemetry records. Input is the
 * same `unknown[]` the interpretation layer consumes — every record shape
 * (scored / failure / error / selection-only) is tolerated.
 */
export function analyzeRecognitionBaseline(records: unknown[]): RecognitionBaseline {
  const outcomes: OutcomeBreakdown = {
    scored: 0, accept: 0, disambiguate: 0, scorerNotFound: 0,
    acceptsByMethod: {}, autoScanAccepts: 0, interactiveAccepts: 0,
  };
  const memory: MemoryAudit = {
    observed: 0, hits: 0, misses: 0,
    byMatchedBy: { setCn: 0, name: 0 },
    agreement: { agree: 0, disagree: 0, memoryOnly: 0, na: 0 },
    wouldServe: 0, wouldAvoidProviders: 0, providerCallsAvoidable: 0,
    serveSafety: "no-data", disagreements: [],
  };
  const groundTruth: GroundTruthSummary = { userSelections: 0, selectionFailures: 0 };
  const byKind: Record<string, number> = {};
  const failureModes: FailureModeSummary = {
    totalRecords: 0, byKind,
    noCardExists: 0, providerUnavailable: 0, ocrFailed: 0,
    noCardInFrame: 0, databaseFailed: 0, rateLimited: 0, otherError: 0,
  };
  const ocrMsValues: number[] = [];

  for (const record of records) {
    if (!isObject(record)) {
      byKind.unrecognized = (byKind.unrecognized ?? 0) + 1;
      continue;
    }
    const kind = recordKind(record);
    byKind[kind] = (byKind[kind] ?? 0) + 1;

    // ── OCR cost (recognition latency) — present on any record with timings ──
    const timings = record.timings;
    if (isObject(timings)) {
      const ocrMs = num(timings.ocrMs);
      if (ocrMs !== undefined) ocrMsValues.push(ocrMs);
    }

    // ── Ground truth labels ──
    if (isObject(record.selection)) groundTruth.userSelections++;
    if (Array.isArray(record.selectionAttempts) && record.selectionAttempts.length > 0) {
      groundTruth.selectionFailures++;
    }

    // ── Scored-record outcome distribution ──
    if (kind === "scored" && isObject(record.decision)) {
      outcomes.scored++;
      const action = str(record.decision.action);
      const method = str(record.decision.method);
      const isAuto = bool(record.isAutoScan);
      if (action === "accept") {
        outcomes.accept++;
        if (method) outcomes.acceptsByMethod[method] = (outcomes.acceptsByMethod[method] ?? 0) + 1;
        if (isAuto) outcomes.autoScanAccepts++; else outcomes.interactiveAccepts++;
      } else if (action === "disambiguate") {
        outcomes.disambiguate++;
      } else if (action === "not-found") {
        outcomes.scorerNotFound++;
      }

      // ── Failure taxonomy from the candidate layer's own verdict ──
      const candidateStatus = str(record.candidateStatus);
      if (candidateStatus === "no_candidates") failureModes.noCardExists++;
      else if (candidateStatus === "provider_unavailable") failureModes.providerUnavailable++;
    }

    // ── Failure/error record taxonomy ──
    if (kind === "failure") {
      const stage = str(record.failureStage);
      const extraction = str(record.extractionStatus);
      if (extraction === "no_card") failureModes.noCardInFrame++;
      else if (extraction === "failed" || stage === "ocr") failureModes.ocrFailed++;
      else if (stage === "database") failureModes.databaseFailed++;
      else if (stage === "rate-limit") failureModes.rateLimited++;
      else failureModes.otherError++;
    } else if (kind === "error") {
      const err = isObject(record.error) ? record.error : undefined;
      const stage = err ? str(err.stage) : undefined;
      if (stage === "database") failureModes.databaseFailed++;
      else if (stage === "rate-limit") failureModes.rateLimited++;
      else failureModes.otherError++;
    }

    // ── Recognition-Memory shadow audit ──
    const mem = record.memory;
    if (isObject(mem)) {
      memory.observed++;
      const outcome = str(mem.outcome);
      if (outcome === "hit") {
        memory.hits++;
        const matchedBy = str(mem.matchedBy);
        if (matchedBy === "set-cn") memory.byMatchedBy.setCn++;
        else if (matchedBy === "name") memory.byMatchedBy.name++;
        if (bool(mem.wouldServe)) memory.wouldServe++;
        if (bool(mem.wouldAvoidProviders)) {
          memory.wouldAvoidProviders++;
          const consulted = num(mem.providerSourcesConsulted);
          if (consulted !== undefined) memory.providerCallsAvoidable += consulted;
        }
      } else if (outcome === "miss") {
        memory.misses++;
      }
      const agreement = str(mem.agreement);
      if (agreement === "agree") memory.agreement.agree++;
      else if (agreement === "disagree") {
        memory.agreement.disagree++;
        memory.disagreements.push({
          memory: str(mem.memoryExternalId),
          pipeline: str(mem.pipelineExternalId),
        });
      } else if (agreement === "memory-only") memory.agreement.memoryOnly++;
      else if (agreement === "n/a") memory.agreement.na++;
    }
  }

  // Serve-safety verdict: the whole point of the audit. Serve may be enabled
  // only when memory NEVER disagreed with the live pipeline on a card both
  // accepted. No observations ⇒ we cannot vouch for it yet.
  memory.serveSafety =
    memory.observed === 0 ? "no-data" : memory.agreement.disagree === 0 ? "clean" : "blocked";

  const repeats = memory.hits;
  const repeatScans: RepeatScanSummary = {
    repeats,
    resilienceWins: memory.agreement.memoryOnly,
    repeatRate: memory.observed > 0 ? repeats / memory.observed : 0,
  };

  failureModes.totalRecords = records.length;

  const sortedOcr = [...ocrMsValues].sort((a, b) => a - b);
  const ocrCost: OcrCostSummary = {
    n: sortedOcr.length,
    medianMs: percentile(sortedOcr, 50),
    p95Ms: percentile(sortedOcr, 95),
  };

  return {
    totalRecords: records.length,
    outcomes,
    memory,
    repeatScans,
    groundTruth,
    failureModes,
    ocrCost,
  };
}

// ─── Human-readable report ───────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (d === 0) return "—";
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function formatRecognitionBaseline(b: RecognitionBaseline): string {
  const L: string[] = [];
  const o = b.outcomes;
  L.push("Recognition Baseline (Scanner V2 · M0)");
  L.push("═══════════════════════════════════════");
  L.push(`  Records analyzed            ${b.totalRecords}`);
  L.push("");
  L.push("Outcome distribution (scored records)");
  L.push("─────────────────────────────────────");
  L.push(`  Scored                      ${o.scored}`);
  L.push(`  Accept                      ${o.accept}   (${pct(o.accept, o.scored)})`);
  L.push(`    · auto/bulk               ${o.autoScanAccepts}`);
  L.push(`    · interactive             ${o.interactiveAccepts}`);
  L.push(`  Disambiguate (user picks)   ${o.disambiguate}   (${pct(o.disambiguate, o.scored)})`);
  L.push(`  Scorer not-found            ${o.scorerNotFound}`);
  for (const [method, n] of Object.entries(o.acceptsByMethod).sort((a, b) => b[1] - a[1])) {
    L.push(`    accept·${method.padEnd(20)} ${n}`);
  }
  L.push("");
  L.push("Recognition-Memory shadow audit");
  L.push("───────────────────────────────");
  L.push(`  Observed (has memory block) ${b.memory.observed}`);
  L.push(`  Hits / Misses               ${b.memory.hits} / ${b.memory.misses}`);
  L.push(`    · matched by set-cn       ${b.memory.byMatchedBy.setCn}`);
  L.push(`    · matched by name         ${b.memory.byMatchedBy.name}`);
  L.push(`  Agreement  agree            ${b.memory.agreement.agree}`);
  L.push(`             disagree         ${b.memory.agreement.disagree}   ← must be 0 to serve`);
  L.push(`             memory-only      ${b.memory.agreement.memoryOnly}   (resilience wins)`);
  L.push(`             n/a (miss)       ${b.memory.agreement.na}`);
  L.push(`  Would serve (gated)         ${b.memory.wouldServe}`);
  L.push(`  Provider calls avoidable    ${b.memory.providerCallsAvoidable}  over ${b.memory.wouldAvoidProviders} hits`);
  L.push(`  SERVE SAFETY                ${b.memory.serveSafety.toUpperCase()}`);
  if (b.memory.disagreements.length > 0) {
    L.push(`  ⚠ disagreements:`);
    for (const d of b.memory.disagreements) L.push(`      memory=${d.memory ?? "?"} pipeline=${d.pipeline ?? "?"}`);
  }
  L.push("");
  L.push("Repeat scans & provider independence");
  L.push("────────────────────────────────────");
  L.push(`  Repeat scans (known cards)  ${b.repeatScans.repeats}   (${(b.repeatScans.repeatRate * 100).toFixed(1)}% of observed)`);
  L.push(`  Resilience wins (mem-only)  ${b.repeatScans.resilienceWins}`);
  L.push("");
  L.push("Ground truth available (seed of labeled set)");
  L.push("────────────────────────────────────────────");
  L.push(`  User selections (labels)    ${b.groundTruth.userSelections}`);
  L.push(`  Selection failures          ${b.groundTruth.selectionFailures}`);
  L.push("");
  L.push("Failure modes");
  L.push("─────────────");
  L.push(`  No card exists (verified)   ${b.failureModes.noCardExists}`);
  L.push(`  Provider unavailable        ${b.failureModes.providerUnavailable}`);
  L.push(`  OCR failed (call errored)   ${b.failureModes.ocrFailed}`);
  L.push(`  No card in frame            ${b.failureModes.noCardInFrame}`);
  L.push(`  Database failed             ${b.failureModes.databaseFailed}`);
  L.push(`  Rate limited                ${b.failureModes.rateLimited}`);
  L.push(`  Other error                 ${b.failureModes.otherError}`);
  L.push("");
  L.push("Recognition cost (OCR latency — the V2 target)");
  L.push("──────────────────────────────────────────────");
  L.push(`  Samples                     ${b.ocrCost.n}`);
  L.push(`  Median ocrMs                ${b.ocrCost.medianMs ?? "—"}`);
  L.push(`  p95 ocrMs                   ${b.ocrCost.p95Ms ?? "—"}`);
  return L.join("\n");
}
