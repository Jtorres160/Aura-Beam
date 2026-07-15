// ─── Capture Rejection Taxonomy (Phase 5.14.3) ───────────────────────────────
// The capture stage's vocabulary, in ONE place, shared by the client gate that
// produces a rejection and the server route that records it.
//
// Why this module exists at all: capture.ts owns the quality gate, but it
// touches HTMLVideoElement/HTMLCanvasElement, so a server route cannot import it
// without dragging DOM-dependent code into the server bundle. The taxonomy is
// split out here — dependency-free, no DOM, no Prisma, no Next — and capture.ts
// derives its type from it. There is still exactly one list; this is not a
// second taxonomy.
//
// ─── WHAT A REJECTION IS, AND IS NOT ─────────────────────────────────────────
//
// A rejection means the quality gate declined to SPEND an OCR call on a frame.
// It is a measurement of the frame, not a verdict on the card, and emphatically
// not a scan: no image was ever sent, no provider was consulted, nothing was
// identified or failed to be identified. That distinction is why these records
// do not live in ScanHistory — `prisma.scanHistory.count()` backs the admin
// "Total Scans" tile, and quietly inflating a real number with non-scans is the
// same fabrication as inventing one outright.
//
// The reasons below are all directly MEASURED (a Laplacian variance below a
// floor, a mean luminance outside a band). None of them is a conclusion about
// the user, the card, or the AI.

/** Why the quality gate declined a frame. Each value names a measured property
 *  of the frame — never an inference about the card or the scanner. */
export const CAPTURE_FAILURE_REASONS = [
  /** Camera not started/warmed, or no frame available to measure yet. */
  "not-ready",
  /** Mean luminance below the floor. */
  "too-dark",
  /** Mean luminance above the ceiling. */
  "too-bright",
  /** Laplacian variance below MIN_SHARPNESS. */
  "too-blurry",
] as const;

export type CaptureFailureReason = (typeof CAPTURE_FAILURE_REASONS)[number];

/** Which capture path produced the frame. Mirrors captureBestFrame()'s
 *  debugLabel, so the two cannot drift. "smart" is the readiness-driven
 *  auto-capture machine; "auto" is the legacy fixed-timer path. */
export const CAPTURE_MODES = ["manual", "smart", "auto"] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export function isCaptureFailureReason(value: unknown): value is CaptureFailureReason {
  return typeof value === "string" && (CAPTURE_FAILURE_REASONS as readonly string[]).includes(value);
}

export function isCaptureMode(value: unknown): value is CaptureMode {
  return typeof value === "string" && (CAPTURE_MODES as readonly string[]).includes(value);
}
