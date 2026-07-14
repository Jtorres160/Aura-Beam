// Evidence Calibration Analysis Layer (Phase 5.11).
//
// PURPOSE: MEASUREMENT, not tuning. This module aggregates the per-signal and
// coverage records that calibration already produces (assessIdentitySignals →
// EvidenceSignal[], calculateEvidenceCoverage → EvidenceCoverage) across many
// fixtures and answers one question: do the current evidence weights and the
// available signals model collector reality?
//
// It is analysis ONLY. It does NOT — and CANNOT — change EVIDENCE_WEIGHTS,
// ranking formulas, decision thresholds, or any acceptance rule. It reads the
// evidence model; it never writes it. Every number here is derived from signals
// the scanner already reports, using the exact same arithmetic the runtime uses
// (calculateEvidenceMass / calculateEvidenceCoverage) so an observation can
// never drift from what the scanner actually did.
//
// It is deliberately game-agnostic: MTG, Pokémon and Yu-Gi-Oh samples flow
// through the same aggregation. Game only ever appears as a GROUPING KEY in the
// output (coverage-by-game, unavailable-sensor warnings), never as an `if
// (game === …)` branch in the logic. Adding a game needs no change here.
//
// Output is structured (for tests) plus a human-readable formatter (for the
// calibration notebook). The four sections mirror the Phase 5.11 brief:
//   1. Signal frequency        — how often each signal matched / mismatched / …
//   2. Signal contribution     — how often each signal confirmed / contradicted
//   3. Coverage analysis       — expected vs present vs failed vs unavailable
//   4. Calibration warnings    — OBSERVATIONS only ("X produced contradictions"),
//                                never recommendations ("increase X weight").

import {
  calculateEvidenceCoverage,
  calculateEvidenceMass,
  type EvidenceSignal,
  type EvidenceSignalType,
  type GameId,
} from "@/lib/scanner/evidence";

// ─── Input ───────────────────────────────────────────────────────────────────
// The smallest shape that carries what analysis needs: the game (grouping key),
// a human label (for traceability), and the signal set the scanner assessed.
// EvidenceMass and EvidenceCoverage are NOT passed in — they are DERIVED from
// `signals` with the runtime's own functions, so a sample can't misreport them.
// This shape is a strict subset of both a telemetry record's captured fields and
// a CalibrationCase, so existing fixtures feed it directly with no reshaping.

export interface CalibrationSample {
  game: GameId;
  /** Short human label for the fixture, e.g. "Lightning Bolt SOS wrong CN". */
  fixture: string;
  /** The candidate's assessed identity signals (from assessIdentitySignals). */
  signals: EvidenceSignal[];
}

// ─── Structured output ───────────────────────────────────────────────────────

/** Section 1 + 2: per-signal-type tallies aggregated across every sample.
 *  State counts (match/mismatch/unknown) answer "signal frequency"; the same
 *  rows reframed as confirm/contradict answer "signal contribution"; the
 *  availability counts (supported/failed/unavailable) answer "coverage". */
export interface SignalStats {
  type: EvidenceSignalType;
  // ── state axis (drives EvidenceMass) ──
  match: number;
  mismatch: number;
  unknown: number;
  // ── availability axis (drives coverage; never EvidenceMass) ──
  supported: number;
  failed: number;
  unavailable: number;
  /** Every occurrence of this signal type across all samples. */
  total: number;
}

/** Section 3: coverage rolled up per game. All counts are SUMS across the
 *  game's samples, which keeps them additive and exactly reconciled:
 *  `present + failed === expected` and `present + failed + unavailable === total`.
 *  `massTotal` is the summed net EvidenceMass — its average per sample surfaces
 *  the cross-game "evidence ceiling" (why a Pokémon scan tops out lower). */
export interface GameCoverage {
  game: GameId;
  /** How many samples of this game were analyzed. */
  samples: number;
  /** Sum of expected sensors (== present + failed): the ceiling the source offers. */
  expected: number;
  /** Sum of sensors that produced a reading (availability "supported"). */
  present: number;
  /** Sum of sensors that should have fired but didn't (availability "failed"). */
  failed: number;
  /** Sum of sensors the source cannot provide for this game (availability "unavailable"). */
  unavailable: number;
  /** Sum of net EvidenceMass across the game's samples (observational). */
  massTotal: number;
}

export interface CalibrationAnalysis {
  sampleCount: number;
  /** Per-signal tallies, in canonical signal order. */
  signals: SignalStats[];
  /** Coverage rolled up per game, in first-seen order. */
  coverage: GameCoverage[];
  /** Human-readable OBSERVATIONS — never recommendations. See generateWarnings. */
  warnings: string[];
}

// ─── Canonical ordering ──────────────────────────────────────────────────────
// Mirrors assessIdentitySignals' stable order so reports read consistently. Any
// signal type NOT in this list (e.g. a future treatment signal) still appears —
// appended after the known ones — so the analysis never silently drops a signal.
const SIGNAL_ORDER: EvidenceSignalType[] = ["name", "setCode", "collectorNumber", "rarity", "artwork"];

function orderTypes(types: Iterable<EvidenceSignalType>): EvidenceSignalType[] {
  return [...types].sort((a, b) => {
    const ia = SIGNAL_ORDER.indexOf(a);
    const ib = SIGNAL_ORDER.indexOf(b);
    // Known types keep canonical order; unknown types sort after, alphabetically.
    if (ia === -1 && ib === -1) return a < b ? -1 : a > b ? 1 : 0;
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });
}

function emptyStats(type: EvidenceSignalType): SignalStats {
  return { type, match: 0, mismatch: 0, unknown: 0, supported: 0, failed: 0, unavailable: 0, total: 0 };
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/**
 * Aggregate calibration samples into structured observations. Pure and
 * deterministic — it reads each sample's signals and derives mass/coverage with
 * the runtime's own functions. It never mutates the input (signals are only
 * read), never touches EVIDENCE_WEIGHTS, and returns no recommendation.
 */
export function analyzeCalibration(samples: CalibrationSample[]): CalibrationAnalysis {
  const statsByType = new Map<EvidenceSignalType, SignalStats>();
  // Preserve first-seen game order for stable, readable coverage output.
  const coverageByGame = new Map<GameId, GameCoverage>();
  // Track, per (game, signal type), whether it was EVER available — so a signal
  // that is unavailable in EVERY sample of a game can be flagged as structural.
  const everAvailable = new Map<string, boolean>();

  for (const sample of samples) {
    // Per-signal state + availability tallies (sections 1–3, global view).
    for (const s of sample.signals) {
      const stats = statsByType.get(s.type) ?? emptyStats(s.type);
      stats.total++;
      if (s.state === "match") stats.match++;
      else if (s.state === "mismatch") stats.mismatch++;
      else stats.unknown++;
      if (s.availability === "supported") stats.supported++;
      else if (s.availability === "failed") stats.failed++;
      else stats.unavailable++;
      statsByType.set(s.type, stats);

      const key = `${sample.game}:${s.type}`;
      const avail = s.availability !== "unavailable";
      everAvailable.set(key, (everAvailable.get(key) ?? false) || avail);
    }

    // Per-game coverage roll-up — derived with the SAME function the scorer uses.
    const cov = calculateEvidenceCoverage(sample.signals);
    const mass = calculateEvidenceMass(sample.signals);
    const g = coverageByGame.get(sample.game) ?? {
      game: sample.game,
      samples: 0,
      expected: 0,
      present: 0,
      failed: 0,
      unavailable: 0,
      massTotal: 0,
    };
    g.samples++;
    g.expected += cov.expected;
    g.present += cov.present;
    g.failed += cov.failed;
    g.unavailable += cov.unavailable;
    g.massTotal += mass;
    coverageByGame.set(sample.game, g);
  }

  const signals = orderTypes(statsByType.keys()).map((t) => statsByType.get(t)!);
  const coverage = [...coverageByGame.values()];
  const warnings = generateWarnings(samples, signals, coverage, everAvailable);

  return { sampleCount: samples.length, signals, coverage, warnings };
}

// ─── Section 4: calibration warnings (OBSERVATIONS ONLY) ─────────────────────
// STRICT RULE: every string here describes what WAS observed. None prescribes a
// change. No "increase", "decrease", "raise", "lower", "tune", "adjust", or
// "weight" — those decisions belong to a later tuning phase, never to this
// measurement one. The warnings are conservative and threshold-driven so the
// same corpus always produces the same observations.

/** Fraction of a signal type's occurrences that were `unknown` and, of those,
 *  how many were `failed` (a coverage gap) vs `unavailable` (structural). */
const FREQUENT_UNKNOWN_FRACTION = 0.5;

function generateWarnings(
  samples: CalibrationSample[],
  signals: SignalStats[],
  coverage: GameCoverage[],
  everAvailable: Map<string, boolean>,
): string[] {
  const warnings: string[] = [];

  // (a) Contradictions: a signal that ever reported `mismatch` across fixtures.
  //     Purely counts what happened — does not judge whether the weight is right.
  for (const s of signals) {
    if (s.mismatch > 0) {
      warnings.push(
        `${s.type} produced ${s.mismatch} contradiction${s.mismatch === 1 ? "" : "s"} across ${s.total} fixture${s.total === 1 ? "" : "s"}`,
      );
    }
  }

  // (b) Frequently unknown despite a SUPPORTED source (availability "failed"):
  //     the sensor could have fired but produced no usable reading — e.g. rarity
  //     whose printed spelling isn't in normalizeRarity's table. Observation only.
  for (const s of signals) {
    if (s.total === 0) continue;
    const unknownFraction = s.unknown / s.total;
    if (unknownFraction >= FREQUENT_UNKNOWN_FRACTION && s.failed > 0) {
      warnings.push(
        `${s.type} frequently unknown (${s.failed}/${s.total} produced no reading — normalization or capture coverage gap)`,
      );
    }
  }

  // (c) Structurally unavailable per game: a signal that was `unavailable` in
  //     EVERY sample of a game — the source cannot provide it (Pokémon artwork,
  //     Yu-Gi-Oh collector number). Reported per game since availability is a
  //     source capability, not a scan outcome. Still an observation, not a fix.
  for (const g of coverage) {
    if (g.samples === 0) continue;
    for (const type of SIGNAL_ORDER) {
      const key = `${g.game}:${type}`;
      // Only flag types that actually appear for this game and were never available.
      if (everAvailable.has(key) && everAvailable.get(key) === false) {
        warnings.push(`${type} unavailable for ${g.game} source`);
      }
    }
  }

  return warnings;
}

// ─── Human-readable formatter ────────────────────────────────────────────────
// Renders the structured analysis as a fixed-width notebook block, matching the
// house style of formatCalibrationReport. Pure — no I/O; callers decide whether
// to print it. Divides massTotal by samples only for a readable average; the
// structured data keeps the exact sums.

function pct(part: number, whole: number): string {
  if (whole === 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

export function formatCalibrationAnalysis(a: CalibrationAnalysis): string {
  const lines: string[] = [];
  lines.push(`Evidence Calibration Analysis`);
  lines.push(``);
  lines.push(`Samples analyzed: ${a.sampleCount}`);

  // ── Section 1 + 2: signal frequency & contribution ──
  lines.push(``, `Signal frequency & contribution:`);
  const TYPE_W = 16;
  for (const s of a.signals) {
    const type = s.type.padEnd(TYPE_W);
    lines.push(
      `${type}match ${s.match}  mismatch ${s.mismatch}  unknown ${s.unknown}` +
        `  (unavailable ${s.unavailable}, failed ${s.failed})`,
    );
  }

  // ── Section 3: coverage per game ──
  lines.push(``, `Coverage by game:`);
  for (const g of a.coverage) {
    const perScanExpected = g.samples ? (g.expected / g.samples).toFixed(0) : "0";
    const avgMass = g.samples ? (g.massTotal / g.samples).toFixed(1) : "0.0";
    lines.push(
      `${g.game.padEnd(8)} ${g.present}/${g.expected} sensors present ` +
        `(${pct(g.present, g.expected)}), ${g.failed} failed, ${g.unavailable} unavailable ` +
        `— ${g.samples} sample${g.samples === 1 ? "" : "s"}, ~${perScanExpected} expected/scan, avg mass ${avgMass}`,
    );
  }

  // ── Section 4: calibration warnings ──
  lines.push(``, `Calibration observations:`);
  if (a.warnings.length === 0) {
    lines.push(`(none)`);
  } else {
    for (const w of a.warnings) lines.push(`- ${w}`);
  }

  return lines.join("\n");
}
