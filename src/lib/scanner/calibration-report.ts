// Evidence calibration report (Phase 5.7).
//
// PURPOSE: turn calibration fixtures into a living, human-reviewable notebook.
// This module is OBSERVATION TOOLING only. It reads the evidence model; it does
// NOT change EVIDENCE_WEIGHTS, ranking, decision thresholds, or acceptance
// rules. It renders one candidate's identity signals as a signed contribution
// table so a human calibrating weights can see, at a glance, exactly which
// signals pushed the EvidenceMass up or down and whether that matches intent.
//
// It is intentionally game-agnostic so the MTG, Pokémon, and Yu-Gi-Oh
// calibration corpora (Phase 5.7 → 5.9) all render the same way.

import {
  calculateEvidenceMass,
  type EvidenceSignal,
  type GameId,
} from "@/lib/scanner/evidence";

/** The signed EvidenceMass contribution of one signal:
 *  match → +weight, mismatch → −weight, unknown → 0. Mirrors the exact
 *  arithmetic of calculateEvidenceMass, per signal, for the report table. */
export function signalContribution(signal: EvidenceSignal): number {
  if (signal.state === "match") return signal.weight;
  if (signal.state === "mismatch") return -signal.weight;
  return 0; // unknown → neutral
}

/** One fixture's calibration record: what was observed and what a human expects. */
export interface CalibrationCase {
  game: GameId;
  /** Short human label for the fixture, e.g. "Lightning Bolt SOS wrong CN". */
  fixture: string;
  /** The candidate's assessed identity signals (from assessIdentitySignals). */
  signals: EvidenceSignal[];
  /** What a collector would expect the system to do. Plain language. */
  humanExpectation: string;
  /** Optional calibration observation — e.g. "collectorNumber may need review". */
  calibrationNote?: string;
}

/** Format a signed number with an explicit sign and one decimal: +1.5, -2.0, 0.0. */
function signed(n: number): string {
  const fixed = Math.abs(n).toFixed(1);
  if (n > 0) return `+${fixed}`;
  if (n < 0) return `-${fixed}`;
  return `0.0`;
}

/**
 * Render a calibration case as a fixed-width report block, matching the shape
 * the calibration notebook uses:
 *
 *   MTG Evidence Calibration Report
 *
 *   Fixture:
 *   Lightning Bolt SOS wrong CN
 *
 *   Signals:
 *   name             MATCH       +1.5
 *   setCode          MATCH       +1.5
 *   collectorNumber  MISMATCH    -2.0
 *   rarity           MATCH       +0.5
 *   artwork          MATCH       +2.5
 *
 *   Total:
 *   +4.0
 *
 *   Human expectation:
 *   Reject wrong printing
 *
 *   Calibration note:
 *   collectorNumber contradiction may need review
 *
 * Pure and deterministic — no I/O. Callers decide whether to print it.
 */
export function formatCalibrationReport(c: CalibrationCase): string {
  const TYPE_WIDTH = 16; // widest signal type is "collectorNumber" (15) + 1
  const STATE_WIDTH = 12; // widest state is "MISMATCH" (8) with padding

  const rows = c.signals.map((s) => {
    const type = s.type.padEnd(TYPE_WIDTH);
    const state = s.state.toUpperCase().padEnd(STATE_WIDTH);
    return `${type}${state}${signed(signalContribution(s))}`;
  });

  const total = calculateEvidenceMass(c.signals);

  const lines = [
    `${c.game} Evidence Calibration Report`,
    ``,
    `Fixture:`,
    c.fixture,
    ``,
    `Signals:`,
    ...rows,
    ``,
    `Total:`,
    signed(total),
    ``,
    `Human expectation:`,
    c.humanExpectation,
  ];

  if (c.calibrationNote) {
    lines.push(``, `Calibration note:`, c.calibrationNote);
  }

  return lines.join("\n");
}
