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
// Phase 5.2.5 gate alignment: live metrics now measure the guide-box ROI at
// capture.ts's ANALYSIS_DIM, i.e. the SAME content at the SAME scale as the
// assessQuality() gate. The sharpness floor below IS the gate's MIN_SHARPNESS
// (one constant), so "Ready to scan" can no longer coexist with a silent
// "too-blurry" capture rejection of the same still scene. Brightness stays
// deliberately STRICTER here than the gate (45–232 vs 32–236): ready implies
// gate-passable, never the reverse.

import { MIN_SHARPNESS } from "./capture";
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
  /** Below this Laplacian variance (ROI content @ capture ANALYSIS_DIM) the
   *  frame would fail the capture gate as blurry. Shares capture.ts's
   *  MIN_SHARPNESS so guidance and the gate agree by construction. */
  minSharpness: number;
}

/** Starting values — calibration targets, tuned via the dev HUD. */
export const LIVE_THRESHOLDS: ReadinessThresholds = {
  minBrightness: 45,
  maxBrightness: 232,
  maxGlareFraction: 0.06, // ~6% of the CARD region blown to specular white
  // Mean |Δluma| (0–255) between consecutive ~10Hz samples of the guide-box
  // ROI. Calibrated for HANDHELD scanning, not a stationary card. On the old
  // FULL-frame measurement, sensor noise read ~1.5–4.5 and steady handheld
  // tremor ~3–8, and 7.0 admitted tremor while rejecting real motion. The ROI
  // measurement (Phase 5.2.5) removes the static background that previously
  // DILUTED the diff, so the same physical tremor reads roughly 1.5–2× higher;
  // 10.0 keeps the identical physical behavior. Validate via ?diag=1 exports.
  // This is SAFE for quality: readiness only gates the chip and auto-capture
  // ARMING; the capture pipeline still samples N frames, keeps the sharpest,
  // and rejects a blurry result (assessQuality) before any OCR.
  maxMotion: 10.0,
  // THE capture-gate floor — not a separate live heuristic. Ready ⇒ the same
  // pixels pass assessQuality's sharpness check.
  minSharpness: MIN_SHARPNESS,
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
