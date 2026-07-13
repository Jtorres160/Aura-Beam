// ─── Capture Readiness (Phase 4.5 · Commit 3) ────────────────────────────────
// A PURE, deterministic evaluator that turns one raw LiveMetrics sample into a
// single user-facing guidance state. It owns the *policy* ("is this frame good
// enough, and if not, what's the one thing to fix?") while live-metrics.ts owns
// only the raw measurement.
//
// This is the SINGLE SOURCE OF TRUTH for "is this frame ready": Commit 3 (live
// guidance) renders its message, and Commit 4 (smart auto-capture) will gate on
// the same result — so guidance and auto-capture can never disagree.
//
// Thresholds here are DELIBERATELY separate from capture.ts's assessQuality()
// gate: those run at 256px on the final (possibly ROI-cropped) frame, whereas
// live metrics run at 192px on the FULL frame — different scales, not
// interchangeable. Tune these against the dev HUD.

import type { LiveMetrics } from "./live-metrics";

// ─── Thresholds (named + easy to tune) ────────────────────────────────────

export interface ReadinessThresholds {
  /** Below this mean luma (0–255) the frame is too dark to read. */
  minBrightness: number;
  /** Above this mean luma the frame is washed out / overexposed. */
  maxBrightness: number;
  /** Above this fraction (0–1) of specular pixels, glare is a problem. */
  maxGlareFraction: number;
  /** Above this mean-abs-luma-diff (0–255) the camera/card is still moving. */
  maxMotion: number;
  /** Below this Laplacian variance (192px scale) the frame is grossly blurry.
   *  Kept LOW on purpose — full-frame sharpness is the weakest signal (a sharp
   *  background can mask a soft card), so it only flags obvious blur and never
   *  dominates guidance. */
  minSharpness: number;
}

/** Starting values — calibration targets, tuned via the dev HUD. */
export const LIVE_THRESHOLDS: ReadinessThresholds = {
  minBrightness: 45,
  maxBrightness: 232,
  maxGlareFraction: 0.06, // ~6% of the frame blown to specular white
  // Mean |Δluma| (0–255) between consecutive ~10Hz full-frame samples.
  // Calibrated for HANDHELD scanning, not a stationary card. On detailed card
  // art, temporal sensor noise alone reads ~1.5–4.5 and natural hand micro-
  // tremor pushes a "held reasonably still" card to ~3–8, while deliberately
  // sweeping a card into frame reads ~10–40+. The old 3.5 sat inside the
  // noise+tremor band, so a steady handheld hold rarely crossed it and the
  // guidance chip stayed on "Hold steady" — the scanner felt too slow to arm.
  // 7.0 admits natural tremor while still rejecting real motion. This is SAFE
  // for quality: readiness only gates the chip and auto-capture ARMING; the
  // capture pipeline still samples N frames, keeps the sharpest, and rejects a
  // blurry result (assessQuality) before any OCR — so a slightly-moving frame
  // that passes here can never degrade the uploaded image or recognition.
  maxMotion: 7.0,
  minSharpness: 12,
};

// ─── Readiness state ──────────────────────────────────────────────────────

export type GuidanceCode =
  | "too-dark"
  | "too-bright"
  | "glare"
  | "hold-steady"
  | "ready";

export interface Readiness {
  code: GuidanceCode;
  /** True only when code === "ready". */
  ready: boolean;
  /** User-facing copy for the guidance chip. */
  message: string;
  /** Calibration aid: the raw metric value that drove this state, and the
   *  threshold it was compared against. Not shown to users. */
  debug: {
    metric: "brightness" | "glare" | "motion" | "sharpness" | "none";
    value: number;
    threshold: number;
  };
}

const MESSAGES: Record<GuidanceCode, string> = {
  "too-dark": "Too dark — add more light",
  "too-bright": "Too bright — reduce light or glare",
  glare: "Reduce glare — tilt the card slightly",
  "hold-steady": "Hold steady",
  ready: "Ready to scan",
};

/**
 * Evaluate a single sample. Checks run in priority order (worst problem wins);
 * the first failing check determines the message. "Hold steady" intentionally
 * covers BOTH residual motion and not-yet-sharp, since staying still fixes both
 * (it lets autofocus lock).
 *
 * Pure: no side effects, no allocation beyond the returned object.
 */
export function evaluateReadiness(
  m: LiveMetrics,
  t: ReadinessThresholds = LIVE_THRESHOLDS
): Readiness {
  const make = (
    code: GuidanceCode,
    metric: Readiness["debug"]["metric"],
    value: number,
    threshold: number
  ): Readiness => ({
    code,
    ready: code === "ready",
    message: MESSAGES[code],
    debug: { metric, value, threshold },
  });

  if (m.brightness < t.minBrightness) {
    return make("too-dark", "brightness", m.brightness, t.minBrightness);
  }
  if (m.brightness > t.maxBrightness) {
    return make("too-bright", "brightness", m.brightness, t.maxBrightness);
  }
  if (m.glare > t.maxGlareFraction) {
    return make("glare", "glare", m.glare, t.maxGlareFraction);
  }
  // Motion first (more actionable), then sharpness — both surface "Hold steady".
  if (m.motion > t.maxMotion) {
    return make("hold-steady", "motion", m.motion, t.maxMotion);
  }
  if (m.sharpness < t.minSharpness) {
    return make("hold-steady", "sharpness", m.sharpness, t.minSharpness);
  }
  return make("ready", "none", 0, 0);
}
