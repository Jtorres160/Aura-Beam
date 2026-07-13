// ─── Failure Stages (Phase 5.2.5) ────────────────────────────────────────────
// The scan pipeline's failure taxonomy. Every error response from the scan API
// names the STAGE that failed, so "the scanner failed" is always answerable
// with "failed WHERE". Before this, every uncaught throw collapsed into one
// generic "Failed to process card image." — which, since the OCR and card-DB
// calls all self-catch, almost always meant a database/infra error mislabeled
// as an image problem.
//
// This module is deliberately dependency-free (no Prisma, no Next) so both the
// route and any client code can import the types.

/** Where in the pipeline an attempt failed. Also used as the suffix of the
 *  persisted ScanHistory.matchMethod ("error:<stage>") for failed attempts. */
export type FailureStage =
  | "rate-limit"   // burst/daily cap (a refusal, not an error)
  | "parse"        // request body unreadable / no image
  | "ocr"          // full-pass OCR call failed
  | "no-card"      // OCR ran fine but saw no trading card
  | "candidates"   // card-database candidate fetch threw
  | "scoring"      // scorer/ranking threw
  | "not-found"    // pipeline completed; nothing matched (a verdict, not an error)
  | "database"     // a Prisma/DB operation threw
  | "unknown";     // anything unattributed

/** Wraps a thrown error with the pipeline stage it escaped from. */
export class StageError extends Error {
  readonly stage: FailureStage;
  readonly cause_: unknown;

  constructor(stage: FailureStage, cause: unknown) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`[${stage}] ${msg}`);
    this.name = "StageError";
    this.stage = stage;
    this.cause_ = cause;
  }
}

/** Run one pipeline stage; anything it throws is re-thrown tagged with the
 *  stage name. Already-tagged errors pass through untouched so the innermost
 *  (most precise) stage wins. */
export async function runStage<T>(stage: FailureStage, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw err instanceof StageError ? err : new StageError(stage, err);
  }
}

export function stageOfError(err: unknown): FailureStage {
  return err instanceof StageError ? err.stage : "unknown";
}

/** Honest, stage-specific user-facing copy for 5xx failures. None of these
 *  blame the image unless the image was actually the problem. */
const STAGE_MESSAGES: Partial<Record<FailureStage, string>> = {
  parse: "The scan upload didn't arrive intact. Check your connection and try again.",
  ocr: "The card reader timed out or errored. Your image was fine — try again.",
  candidates: "The card database didn't respond. Your image was fine — try again in a moment.",
  scoring: "Something failed while comparing printings. Try scanning again.",
  database: "We couldn't reach the archive database. Your image was fine — try again in a moment.",
  unknown: "Something failed on our side while processing the scan. Try again.",
};

export function messageForStage(stage: FailureStage): string {
  return STAGE_MESSAGES[stage] ?? STAGE_MESSAGES.unknown!;
}
