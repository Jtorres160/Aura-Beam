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
 *  the thresholds below are independent of the camera's native resolution. */
const ANALYSIS_DIM = 256;

// Quality-gate thresholds (measured on the ANALYSIS_DIM grayscale, 0–255).
// Deliberately CONSERVATIVE — reject only obviously unusable frames.
const NOT_READY_BRIGHTNESS = 8;   // effectively a black frame (camera warming up)
const MIN_BRIGHTNESS = 32;        // too dark to read
const MAX_BRIGHTNESS = 236;       // blown out / overexposed
const MIN_SHARPNESS = 22;         // Laplacian variance floor (badly out of focus)

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

export type CaptureResult =
  | { ok: true; dataUrl: string; metrics: QualityMetrics }
  | { ok: false; reason: CaptureFailureReason; message: string };

export interface CaptureOptions {
  /** How many frames to sample before picking the sharpest. */
  frameCount?: number;
  /** Long-edge cap for the encoded JPEG. */
  maxDim?: number;
  /** JPEG quality (0–1). */
  quality?: number;
}

// ─── Frame drawing ──────────────────────────────────────────────────────────

/** Draw the current video frame onto `canvas`, downscaled so the long edge is
 *  at most `maxDim`, preserving aspect ratio. Returns false if the video has no
 *  usable frame yet. */
function drawFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  maxDim: number
): boolean {
  const width = video.videoWidth;
  const height = video.videoHeight;
  if (!width || !height || width < 10 || height < 10) return false;

  let w = width;
  let h = height;
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
  }

  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  ctx.drawImage(video, 0, 0, w, h);
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
 *  blurred one does not. */
function laplacianVariance(gray: Float32Array, w: number, h: number): number {
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

  // For each sampled frame, measure sharpness and, if it's the best so far,
  // copy its PIXELS to a holding canvas (a cheap blit — the expensive JPEG
  // encode happens exactly once, after the quality gate). The copy is needed
  // because the next, possibly blurrier frame overwrites the working canvas.
  let best: { metrics: QualityMetrics; canvas: HTMLCanvasElement } | null = null;

  for (let i = 0; i < frameCount; i++) {
    if (i > 0) await wait(FRAME_INTERVAL_MS);
    if (!drawFrame(video, canvas, maxDim)) continue;
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

  return { ok: true, dataUrl: best.canvas.toDataURL("image/jpeg", quality), metrics: best.metrics };
}
