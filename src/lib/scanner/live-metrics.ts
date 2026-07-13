// ─── Live Capture Metrics (Phase 4.5 · Commit 1) ─────────────────────────────
// A cheap, allocation-conscious loop that continuously measures the camera
// preview WHILE the user is framing a card — before any capture happens. It
// produces RAW metrics only (sharpness / brightness / glare / motion); it makes
// no decisions. Readiness/guidance (Commit 3) and smart auto-capture (Commit 4)
// consume these numbers, so this module deliberately owns none of that policy.
//
// Design constraints (from the Phase 4.5 plan):
//   • ~8–10 Hz while scanning; nothing when the tab is hidden or scanning stops.
//   • Reuse the analysis canvas + grayscale buffers across frames. The ONLY
//     per-frame allocation is `getImageData`'s RGBA array — Canvas2D exposes no
//     read-into-existing-buffer API. It is kept small (≤256px long edge) and
//     fixed-size, so GC pressure is negligible and predictable.
//   • Phase 5.2.5 gate alignment: it measures the guide-box ROI (when the
//     caller provides one) at the capture gate's ANALYSIS_DIM — the SAME
//     content at the SAME scale as assessQuality(). Before this it measured
//     the full frame at 192px, so a textured background could report "sharp"
//     while the actual card failed the capture gate — the UI said "Ready to
//     scan" while every capture was silently rejected as too blurry.
//
// This module does NOT touch OCR, capture encoding, or scan behavior.

import { ANALYSIS_DIM, laplacianVariance, type CaptureRegion } from "./capture";

// ─── Tunables ─────────────────────────────────────────────────────────────

/** Long edge of the grayscale buffer the live loop analyses. Matches the
 *  one-shot capture gate's ANALYSIS_DIM so live sharpness IS comparable to
 *  `MIN_SHARPNESS` in capture.ts (one scale, one truth). */
export const LIVE_ANALYSIS_DIM = ANALYSIS_DIM;

/** Target sample rate. Hand-steadiness doesn't need 60fps; ~10Hz is plenty and
 *  keeps mobile CPU/battery cost near zero. */
export const LIVE_TARGET_HZ = 10;

/** Luma (0–255) at/above which a pixel counts as specular/glare. Reported as a
 *  fraction of the frame; consumers decide what fraction is "too much". */
export const GLARE_LUMA_THRESHOLD = 250;

/** Reported motion value for the first sample after start/resume, when there is
 *  no previous frame to diff against. Max on the 0–255 scale so downstream
 *  stability checks never treat a fresh start as "already stable". */
const MOTION_UNKNOWN = 255;

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LiveMetrics {
  /** Laplacian variance of the grayscale frame. Higher = sharper. Scale is tied
   *  to LIVE_ANALYSIS_DIM — do not compare against the capture gate's value. */
  sharpness: number;
  /** Mean luma of the frame (0–255). */
  brightness: number;
  /** Fraction (0–1) of near-white / specular pixels — a proxy for glare. */
  glare: number;
  /** Mean absolute luma difference vs the previous sampled frame (0–255).
   *  MOTION_UNKNOWN (255) on the first sample after start/resume. */
  motion: number;
  /** performance.now() timestamp of this sample. */
  at: number;
}

export type SampleListener = (metrics: LiveMetrics) => void;

export interface LiveMetricsOptions {
  /** Sample rate in Hz (default LIVE_TARGET_HZ). */
  hz?: number;
  /** Called with every fresh sample. Optional — consumers may poll getLatest()
   *  instead. Both are provided so Commits 3/4 need no engine changes. */
  onSample?: SampleListener;
}

// ─── Controller ───────────────────────────────────────────────────────────

/**
 * Owns the live analysis loop for a single <video> element. Construct once and
 * reuse across camera restarts: `start(video)` (re)binds the loop, `stop()`
 * tears it down. All heavy buffers are retained between runs for cheap restart.
 */
export class LiveMetricsController {
  private readonly intervalMs: number;
  private readonly onSample?: SampleListener;

  // Reused across frames — allocated lazily, resized only if the video's
  // aspect ratio changes (effectively never within a session).
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private gray: Float32Array | null = null;
  private prev: Float32Array | null = null;
  private bufW = 0;
  private bufH = 0;
  private hasPrev = false;

  private video: HTMLVideoElement | null = null;
  /** Supplies the source-pixel region to analyse (the guide-box card area).
   *  null/undefined result → full frame, matching capture's ROI fallback. */
  private getRoi: (() => CaptureRegion | null) | null = null;
  private running = false;
  private rafId = 0;
  private lastSampleAt = 0;
  private latest: LiveMetrics | null = null;

  constructor(opts: LiveMetricsOptions = {}) {
    const hz = opts.hz && opts.hz > 0 ? opts.hz : LIVE_TARGET_HZ;
    this.intervalMs = 1000 / hz;
    this.onSample = opts.onSample;
  }

  /** Most recent sample, or null if none has been taken yet. */
  getLatest(): LiveMetrics | null {
    return this.latest;
  }

  /** Begin sampling `video`. Idempotent: a running loop is torn down first, so
   *  this safely re-binds after a camera restart with a new <video> element.
   *  `getRoi` (Phase 5.2.5) scopes analysis to the guide-box card region so
   *  readiness judges the same pixels the capture gate will. */
  start(video: HTMLVideoElement, getRoi?: () => CaptureRegion | null): void {
    if (typeof window === "undefined") return; // SSR / non-DOM guard
    this.stop();
    this.video = video;
    this.getRoi = getRoi ?? null;
    this.running = true;
    this.hasPrev = false; // fresh motion baseline
    this.lastSampleAt = 0;
    document.addEventListener("visibilitychange", this.onVisibility);
    this.rafId = requestAnimationFrame(this.tick);
  }

  /** Stop sampling and detach listeners. Buffers/canvas are retained (small,
   *  fixed-size) so a subsequent start() is cheap. */
  stop(): void {
    this.running = false;
    if (this.rafId) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    if (typeof document !== "undefined") {
      document.removeEventListener("visibilitychange", this.onVisibility);
    }
    this.video = null;
    this.getRoi = null;
    this.hasPrev = false;
  }

  // rAF already halts in background tabs; this makes the pause explicit and,
  // on resume, drops the motion baseline since the scene may have changed.
  private onVisibility = (): void => {
    if (!this.running) return;
    if (document.hidden) {
      if (this.rafId) {
        cancelAnimationFrame(this.rafId);
        this.rafId = 0;
      }
    } else {
      this.hasPrev = false;
      this.lastSampleAt = 0;
      if (!this.rafId) this.rafId = requestAnimationFrame(this.tick);
    }
  };

  private tick = (now: number): void => {
    if (!this.running) return;
    // Schedule the next frame first, then decide whether to do work this tick.
    this.rafId = requestAnimationFrame(this.tick);
    if (now - this.lastSampleAt < this.intervalMs) return;

    const v = this.video;
    // readyState >= 2 (HAVE_CURRENT_DATA) guarantees a decodable frame.
    if (!v || v.readyState < 2 || !v.videoWidth || !v.videoHeight) return;

    this.lastSampleAt = now;
    this.sample(v, now);
  };

  /** Lazily (re)allocate the analysis canvas + buffers for the current video
   *  aspect ratio. Returns false if a 2D context can't be obtained. */
  private ensureBuffers(videoW: number, videoH: number): boolean {
    let w = videoW;
    let h = videoH;
    if (w > LIVE_ANALYSIS_DIM || h > LIVE_ANALYSIS_DIM) {
      if (w > h) {
        h = Math.max(1, Math.round((h * LIVE_ANALYSIS_DIM) / w));
        w = LIVE_ANALYSIS_DIM;
      } else {
        w = Math.max(1, Math.round((w * LIVE_ANALYSIS_DIM) / h));
        h = LIVE_ANALYSIS_DIM;
      }
    }

    if (!this.canvas) {
      this.canvas = document.createElement("canvas");
      // willReadFrequently keeps getImageData on a CPU-backed surface (faster
      // repeated reads, no GPU readback stall).
      this.ctx = this.canvas.getContext("2d", { willReadFrequently: true });
    }
    if (!this.ctx) return false;

    if (w !== this.bufW || h !== this.bufH || !this.gray || !this.prev) {
      this.canvas.width = w;
      this.canvas.height = h;
      this.gray = new Float32Array(w * h);
      this.prev = new Float32Array(w * h);
      this.bufW = w;
      this.bufH = h;
      this.hasPrev = false; // buffers reset → motion baseline is stale
    }
    return true;
  }

  private sample(video: HTMLVideoElement, now: number): void {
    // Analyse the guide-box ROI when available (degenerate regions fall back
    // to the full frame, mirroring capture's behavior).
    const roi = this.getRoi?.() ?? null;
    const useRoi = !!roi && roi.sw >= 10 && roi.sh >= 10;
    const srcW = useRoi ? roi!.sw : video.videoWidth;
    const srcH = useRoi ? roi!.sh : video.videoHeight;

    if (!this.ensureBuffers(srcW, srcH)) return;
    const ctx = this.ctx!;
    const w = this.bufW;
    const h = this.bufH;
    const gray = this.gray!;
    const prev = this.prev!;

    if (useRoi) {
      ctx.drawImage(video, roi!.sx, roi!.sy, roi!.sw, roi!.sh, 0, 0, w, h);
    } else {
      ctx.drawImage(video, 0, 0, w, h);
    }
    // The single unavoidable per-frame allocation (fixed, tiny).
    const { data } = ctx.getImageData(0, 0, w, h);

    // One pass: grayscale fill + brightness sum + glare count fused together.
    let brightSum = 0;
    let glareCount = 0;
    for (let i = 0, p = 0; i < data.length; i += 4, p++) {
      // Rec. 601 luma, matching capture.ts.
      const luma = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
      gray[p] = luma;
      brightSum += luma;
      if (luma >= GLARE_LUMA_THRESHOLD) glareCount++;
    }

    const n = gray.length;
    const brightness = n ? brightSum / n : 0;
    const glare = n ? glareCount / n : 0;
    const sharpness = laplacianVariance(gray, w, h);

    // Motion: mean abs luma diff vs the previous sampled frame.
    let motion = MOTION_UNKNOWN;
    if (this.hasPrev) {
      let diff = 0;
      for (let p = 0; p < n; p++) {
        const d = gray[p] - prev[p];
        diff += d < 0 ? -d : d;
      }
      motion = n ? diff / n : 0;
    }
    prev.set(gray); // reuse buffer — no allocation
    this.hasPrev = true;

    const metrics: LiveMetrics = { sharpness, brightness, glare, motion, at: now };
    this.latest = metrics;
    this.onSample?.(metrics);
  }
}
