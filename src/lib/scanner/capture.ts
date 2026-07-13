// ─── Image Acquisition (Phase 4) ────────────────────────────────────────────
// Browser-only helpers that own the capture pipeline BEFORE the image is
// uploaded for OCR. Everything here runs on the client (needs <video>/<canvas>)
// and is deliberately kept out of page.tsx so the component stays thin.
//
// Responsibilities:
//   1. Capture several frames and keep the SHARPEST (deterministic Laplacian
//      variance) instead of blindly using the first frame the camera hands us.
//   2. Gate obviously-poor frames (too dark / blown out / badly out of focus)
//      so we never waste an OCR request on an unreadable image.
//   3. Encode the chosen frame preserving aspect ratio, at a resolution/quality
//      high enough for the tiny set-code / collector-number strip to survive.
//
// This module produces IMAGES only. It knows nothing about card identity — the
// OCR/decision layers downstream are untouched.

// ─── Tunables ───────────────────────────────────────────────────────────────

/** Preferred camera capture resolution (QHD). Requested as `ideal`, so the
 *  browser falls back gracefully to whatever the device actually supports. */
export const PREFERRED_CAMERA_WIDTH = 2560;
export const PREFERRED_CAMERA_HEIGHT = 1440;

/** Longest edge of the uploaded JPEG. Raised from the old 1024 so the bottom
 *  strip's sub-millimeter text survives; still capped so uploads stay bounded. */
export const CAPTURE_MAX_DIM = 2048;

/** JPEG quality for the uploaded frame. Higher than the old 0.85 to preserve
 *  fine text edges that OCR relies on, while keeping file size reasonable. */
export const CAPTURE_JPEG_QUALITY = 0.92;

/** Frames sampled per capture. Manual capture can afford more; the auto-scan
 *  loop runs every few seconds and stays lighter. */
export const MANUAL_FRAME_COUNT = 5;
export const AUTO_FRAME_COUNT = 3;

/** Delay between sampled frames (ms). Long enough for the camera to hand us a
 *  genuinely new frame, short enough to be imperceptible on manual capture. */
const FRAME_INTERVAL_MS = 55;

/** Sharpness/brightness are measured on a small normalized grayscale copy so
 *  the thresholds below are independent of the camera's native resolution.
 *  Exported (Phase 5.2.5): the live-metrics loop analyses at the SAME dim over
 *  the SAME ROI content, so readiness and this gate finally share one scale. */
export const ANALYSIS_DIM = 256;

// ─── ROI capture (Phase 4.5 · Commit 2) ──────────────────────────────────────

/** Whether ROI (guide-box) capture is on by default. Behind a dev toggle in the
 *  scanner so ROI can be A/B'd against full-frame during calibration. */
export const ROI_CAPTURE_DEFAULT = true;

/** Fraction the guide rect is expanded on EACH side before cropping, so slight
 *  misframing and the card's bottom set-code/collector strip are never clipped.
 *  Kept as a single knob — tune during calibration (~0.15–0.20). */
export const ROI_CAPTURE_PAD = 0.18;

/** A rectangle in SOURCE (camera) pixel space to crop the capture to. */
export interface CaptureRegion {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}

/** Inputs for mapping the on-screen guide box back to source camera pixels.
 *  All screen values are CSS px; source values are `video.videoWidth/Height`.
 *  `guideX/Y` are the guide rect's offset RELATIVE to the video element. */
export interface RoiParams {
  sourceW: number;
  sourceH: number;
  elemW: number;
  elemH: number;
  guideX: number;
  guideY: number;
  guideW: number;
  guideH: number;
  /** Per-side expansion fraction (see ROI_CAPTURE_PAD). */
  pad: number;
}

/**
 * Map the on-screen guide box to a crop rectangle in the camera's source
 * pixels, accounting for `object-fit: cover` (uniform scale + centered crop)
 * and a forgiving padding margin. Pure/deterministic and DPR-independent:
 * screen values are CSS px, source values are device px, and `coverScale`
 * bridges them.
 *
 * Returns null when any measurement is invalid or the result is degenerate —
 * callers MUST fall back to full-frame capture in that case, so ROI can never
 * make capture worse than before.
 */
export function computeCaptureRoi(p: RoiParams): CaptureRegion | null {
  const { sourceW, sourceH, elemW, elemH, guideX, guideY, guideW, guideH, pad } = p;
  if (
    !(sourceW > 0 && sourceH > 0 && elemW > 0 && elemH > 0 && guideW > 0 && guideH > 0)
  ) {
    return null;
  }

  // object-fit: cover — scale so the source fully fills the element, cropping
  // the overflow on the longer axis, centered.
  const coverScale = Math.max(elemW / sourceW, elemH / sourceH);
  if (!Number.isFinite(coverScale) || coverScale <= 0) return null;

  // Cropped-off amount per side, in element/display px (one axis is ~0).
  const cropX = (sourceW * coverScale - elemW) / 2;
  const cropY = (sourceH * coverScale - elemH) / 2;

  // Expand the guide rect by the padding margin (element space) …
  const gx = guideX - guideW * pad;
  const gy = guideY - guideH * pad;
  const gw = guideW * (1 + 2 * pad);
  const gh = guideH * (1 + 2 * pad);

  // … then map element space → source space.
  let sx = (gx + cropX) / coverScale;
  let sy = (gy + cropY) / coverScale;
  let sw = gw / coverScale;
  let sh = gh / coverScale;

  // Clamp inside the source frame so we never sample outside it.
  sx = Math.max(0, Math.min(sx, sourceW));
  sy = Math.max(0, Math.min(sy, sourceH));
  sw = Math.max(0, Math.min(sw, sourceW - sx));
  sh = Math.max(0, Math.min(sh, sourceH - sy));

  if (sw < 10 || sh < 10) return null; // degenerate → caller falls back
  return { sx, sy, sw, sh };
}

// Quality-gate thresholds (measured on the ANALYSIS_DIM grayscale, 0–255).
// Deliberately CONSERVATIVE — reject only obviously unusable frames.
// MIN_SHARPNESS is exported as the ONE sharpness floor: readiness.ts uses the
// same constant, so "Ready to scan" can never coexist with a "too blurry"
// rejection of the same still scene (Phase 5.2.5 gate alignment).
const NOT_READY_BRIGHTNESS = 8;   // effectively a black frame (camera warming up)
const MIN_BRIGHTNESS = 32;        // too dark to read
const MAX_BRIGHTNESS = 236;       // blown out / overexposed
export const MIN_SHARPNESS = 22;  // Laplacian variance floor (badly out of focus)

// ─── Types ──────────────────────────────────────────────────────────────────

export interface QualityMetrics {
  /** Laplacian variance of the normalized grayscale frame. Higher = sharper. */
  sharpness: number;
  /** Mean luminance of the normalized grayscale frame (0–255). */
  brightness: number;
}

export type CaptureFailureReason =
  | "not-ready"
  | "too-dark"
  | "too-bright"
  | "too-blurry";

/** TEMPORARY calibration metadata (Phase 4.5) — lets us verify ROI behavior
 *  across devices. Not consumed by OCR/decision logic. */
export interface CaptureDebug {
  sourceW: number;
  sourceH: number;
  /** null = full-frame capture (ROI disabled or fell back). */
  roi: CaptureRegion | null;
  encodedW: number;
  encodedH: number;
}

export type CaptureResult =
  | { ok: true; dataUrl: string; metrics: QualityMetrics; debug: CaptureDebug }
  | { ok: false; reason: CaptureFailureReason; message: string };

export interface CaptureOptions {
  /** How many frames to sample before picking the sharpest. */
  frameCount?: number;
  /** Long-edge cap for the encoded JPEG. */
  maxDim?: number;
  /** JPEG quality (0–1). */
  quality?: number;
  /** Crop rectangle in source pixels. When omitted, the full frame is used. */
  roi?: CaptureRegion;
  /** TEMPORARY label for dev capture logging (e.g. "manual", "auto"). */
  debugLabel?: string;
}

// ─── Frame drawing ──────────────────────────────────────────────────────────

/** Draw the current video frame onto `canvas`, downscaled so the long edge is
 *  at most `maxDim`, preserving aspect ratio. When `roi` is given, only that
 *  source rectangle is drawn (cropped to the guide box); otherwise the full
 *  frame is used. Returns false if the video has no usable frame yet. */
function drawFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxDim: number,
  roi?: CaptureRegion
): boolean {
  if (
    !video.videoWidth ||
    !video.videoHeight ||
    video.videoWidth < 10 ||
    video.videoHeight < 10
  ) {
    return false;
  }

  // Source rectangle: the ROI crop, or the whole frame.
  const srcX = roi ? roi.sx : 0;
  const srcY = roi ? roi.sy : 0;
  const srcW = roi ? roi.sw : video.videoWidth;
  const srcH = roi ? roi.sh : video.videoHeight;
  if (srcW < 10 || srcH < 10) return false;

  // Cap the long edge at maxDim (only ever downscale — never upsample the crop).
  let w = srcW;
  let h = srcH;
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = (h * maxDim) / w;
      w = maxDim;
    } else {
      w = (w * maxDim) / h;
      h = maxDim;
    }
  }

  canvas.width = Math.max(1, Math.round(w));
  canvas.height = Math.max(1, Math.round(h));
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(video, srcX, srcY, srcW, srcH, 0, 0, canvas.width, canvas.height);
  return true;
}

// ─── Metrics ────────────────────────────────────────────────────────────────

/** Downscale the canvas to a small grayscale buffer for cheap, resolution-
 *  independent analysis. Returns the grayscale plane plus its dimensions. */
function toAnalysisGray(
  canvas: HTMLCanvasElement
): { gray: Float32Array; w: number; h: number } | null {
  const srcW = canvas.width;
  const srcH = canvas.height;
  if (!srcW || !srcH) return null;

  let w = srcW;
  let h = srcH;
  if (w > ANALYSIS_DIM || h > ANALYSIS_DIM) {
    if (w > h) {
      h = Math.max(1, Math.round((h * ANALYSIS_DIM) / w));
      w = ANALYSIS_DIM;
    } else {
      w = Math.max(1, Math.round((w * ANALYSIS_DIM) / h));
      h = ANALYSIS_DIM;
    }
  }

  const small = document.createElement("canvas");
  small.width = w;
  small.height = h;
  const ctx = small.getContext("2d");
  if (!ctx) return null;
  ctx.drawImage(canvas, 0, 0, w, h);

  const { data } = ctx.getImageData(0, 0, w, h);
  const gray = new Float32Array(w * h);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // Rec. 601 luma
    gray[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  }
  return { gray, w, h };
}

/** Variance of the Laplacian — the standard deterministic focus/sharpness
 *  metric. A sharp image has strong high-frequency edges (high variance); a
 *  blurred one does not. Exported so the Phase 4.5 live-metrics engine can
 *  reuse the exact same kernel instead of duplicating (and diverging from) it.
 *  NOTE: the returned magnitude is resolution-dependent — a threshold tuned at
 *  one analysis size is NOT valid at another. */
export function laplacianVariance(gray: Float32Array, w: number, h: number): number {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      // 4-neighbour Laplacian kernel: [[0,1,0],[1,-4,1],[0,1,0]]
      const lap =
        gray[i - 1] +
        gray[i + 1] +
        gray[i - w] +
        gray[i + w] -
        4 * gray[i];
      sum += lap;
      sumSq += lap * lap;
      n++;
    }
  }
  if (n === 0) return 0;
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

function meanBrightness(gray: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < gray.length; i++) sum += gray[i];
  return gray.length ? sum / gray.length : 0;
}

/** Compute sharpness + brightness for the frame currently on `canvas`. */
export function computeMetrics(canvas: HTMLCanvasElement): QualityMetrics | null {
  const analysis = toAnalysisGray(canvas);
  if (!analysis) return null;
  const { gray, w, h } = analysis;
  return {
    sharpness: laplacianVariance(gray, w, h),
    brightness: meanBrightness(gray),
  };
}

// ─── Quality gate ───────────────────────────────────────────────────────────

/** Conservative gate over the chosen frame. Returns the failure reason, or null
 *  when the frame is good enough to send. */
export function assessQuality(
  metrics: QualityMetrics
): { reason: CaptureFailureReason; message: string } | null {
  if (metrics.brightness < NOT_READY_BRIGHTNESS) {
    return {
      reason: "not-ready",
      message: "Camera is not ready. Please wait a moment and try again.",
    };
  }
  if (metrics.brightness < MIN_BRIGHTNESS) {
    return {
      reason: "too-dark",
      message: "It's too dark to read this card. Add more light and scan again.",
    };
  }
  if (metrics.brightness > MAX_BRIGHTNESS) {
    return {
      reason: "too-bright",
      message: "The image is overexposed. Reduce glare or light and scan again.",
    };
  }
  if (metrics.sharpness < MIN_SHARPNESS) {
    return {
      reason: "too-blurry",
      message: "That looked blurry. Hold steady and scan again.",
    };
  }
  return null;
}

// ─── Capture orchestration ──────────────────────────────────────────────────

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sample several frames, keep the sharpest, gate it for quality, and encode it.
 *
 * The sharpest frame is chosen by Laplacian variance so hand-shake / motion
 * blur on any single frame is discarded. The winning frame is then re-drawn at
 * full capture resolution and JPEG-encoded for upload.
 */
export async function captureSharpestFrame(
  video: HTMLVideoElement | null,
  canvas: HTMLCanvasElement | null,
  opts: CaptureOptions = {}
): Promise<CaptureResult> {
  if (!video || !canvas) {
    return { ok: false, reason: "not-ready", message: "Camera is not ready. Please wait a moment and try again." };
  }

  const frameCount = Math.max(1, opts.frameCount ?? MANUAL_FRAME_COUNT);
  const maxDim = opts.maxDim ?? CAPTURE_MAX_DIM;
  const quality = opts.quality ?? CAPTURE_JPEG_QUALITY;
  const roi = opts.roi;

  // For each sampled frame, measure sharpness and, if it's the best so far,
  // copy its PIXELS to a holding canvas (a cheap blit — the expensive JPEG
  // encode happens exactly once, after the quality gate). The copy is needed
  // because the next, possibly blurrier frame overwrites the working canvas.
  let best: { metrics: QualityMetrics; canvas: HTMLCanvasElement } | null = null;

  for (let i = 0; i < frameCount; i++) {
    if (i > 0) await wait(FRAME_INTERVAL_MS);
    if (!drawFrame(video, canvas, maxDim, roi)) continue;
    const metrics = computeMetrics(canvas);
    if (!metrics) continue;
    if (!best || metrics.sharpness > best.metrics.sharpness) {
      const holder: HTMLCanvasElement = best ? best.canvas : document.createElement("canvas");
      holder.width = canvas.width;
      holder.height = canvas.height;
      const ctx = holder.getContext("2d");
      if (!ctx) continue;
      ctx.drawImage(canvas, 0, 0);
      best = { metrics, canvas: holder };
    }
  }

  if (!best) {
    return { ok: false, reason: "not-ready", message: "Camera is not ready. Please wait a moment and try again." };
  }

  const failure = assessQuality(best.metrics);
  if (failure) return { ok: false, reason: failure.reason, message: failure.message };

  const debug: CaptureDebug = {
    sourceW: video.videoWidth,
    sourceH: video.videoHeight,
    roi: roi ?? null,
    encodedW: best.canvas.width,
    encodedH: best.canvas.height,
  };

  // TEMPORARY (Phase 4.5) — verify ROI vs full-frame dimensions across devices.
  if (process.env.NODE_ENV === "development") {
    const label = opts.debugLabel ? ` [${opts.debugLabel}]` : "";
    const roiStr = roi
      ? `${Math.round(roi.sw)}x${Math.round(roi.sh)}@${Math.round(roi.sx)},${Math.round(roi.sy)}`
      : "full-frame";
    console.log(
      `[ROICapture]${label} source=${debug.sourceW}x${debug.sourceH} ` +
        `roi=${roiStr} encoded=${debug.encodedW}x${debug.encodedH}`
    );
  }

  return {
    ok: true,
    dataUrl: best.canvas.toDataURL("image/jpeg", quality),
    metrics: best.metrics,
    debug,
  };
}
