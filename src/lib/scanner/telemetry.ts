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

import type { EvidenceCoverage, EvidenceSignal, ScanEvidence } from "./evidence";
import type { CandidateOutcome, CandidateSourceStatus } from "./candidates";
import type { Decision } from "./decision";
import type { FailureStage } from "./failure";
import type { ScoreOutput } from "./score";

/** Ground-truth label: what the user picked from the disambiguation grid. */
export interface SelectionLabel {
  externalId: string;
  game?: string;
  /** ISO timestamp of the pick. */
  at: string;
}

/**
 * A save attempt that did NOT produce a label, because the source database
 * wouldn't confirm the pick (Phase 5.13C).
 *
 * Recorded alongside the pending row rather than as its matchMethod: the row is
 * still legitimately "disambiguation-pending" (the user can retry and succeed),
 * and overwriting the method would delete the ground-truth link this row exists
 * to carry. Appending keeps BOTH facts — what the user chose, and that we
 * couldn't confirm it — which is the whole point of the truth layer.
 */
export interface SelectionAttemptFailure {
  status: "provider_unavailable";
  source: string;
  reason: string;
  /** ISO timestamp of the attempt. */
  at: string;
}

/**
 * Fingerprint shadow-sensor block (Scanner V2 · M2-B).
 *
 * Appended to a scan's ScanHistory row AFTER the response is sent, by an
 * `after()` callback that has ZERO effect on what the user received. It records
 * what the local visual matcher (matchFingerprint) saw for this image versus the
 * identity the live pipeline chose, so a later analysis can ask the SAME
 * agreement question M1's analyzeArtPickAgreement asks — did the fingerprint's
 * top visual pick match the pipeline's pick? — without this stage ever having
 * influenced that pick.
 *
 * The agreement is NOT computed here on purpose (mirrors bestMatchExternalId in
 * M1): both externalIds are stored raw and the boolean is derived downstream, so
 * a premature/derived "agreement" can't bake in a comparison rule we may revise.
 * Optional and additive: older records omit it, older readers ignore it, v
 * stays 1.
 */
export interface FingerprintShadow {
  /** Top visual match's externalId, or null when the matcher went dark
   *  (unsupported game / empty index / silent failure — never a throw). */
  topMatchExternalId: string | null;
  /** Top match's cosine distance in [0, 2] (lower = closer), or null when
   *  there was no match. */
  topMatchDistance: number | null;
  /** The full top-K the matcher returned (≤5, ascending distance), for later
   *  analysis. Absent when the matcher returned null (went dark). Shape mirrors
   *  FingerprintMatch; inlined so this pure telemetry module stays free of the
   *  matcher's runtime (prisma) dependency. */
  matches?: Array<{ externalId: string; distance: number }>;
  /** The pipeline identity to compare the top pick against — the accepted
   *  printing's externalId, or the disambiguation best-match externalId. null
   *  when the attempt chose nothing (not-found / provider-unavailable). Stored,
   *  never compared here. */
  pipelineExternalId: string | null;
  /** Where pipelineExternalId came from, so the downstream comparison knows
   *  which M1-style question it is answering. */
  pipelinePickSource: "accept" | "disambiguate" | "none";
  /** ISO timestamp of when the shadow match completed. */
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
    /** externalId of the printing vision judged the best match, when the
     *  decision carried a preferred candidate among its alternatives (set at
     *  rank.ts for single-printing art groups). Persisting it lets analysis ask
     *  "did vision's art pick match what the user chose from the grid?" — the
     *  value was already computed and surfaced to the client as `isBestMatch`,
     *  and only dropped before the write. Optional and additive: older records
     *  omit it, so v stays 1. */
    bestMatchExternalId?: string;
  };
  /** The per-signal evidence breakdown that summed to `decision.evidenceMass`,
   *  captured verbatim from assessIdentitySignals() — NOT recomputed here.
   *  Purely observational: it records which independent identity signals were
   *  present (type/state/weight) so EvidenceMass weights can be calibrated from
   *  real scans later. No derived or "winning signal" fields — that analysis is
   *  downstream. Optional and additive: older records simply omit it, and older
   *  consumers ignore it, so v stays 1 (no breaking change). Empty/absent when
   *  no printing was chosen (disambiguate/not-found). */
  evidenceSignals?: EvidenceSignal[];
  /** Availability summary of `evidenceSignals` (Phase 5.10): how many expected
   *  sensors fired vs. failed vs. are unavailable for this game. Purely
   *  observational CONTEXT for the score — captured verbatim from the scorer,
   *  never recomputed here, and never used to adjust confidence. Optional and
   *  additive: older records omit it and older consumers ignore it, so v stays 1.
   *  Absent when no printing was chosen (disambiguate/not-found). */
  evidenceCoverage?: EvidenceCoverage;
  /**
   * The candidate layer's truth claim for this scan (Phase 5.13C).
   *
   * Read this, NOT `decision.action`, to count genuine absences. The two are
   * different verdicts by different layers and they legitimately disagree:
   *
   *   decision.action     the SCORER's verdict. "not-found" here means only
   *                       "I was handed zero printings to choose among".
   *   candidateStatus     the ROUTE's verdict, and the one that reached the
   *                       collector. "no_candidates" is the only value that
   *                       asserts the databases actually lack this card.
   *
   * Before this field, a provider_unavailable scan wrote decision.action
   * "not-found" into the JSON while the row's matchMethod said
   * "provider-unavailable" — so the record contradicted itself, and anyone
   * counting "true no matches" off decision.action silently swept in every
   * outage. `true no matches` = candidateStatus === "no_candidates".
   */
  candidateStatus?: CandidateOutcome["status"];
  /**
   * Per-source availability, failure reason and wall-clock latency for the
   * candidate fetch (Phase 5.13C).
   *
   * `timings.candidatesMs` is one number covering up to three providers and
   * several calls each, so it cannot answer any of the questions a provider
   * decision actually needs: is one source slow, are failures clustered, how
   * often do we hit the 8s ceiling, is a scan that SUCCEEDED hiding a partial
   * outage? That last one was wholly invisible before this field — a scan that
   * found the card while a source timed out looked identical to a healthy scan.
   *
   * Recorded on EVERY outcome including "found", for exactly that reason.
   * Optional and additive: older records omit it, so v stays 1.
   */
  candidateSources?: CandidateSourceStatus[];
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
  /** Save attempts that failed because a source wouldn't confirm the pick
   *  (Phase 5.13C). Appended, never overwritten — several retries against a
   *  flapping provider all belong to the same scan. Optional and additive:
   *  older records omit it, so v stays 1. Answers "are selection-time provider
   *  failures clustered, and on which source?" — unanswerable before 5.13C,
   *  because the failure became a 404 and left no trace at all. */
  selectionAttempts?: SelectionAttemptFailure[];
  /** Fingerprint shadow-sensor block (Scanner V2 · M2-B), appended after the
   *  response is sent. Optional and additive: older records omit it, so v stays
   *  1. See FingerprintShadow. */
  fingerprintShadow?: FingerprintShadow;
}

/**
 * Telemetry for an attempt that ended BEFORE the scorer ran (Phase 5.14.3).
 *
 * These records are structurally different from ScanTelemetryV1 and that is the
 * point: there is no evidence bundle, no decision and no candidate pool, because
 * those stages never executed. Emitting a ScanTelemetryV1 here would force
 * inventing a `decision` and a `printingsCount: 0` for a scorer that was never
 * called — a fabricated zero standing in for an absent measurement, which is
 * exactly the error the truth boundary exists to prevent.
 *
 * `v: 1` and the `error` shape match what the route's catch-all has always
 * written, so existing records and readers are unaffected. `failureStage` is
 * new and additive.
 *
 * WHY THIS EXISTS: the extraction branch returned early with NO row at all, so
 * a failed OCR call and a frame with no card in it left zero trace in the
 * database. Both are genuinely measured facts about a real scan attempt, and
 * both were invisible.
 */
export interface ScanFailureTelemetryV1 {
  v: 1;
  /** Which stage the attempt died at, from the pipeline's one taxonomy. */
  failureStage: FailureStage;
  /**
   * The extraction layer's own verdict, when extraction is what ended the
   * attempt. The distinction is the whole value of the field and it is a real
   * one, not a shade of the same thing:
   *
   *   "no_card"  the OCR call SUCCEEDED and reported no trading card in frame.
   *              A measurement of the image.
   *   "failed"   the OCR call itself errored or timed out. We learned nothing
   *              about the image at all.
   *
   * Collapsing these would blame the collector's photo for our outage.
   */
  extractionStatus?: "no_card" | "failed";
  /** Present when a stage threw. Absent for verdicts like no_card, which are
   *  outcomes rather than errors. */
  error?: { stage: FailureStage; message: string };
  game?: string;
  isAutoScan?: boolean;
  /** Per-stage wall-clock timings for the stages that DID run. */
  timings?: Record<string, number>;
}

export function buildFailureTelemetry(input: {
  stage: FailureStage;
  extractionStatus?: ScanFailureTelemetryV1["extractionStatus"];
  /** Only for genuine errors — omit for verdicts. */
  errorMessage?: string;
  game?: string;
  isAutoScan?: boolean;
  timings?: Record<string, number>;
}): ScanFailureTelemetryV1 {
  const { stage, extractionStatus, errorMessage, game, isAutoScan, timings } = input;
  return {
    v: 1,
    failureStage: stage,
    extractionStatus,
    error: errorMessage === undefined ? undefined : { stage, message: errorMessage },
    game,
    isAutoScan,
    timings,
  };
}

export function buildScanTelemetry(input: {
  evidence: ScanEvidence;
  scored: ScoreOutput;
  decision: Decision;
  /** The candidate layer's outcome — its status and per-source readings. */
  candidates?: Pick<CandidateOutcome, "status" | "sources">;
  printingsCount: number;
  ocr?: unknown;
  game?: string;
  isAutoScan?: boolean;
  timings?: Record<string, number>;
}): ScanTelemetryV1 {
  const { evidence, scored, decision, candidates, printingsCount, ocr, game, isAutoScan, timings } = input;
  return {
    v: 1,
    evidence,
    decision: {
      action: decision.action,
      method: decision.method ?? scored.methodLabel,
      confidence: decision.confidence,
      margin: scored.margin,
      evidenceMass: scored.evidenceMass,
      bestMatchExternalId: decision.bestMatchExternalId,
    },
    candidateStatus: candidates?.status,
    candidateSources: candidates?.sources,
    evidenceSignals: scored.evidenceSignals,
    // Only record coverage when a printing was actually assessed — an empty
    // signal set has no meaningful coverage (disambiguate/not-found).
    evidenceCoverage: scored.evidenceSignals.length ? scored.evidenceCoverage : undefined,
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

/**
 * Append a failed save attempt to an existing telemetry JSON string (Phase
 * 5.13C). Same tolerance contract as withSelection(): a corrupt original never
 * loses the new record.
 *
 * Everything already on the record — the evidence, the decision, an earlier
 * selection label — is preserved. This is additive by construction: a scan
 * whose save failed twice and then succeeded ends up with both attempts AND the
 * label, which is exactly the sequence a provider-reliability query wants.
 */
export function withSelectionAttempt(
  rawJson: string | null | undefined,
  attempt: Omit<SelectionAttemptFailure, "at">,
): string {
  const record: SelectionAttemptFailure = { ...attempt, at: new Date().toISOString() };
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object") {
        parsed.selectionAttempts = [
          ...(Array.isArray(parsed.selectionAttempts) ? parsed.selectionAttempts : []),
          record,
        ];
        return JSON.stringify(parsed);
      }
    } catch {
      /* fall through to the minimal record */
    }
  }
  return JSON.stringify({ v: 1, selectionAttempts: [record] });
}

/**
 * Append the fingerprint shadow block to an existing telemetry JSON string
 * (Scanner V2 · M2-B). Same tolerance contract as withSelection(): a
 * missing/corrupt original never loses the block — a minimal record carrying
 * just the shadow is written instead.
 *
 * Everything already on the record — evidence, decision, a selection label — is
 * preserved: this is a pure additive merge of one field onto the parsed object.
 */
export function withFingerprintShadow(
  rawJson: string | null | undefined,
  shadow: FingerprintShadow,
): string {
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson);
      if (parsed && typeof parsed === "object") {
        parsed.fingerprintShadow = shadow;
        return JSON.stringify(parsed);
      }
    } catch {
      /* fall through to the minimal record */
    }
  }
  return JSON.stringify({ v: 1, fingerprintShadow: shadow });
}
