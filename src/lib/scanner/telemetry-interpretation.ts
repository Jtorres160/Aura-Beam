// Telemetry Interpretation Layer (Phase 5.15).
//
// PURPOSE: make TRUTHFUL telemetry UNDERSTANDABLE. It changes nothing about what
// the scanner records — it reads the records the scanner already writes and
// answers, in one vocabulary, two questions a future developer will actually
// ask:
//
//   1. "What happened in this attempt?"      → an AttemptCategory.
//   2. "How far down the pipeline did it get?" → per-stage StageState.
//
// It is interpretation ONLY. It has no side effects, imports no database client,
// and never feeds back into a scan. Nothing here runs in a scan's request path.
//
// ─── WHY THIS LAYER EXISTS ───────────────────────────────────────────────────
//
// The scanner writes THREE structurally different records into
// ScanHistory.ocrText, all tagged `v: 1`:
//
//   • ScanTelemetryV1        the scorer ran — evidence, a decision, a candidate
//                            pool. (buildScanTelemetry)
//   • ScanFailureTelemetryV1 the attempt died BEFORE the scorer — no card, an
//                            OCR error, a bad upload. (buildFailureTelemetry)
//   • a catch-all error row  `{ v: 1, error: { stage, message }, timings }`, the
//                            route's last-resort record for an unclassified throw.
//
// telemetry-analysis.ts understands only the first shape. Fed the other two it
// does the arithmetically-correct-but-semantically-blind thing: they carry no
// candidateStatus, so they land in `outcomes.unclassified` — the SAME bucket as
// a genuine pre-5.13C ScanTelemetryV1 whose candidate stage RAN but wasn't
// recorded. Those are opposite facts:
//
//   pre-5.13C ScanTelemetryV1   candidate generation EXECUTED; we just didn't
//                               store its verdict. Stage ran, result unknown.
//   a failure record            candidate generation NEVER EXECUTED. The attempt
//                               ended two stages earlier.
//
// Collapsing "ran, unrecorded" into "never ran" is the same species of error the
// truth boundary exists to prevent — a zero standing in for an absence — one
// level up. This layer keeps them distinct: an absent stage reads as
// `not_executed`, an unreadable one as `unknown`, and neither is ever a failure.
//
// ─── THE TRUTH BOUNDARY STILL GOVERNS ────────────────────────────────────────
//
// Every category and every stage state is DESCRIPTIVE. None of them ranks an
// attempt "good" or "bad", and none may ever be read back into production logic
// (see the assertion in the test suite). "no_card" is not a scanner failure —
// it is a truthful reading of a frame with no card in it. "unclassified" and
// "unknown" are first-class answers, not error states: they say "the record does
// not license a stronger claim", which is exactly what an honest reader needs.

import type { ScanTelemetryV1, ScanFailureTelemetryV1 } from "@/lib/scanner/telemetry";
import type { FailureStage } from "@/lib/scanner/failure";

// ─── The stored shapes ───────────────────────────────────────────────────────

/**
 * The route's last-resort record for a throw it could not attribute to a build*
 * helper (scan/route.ts catch-all). Shares `v: 1` with the two telemetry shapes
 * but carries neither a decision nor a failureStage — only the escaped stage.
 */
export interface CatchAllErrorRecord {
  v: 1;
  error: { stage: FailureStage; message: string };
  timings?: Record<string, number>;
  game?: string;
  isAutoScan?: boolean;
}

/** Anything the scanner may have written into ScanHistory.ocrText as telemetry. */
export type StoredScanRecord =
  | ScanTelemetryV1
  | ScanFailureTelemetryV1
  | CatchAllErrorRecord;

/**
 * Which of the stored shapes a parsed record is, decided STRUCTURALLY.
 *
 * The three shapes were never given an explicit discriminant tag (all are
 * `v: 1`), so we read the fields that only one shape carries. `scored` is the
 * only kind telemetry-analysis.ts can consume; the rest are pipeline-level
 * facts it has no vocabulary for. `unrecognized` is deliberate and honest — a
 * shape we cannot name is not forced into one.
 */
export type RecordKind = "scored" | "failure" | "error" | "selection_only" | "unrecognized";

function isObject(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null;
}

export function recordKind(record: unknown): RecordKind {
  if (!isObject(record)) return "unrecognized";
  // A decision object is the signature of buildScanTelemetry — the scorer ran.
  if (isObject(record.decision) && typeof record.decision.action === "string") return "scored";
  // failureStage is the signature of buildFailureTelemetry — died before the scorer.
  if (typeof record.failureStage === "string") return "failure";
  // The catch-all row: an escaped stage and nothing else identifying.
  if (isObject(record.error) && typeof record.error.stage === "string") return "error";
  // A withSelection() fallback row written when the original JSON was corrupt:
  // it carries only the ground-truth pick, no pipeline evidence at all.
  if (isObject(record.selection)) return "selection_only";
  return "unrecognized";
}

// ─── Attempt categories ──────────────────────────────────────────────────────

/**
 * A plain-language name for what an attempt DID, spanning all three record
 * shapes in one vocabulary. Purely observational — see the truth-boundary note.
 *
 * The three "outcome" categories (found / no_match / provider_unavailable) mean
 * exactly what candidateStatus means (found / no_candidates / provider_
 * unavailable); they are renamed here only so the whole taxonomy reads as one
 * list. The rest describe attempts that ended before an outcome existed.
 */
export type AttemptCategory =
  // — the scorer ran and produced an outcome —
  | "found" //                 a printing (or fallback) was identified
  | "no_match" //              every source answered; none had the card
  | "provider_unavailable" //  a source went quiet; the zero is uninterpretable
  | "unclassified" //          scored record with no candidateStatus (pre-5.13C)
  // — the attempt ended before the scorer —
  | "no_card" //               OCR ran and saw no trading card in frame
  | "ocr_failed" //            the OCR call itself errored or timed out
  | "parse_failed" //          the upload never arrived intact / no image
  | "candidate_search_failed" // candidate generation threw
  | "scoring_failed" //        the scorer threw
  | "database_failed" //       a Prisma/DB operation threw (position ambiguous)
  | "rate_limited" //          refused before work began (rarely persisted)
  | "error_other" //           a throw the pipeline could not attribute
  | "unrecognized"; //         a record shape this layer cannot read

/** The category order used for stable, readable report output. */
export const ATTEMPT_CATEGORIES: readonly AttemptCategory[] = [
  "found",
  "no_match",
  "provider_unavailable",
  "unclassified",
  "no_card",
  "ocr_failed",
  "parse_failed",
  "candidate_search_failed",
  "scoring_failed",
  "database_failed",
  "rate_limited",
  "error_other",
  "unrecognized",
];

/** One-line human definition of each category, for docs and report legends. */
export const ATTEMPT_CATEGORY_DESCRIPTIONS: Record<AttemptCategory, string> = {
  found: "The scorer ran and identified a printing (or an accepted fallback).",
  no_match: "Every source answered and none had the card — a genuine absence.",
  provider_unavailable: "A source went quiet, so the empty pool proves nothing.",
  unclassified: "Scored record carrying no candidateStatus (pre-5.13C) — outcome unknown.",
  no_card: "OCR ran and truthfully reported no trading card in the frame.",
  ocr_failed: "The OCR call itself errored or timed out — nothing was read.",
  parse_failed: "The upload didn't arrive intact, or carried no image.",
  candidate_search_failed: "Candidate generation threw before producing a pool.",
  scoring_failed: "The scorer threw before reaching a decision.",
  database_failed: "A database operation threw; its pipeline position is not recorded.",
  rate_limited: "The attempt was refused before any work began.",
  error_other: "A throw the pipeline could not attribute to a stage.",
  unrecognized: "A stored shape this layer cannot interpret.",
};

/**
 * Map a FailureStage (from a failure or error record) to an AttemptCategory.
 * The two failure-record fields that refine it — extractionStatus, and whether
 * an error is present — are handled by the caller.
 */
function categoryOfStage(stage: FailureStage): AttemptCategory {
  switch (stage) {
    case "parse":
      return "parse_failed";
    case "ocr":
      return "ocr_failed";
    case "no-card":
      return "no_card";
    case "candidates":
      return "candidate_search_failed";
    case "scoring":
      return "scoring_failed";
    case "database":
      return "database_failed";
    case "rate-limit":
      return "rate_limited";
    // These are VERDICTS the scored path emits; they should never arrive as a
    // failureStage. If one does, name it honestly rather than guessing an outcome.
    case "not-found":
    case "provider-unavailable":
    case "selection-provider":
    case "unknown":
    default:
      return "error_other";
  }
}

/**
 * Classify one stored record into an AttemptCategory. Tolerant of unknown input
 * by construction — a shape it cannot read becomes `unrecognized`, never a throw.
 */
export function classifyAttempt(record: unknown): AttemptCategory {
  const kind = recordKind(record);
  if (!isObject(record)) return "unrecognized";

  switch (kind) {
    case "scored": {
      const status = record.candidateStatus;
      if (status === "found") return "found";
      if (status === "no_candidates") return "no_match";
      if (status === "provider_unavailable") return "provider_unavailable";
      // A scored record with no candidateStatus is a pre-5.13C row: the candidate
      // stage RAN, we simply never stored its verdict. Do NOT infer an outcome.
      return "unclassified";
    }
    case "failure": {
      const stage = record.failureStage as FailureStage;
      // extractionStatus refines the OCR stage into verdict vs. error.
      if (record.extractionStatus === "no_card") return "no_card";
      if (record.extractionStatus === "failed") return "ocr_failed";
      return categoryOfStage(stage);
    }
    case "error": {
      const stage = (record.error as { stage: FailureStage }).stage;
      return categoryOfStage(stage);
    }
    case "selection_only":
      // Only a ground-truth pick survived; the pipeline evidence was lost. We
      // know a user selected, not what the scanner concluded.
      return "unclassified";
    case "unrecognized":
    default:
      return "unrecognized";
  }
}

// ─── Stage execution ─────────────────────────────────────────────────────────

/**
 * The scan pipeline's stages, in execution order. A subset of FailureStage that
 * every attempt passes through in sequence (the verdict/selection/database
 * stages are not positional and are handled separately).
 */
export const PIPELINE_STAGES = ["parse", "ocr", "candidates", "scoring", "decision"] as const;
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/**
 * What a single stage did in a single attempt.
 *
 *   not_executed   the attempt ended before this stage — an ABSENCE, not a fault.
 *   ran_empty      the stage ran and truthfully produced nothing (no card; no
 *                  candidates). A measured zero, not a failure.
 *   ran_failed     the stage ran and errored/timed out.
 *   ran_ok         the stage ran and produced a usable result.
 *   unknown        the record ran this stage but does not record its result
 *                  (pre-5.13C candidate status; a database throw of unknown
 *                  position). We decline to guess.
 *
 * The `not_executed` / `unknown` distinction is the whole reason this type
 * exists: the first says "this never happened", the second says "this happened
 * but the record can't tell us how". Merging them re-introduces exactly the
 * absent-as-zero error this phase is here to remove.
 */
export type StageState = "not_executed" | "ran_empty" | "ran_failed" | "ran_ok" | "unknown";

export type StageExecution = Record<PipelineStage, StageState>;

function allStages(state: StageState): StageExecution {
  return { parse: state, ocr: state, candidates: state, scoring: state, decision: state };
}

/**
 * Derive per-stage execution from one stored record.
 *
 * The model: a "reached" stage terminates the attempt. Every stage BEFORE it
 * completed (`ran_ok`); the reached stage carries its own terminal state; every
 * stage AFTER it is `not_executed`. Scored records reach `decision`; failure and
 * error records reach the stage named in failureStage / error.stage.
 */
export function stageExecution(record: unknown): StageExecution {
  const kind = recordKind(record);
  if (!isObject(record)) return allStages("unknown");

  if (kind === "scored") {
    // parse/ocr/scoring/decision all necessarily ran to produce a decision.
    // The candidate stage's state is the ONLY one that varies, and it is exactly
    // the pre-5.13C ambiguity: a missing candidateStatus means "ran, unrecorded"
    // (unknown), never "did not run" and never "failed".
    const status = record.candidateStatus;
    let candidates: StageState;
    if (status === "found") candidates = "ran_ok";
    else if (status === "no_candidates") candidates = "ran_empty";
    else if (status === "provider_unavailable") candidates = "ran_failed";
    else candidates = "unknown";
    return { parse: "ran_ok", ocr: "ran_ok", candidates, scoring: "ran_ok", decision: "ran_ok" };
  }

  if (kind === "failure" || kind === "error") {
    const stage =
      kind === "failure"
        ? (record.failureStage as FailureStage)
        : (record.error as { stage: FailureStage }).stage;
    return stageExecutionForStage(stage, record);
  }

  // selection_only / unrecognized: the record does not describe a pipeline run.
  return allStages("unknown");
}

/** The reached-stage model, resolved for a positional failure/error stage. */
function stageExecutionForStage(stage: FailureStage, record: Record<string, unknown>): StageExecution {
  const before = (s: StageState): StageExecution => allStages(s);

  switch (stage) {
    case "rate-limit":
      // Refused before the pipeline began — nothing executed.
      return allStages("not_executed");

    case "parse":
      return { ...before("not_executed"), parse: "ran_failed" };

    case "ocr": {
      // A "no_card" verdict is the reader working and reporting an empty frame;
      // a "failed" status (or a bare ocr error) is the reader itself breaking.
      const ocr: StageState = record.extractionStatus === "no_card" ? "ran_empty" : "ran_failed";
      return { ...before("not_executed"), parse: "ran_ok", ocr };
    }

    case "no-card":
      return { ...before("not_executed"), parse: "ran_ok", ocr: "ran_empty" };

    case "candidates":
      return {
        ...before("not_executed"),
        parse: "ran_ok",
        ocr: "ran_ok",
        candidates: "ran_failed",
      };

    case "scoring":
      // The scorer threw, so candidates COMPLETED without throwing — but whether
      // it produced a pool is not recorded here, so its result stays `ran_ok`
      // (completed) rather than claiming a size we do not have.
      return {
        ...before("not_executed"),
        parse: "ran_ok",
        ocr: "ran_ok",
        candidates: "ran_ok",
        scoring: "ran_failed",
      };

    // A database throw is genuinely position-ambiguous: it may be the early
    // rate-limit count (before parse) or the final save (after decision), and
    // the record does not say which. Asserting a position would be a guess, so
    // every stage is `unknown`.
    case "database":
      return allStages("unknown");

    // Verdicts that should arrive on scored records, not as a failureStage.
    // Handled defensively so an unexpected shape still reads honestly.
    case "not-found":
      return { parse: "ran_ok", ocr: "ran_ok", candidates: "ran_empty", scoring: "ran_ok", decision: "ran_ok" };
    case "provider-unavailable":
      return { parse: "ran_ok", ocr: "ran_ok", candidates: "ran_failed", scoring: "ran_ok", decision: "ran_ok" };

    case "selection-provider":
    case "unknown":
    default:
      return allStages("unknown");
  }
}

// ─── Aggregation ─────────────────────────────────────────────────────────────

/** Count of each StageState seen for one pipeline stage, across many attempts. */
export interface StageStateCounts {
  not_executed: number;
  ran_empty: number;
  ran_failed: number;
  ran_ok: number;
  unknown: number;
}

export interface AttemptInterpretation {
  /** Every stored record handed in — the honest denominator for this view. */
  total: number;
  /** How many of each record shape were present. */
  byKind: Record<RecordKind, number>;
  /** How many attempts fell into each observational category. */
  byCategory: Record<AttemptCategory, number>;
  /** Per-stage tally of what happened, across every attempt. */
  stages: Record<PipelineStage, StageStateCounts>;
}

function emptyStageCounts(): StageStateCounts {
  return { not_executed: 0, ran_empty: 0, ran_failed: 0, ran_ok: 0, unknown: 0 };
}

/**
 * Aggregate the pipeline-level view over a set of stored records.
 *
 * Deliberately takes the RAW records (any shape), NOT the ScanTelemetrySamples
 * that telemetry-analysis.ts consumes: the whole point is to see the failure and
 * error records that analysis is structurally blind to. `total` counts every
 * record given, so this view and the analysis view can be reconciled by a reader
 * (analysis' sampleCount = this total minus the non-scored kinds).
 */
export function interpretAttempts(records: unknown[]): AttemptInterpretation {
  const byKind: Record<RecordKind, number> = {
    scored: 0,
    failure: 0,
    error: 0,
    selection_only: 0,
    unrecognized: 0,
  };
  const byCategory = Object.fromEntries(
    ATTEMPT_CATEGORIES.map((c) => [c, 0]),
  ) as Record<AttemptCategory, number>;
  const stages: Record<PipelineStage, StageStateCounts> = {
    parse: emptyStageCounts(),
    ocr: emptyStageCounts(),
    candidates: emptyStageCounts(),
    scoring: emptyStageCounts(),
    decision: emptyStageCounts(),
  };

  for (const record of records) {
    byKind[recordKind(record)]++;
    byCategory[classifyAttempt(record)]++;
    const exec = stageExecution(record);
    for (const stage of PIPELINE_STAGES) {
      stages[stage][exec[stage]]++;
    }
  }

  return { total: records.length, byKind, byCategory, stages };
}
