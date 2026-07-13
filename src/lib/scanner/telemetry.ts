// ─── Scan Telemetry (stabilization pass, pre-Phase 5) ───────────────────────
// Minimal persistence of what each scan attempt SAW and DECIDED, so real scans
// accumulate into the labeled evaluation dataset the probabilistic scorer
// (Phase 6) needs. Stored as versioned JSON in ScanHistory.ocrText — the
// column was unused, and this avoids a schema migration right before device
// testing. Phase 5's migration should promote the hot fields to real columns.
//
// The record is written once per scan attempt (accept, disambiguation, or
// not-found). When the user picks from the disambiguation grid, the pick is
// appended to the SAME row via withSelection() — the user looked at the
// physical card, so their pick is ground truth for that scan's image evidence.

import type { ScanEvidence } from "./evidence";
import type { Decision } from "./decision";
import type { ScoreOutput } from "./score";

/** Ground-truth label: what the user picked from the disambiguation grid. */
export interface SelectionLabel {
  externalId: string;
  game?: string;
  /** ISO timestamp of the pick. */
  at: string;
}

export interface ScanTelemetryV1 {
  v: 1;
  /** Everything the sensors read, with confidence + provenance. */
  evidence: ScanEvidence;
  /** The post-gate verdict for this attempt. */
  decision: {
    action: Decision["action"];
    method?: string;
    confidence: number;
    margin: number;
    evidenceMass: number;
  };
  /** Size of the candidate pool the scorer chose among. */
  printingsCount: number;
  /** Candidates actually surfaced (grid size, or 1 for an accept). */
  presentedCount: number;
  /** Raw full-pass OCR output (name/set/CN/mana/type/PT as the model read them). */
  ocr?: unknown;
  game?: string;
  isAutoScan?: boolean;
  /** Per-stage wall-clock timings in ms (ocrMs, candidatesMs, scoreMs, …) —
   *  Phase 5.2.5 black-box data for latency/failure analysis. */
  timings?: Record<string, number>;
  /** Present once the user picked from the disambiguation grid. */
  selection?: SelectionLabel;
}

export function buildScanTelemetry(input: {
  evidence: ScanEvidence;
  scored: ScoreOutput;
  decision: Decision;
  printingsCount: number;
  ocr?: unknown;
  game?: string;
  isAutoScan?: boolean;
  timings?: Record<string, number>;
}): ScanTelemetryV1 {
  const { evidence, scored, decision, printingsCount, ocr, game, isAutoScan, timings } = input;
  return {
    v: 1,
    evidence,
    decision: {
      action: decision.action,
      method: decision.method ?? scored.methodLabel,
      confidence: decision.confidence,
      margin: scored.margin,
      evidenceMass: scored.evidenceMass,
    },
    printingsCount,
    presentedCount: decision.candidates?.length ?? (decision.printing ? 1 : 0),
    ocr,
    game,
    isAutoScan,
    timings,
  };
}

/**
 * Append the user's disambiguation pick to an existing telemetry JSON string.
 * Tolerant of missing/corrupt input — the label is never lost: if the original
 * record can't be parsed, a minimal record carrying just the selection is
 * written instead.
 */
export function withSelection(rawJson: string | null | undefined, selection: Omit<SelectionLabel, "at">): string {
  const label: SelectionLabel = { ...selection, at: new Date().toISOString() };
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object") {
        parsed.selection = label;
        return JSON.stringify(parsed);
      }
    } catch {
      /* fall through to the minimal record */
    }
  }
  return JSON.stringify({ v: 1, selection: label });
}
