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
  | "rate-limit"            // burst/daily cap (a refusal, not an error)
  | "parse"                 // request body unreadable / no image
  | "ocr"                   // full-pass OCR call failed
  | "no-card"               // OCR ran fine but saw no trading card
  | "candidates"            // card-database candidate fetch threw
  | "scoring"               // scorer/ranking threw
  | "not-found"             // pipeline completed; the databases DO NOT have it (a verdict)
  | "provider-unavailable"  // pipeline completed; we could not ASK (a verdict — 5.13B)
  | "database"              // a Prisma/DB operation threw
  | "unknown";              // anything unattributed

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

/**
 * What to tell a collector when the pipeline ran fine but a card database never
 * answered (Phase 5.13B).
 *
 * This is deliberately NOT in STAGE_MESSAGES: it names the sources that went
 * quiet, so it cannot be a constant. The wording carries the whole point of the
 * phase — we did not fail to find the card, we failed to LOOK. Saying "no match
 * was found" here would be asserting a fact we do not have.
 */
export function messageForUnavailableSources(sources: string[], cardName?: string): string {
  const named = sources.length > 0 ? sources.join(" and ") : "The card database";
  const subject = cardName ? `"${cardName}"` : "this card";
  return `We read ${subject} from your card, but ${named} didn't respond — so we can't confirm which printing it is. Your image was fine; try again in a moment.`;
}
