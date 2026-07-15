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
  | "selection-provider"    // the user PICKED, and the source wouldn't confirm it (5.13C)
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

/**
 * What to tell a collector when THEY picked a card and the source database
 * wouldn't confirm it (Phase 5.13C).
 *
 * The user is further along here than anywhere else in the pipeline: they have
 * looked at the physical card AND at our grid and told us which one it is. The
 * only thing that failed is our re-fetch. So this message must do two things the
 * old "Could not verify the selected card. Please scan again." did neither of:
 *
 *   1. Not question the card or the user's choice — nothing about either is in
 *      doubt. Name the source that went quiet instead.
 *   2. Not send them back to the camera. Re-scanning is irrational advice: it
 *      re-runs capture, OCR and vision to arrive at the same grid and the same
 *      unavailable source. The retry that can actually succeed is the SAVE.
 *
 * Note what it also must not say: that we saved anything. We didn't — the save
 * is exactly what failed. A reassuring "your choice is saved" would be a fresh
 * lie told to fix an old one, which is not the trade this phase is making.
 */
export function messageForUnavailableSelection(sources: string[], cardName?: string): string {
  const named = sources.length > 0 ? sources.join(" and ") : "the card database";
  const subject = cardName ? `"${cardName}"` : "your pick";
  return `We couldn't reach ${named} to confirm ${subject}, so it isn't saved yet. Your choice was right — try saving again in a moment.`;
}

/**
 * What to tell a collector when a card couldn't be added because its source
 * database never answered (Phase 5.13C). Same rule, different flow: "we didn't
 * add it" is honest; "card not found" would not be.
 */
export function messageForUnavailableAdd(sources: string[]): string {
  const named = sources.length > 0 ? sources.join(" and ") : "the card database";
  return `We couldn't reach ${named} to look this card up, so it hasn't been added. Try again in a moment.`;
}
