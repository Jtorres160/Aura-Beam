// ─── Scan Feedback Taxonomy ──────────────────────────────────────────────────
// The vocabulary a collector reports a scan problem in, in ONE place, shared by
// the client form that produces a report and the server route that stores it.
// Same shape and the same rules as capture-rejection.ts.
//
// ─── WHAT A FEEDBACK ROW IS, AND IS NOT ──────────────────────────────────────
//
// A row here is a HUMAN CLAIM about a scan: "this is the wrong card", "it kept
// failing". It is not a measurement, and it is emphatically not a correction —
// nothing in the pipeline reads these rows, no scan is relabelled by one, and
// the identity in ScanHistory is unchanged by a report. Aura's own verdicts and
// a collector's opinion of them are kept as separate facts, because they are.
//
// (The measured counterpart already exists: `Not this card?` on the result
// screen writes a structured rejection onto the scan row itself via
// /api/scanner/reject-match, and that IS confirmation telemetry. This is the
// free-text channel next to it — for everything a fixed taxonomy cannot say.)
//
// The technical state is attached by the CLIENT from what it already holds, so
// a tester never has to describe a scanId, a match method or a confidence
// number. Every one of those fields is nullable: an unknown value is stored as
// null, never as a placeholder or a guess.

/** What the collector says went wrong. Deliberately short — a list a tester can
 *  read in one glance beats a taxonomy only we understand. `other` exists so an
 *  unanticipated problem lands in free text rather than in the wrong bucket. */
export const SCAN_FEEDBACK_CATEGORIES = [
  /** A card was identified, but it is not the card that was scanned. */
  "wrong-card",
  /** Right card, wrong printing/set/version. */
  "wrong-printing",
  /** The scan failed or errored when it should have worked. */
  "scan-failed",
  /** The price shown looks wrong or is missing. */
  "bad-price",
  /** The app itself misbehaved — layout, freeze, button doing nothing. */
  "app-broken",
  /** Anything else; the free-text field carries it. */
  "other",
] as const;

export type ScanFeedbackCategory = (typeof SCAN_FEEDBACK_CATEGORIES)[number];

export function isScanFeedbackCategory(value: unknown): value is ScanFeedbackCategory {
  return typeof value === "string" && (SCAN_FEEDBACK_CATEGORIES as readonly string[]).includes(value);
}

/** Human labels for the form. Kept beside the vocabulary so a new category
 *  cannot be added without deciding what a collector will see. */
export const SCAN_FEEDBACK_LABELS: Record<ScanFeedbackCategory, string> = {
  "wrong-card": "Wrong card",
  "wrong-printing": "Wrong printing",
  "scan-failed": "Scan failed",
  "bad-price": "Price looks wrong",
  "app-broken": "Something broke",
  other: "Something else",
};

/** Which view the report was filed from. A complaint about a match and a
 *  complaint about a failure are different populations and must stay separable
 *  even when the category chosen is the same. */
export const SCAN_FEEDBACK_SURFACES = ["result", "error"] as const;

export type ScanFeedbackSurface = (typeof SCAN_FEEDBACK_SURFACES)[number];

export function isScanFeedbackSurface(value: unknown): value is ScanFeedbackSurface {
  return typeof value === "string" && (SCAN_FEEDBACK_SURFACES as readonly string[]).includes(value);
}

/** Free-text ceiling. Long enough for a real description, short enough that the
 *  column cannot be used as a file upload. Enforced on the server. */
export const SCAN_FEEDBACK_MESSAGE_MAX = 2000;

/** The report body, as sent by the client and validated by the route. */
export interface ScanFeedbackInput {
  category: ScanFeedbackCategory;
  surface: ScanFeedbackSurface;
  /** The collector's own words. Optional — a category alone is a valid report. */
  message?: string;
  /** ScanHistory.id for this attempt. Null when the scan never produced a row
   *  (an early parse failure, or a persist that itself failed). */
  scanId?: string | null;
  /** The Card the scan resolved to, when it resolved to one. */
  cardId?: string | null;
  cardName?: string | null;
  /** The scorer's confidence, 0–100. Null when no scorer ran — which is NOT the
   *  same as 0, per the scan truth-boundary convention. */
  confidence?: number | null;
  /** The MatchMethod that produced an accept, or null. */
  matchMethod?: string | null;
  /** The FailureStage the server blamed, or the client-side `capture:<reason>`.
   *  Null on a successful scan. */
  failureStage?: string | null;
  game?: string | null;
}

/**
 * Validate and normalize a report body. Returns the row-shaped value, or an
 * error naming the field at fault.
 *
 * Only `category` and `surface` are required, and both must be members of their
 * vocabulary — an unrecognized value is REJECTED rather than coerced, so the
 * category distribution stays trustworthy (the same rule capture-rejected
 * applies to its reasons). Everything else is best-effort context: an absent or
 * malformed value becomes null, because "we don't know" is a true statement and
 * a placeholder is not.
 */
export function parseScanFeedback(
  body: unknown,
): { ok: true; value: Required<Omit<ScanFeedbackInput, "message">> & { message: string | null } }
  | { ok: false; message: string } {
  const b = (body ?? {}) as Record<string, unknown>;

  if (!isScanFeedbackCategory(b.category)) {
    return { ok: false, message: "Unrecognized feedback category" };
  }
  if (!isScanFeedbackSurface(b.surface)) {
    return { ok: false, message: "Unrecognized feedback surface" };
  }

  const rawMessage = typeof b.message === "string" ? b.message.trim() : "";
  if (rawMessage.length > SCAN_FEEDBACK_MESSAGE_MAX) {
    return { ok: false, message: "Message is too long" };
  }

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim().length > 0 ? v.trim() : null;

  // Confidence is stored only when it is a real 0–100 reading. Anything else —
  // absent, NaN, out of range — is null. A scan where no scorer ran reports
  // confidence 0 by column convention; the client sends null for that case and
  // this does not second-guess it.
  const confidence =
    typeof b.confidence === "number" && Number.isFinite(b.confidence) && b.confidence >= 0 && b.confidence <= 100
      ? Math.round(b.confidence)
      : null;

  return {
    ok: true,
    value: {
      category: b.category,
      surface: b.surface,
      message: rawMessage.length > 0 ? rawMessage : null,
      scanId: str(b.scanId),
      cardId: str(b.cardId),
      cardName: str(b.cardName),
      confidence,
      matchMethod: str(b.matchMethod),
      failureStage: str(b.failureStage),
      game: str(b.game),
    },
  };
}
