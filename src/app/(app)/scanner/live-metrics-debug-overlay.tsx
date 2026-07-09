"use client";

// ─── TEMPORARY · DEV-ONLY · Live Metrics Debug Overlay ───────────────────────
// Phase 4.5 calibration aid. Renders a tiny HUD and emits a throttled console
// log of the raw live-metrics engine values, so we can tune thresholds against
// real cards and real devices before wiring guidance/auto-capture.
//
// It is READ-ONLY: it polls controller.getLatest() and consumes nothing. It
// does not touch scan behavior and drives no readiness/guidance/auto-capture.
// Only rendered in development (see the gated usage in page.tsx).
//
// TO REMOVE: delete this file, its import in page.tsx, and the single
// <LiveMetricsDebugOverlay/> usage.

import { useEffect, useRef, useState } from "react";
import type { LiveMetrics, LiveMetricsController } from "@/lib/scanner/live-metrics";

interface Props {
  /** The scanner's live-metrics controller ref (may be null until created). */
  controllerRef: { current: LiveMetricsController | null };
  /** Current ROI-capture toggle state (for the A/B calibration button). */
  roiEnabled?: boolean;
  /** Flip ROI capture on/off. When omitted, the toggle button is hidden. */
  onToggleRoi?: () => void;
  /** Current legacy-timed-auto flag (true = old 4s timer, false = smart). */
  legacyTimedAuto?: boolean;
  /** Flip auto-scan between smart and the legacy timer. Hidden when omitted. */
  onToggleLegacyTimedAuto?: () => void;
}

interface View {
  sharpness: number;
  brightness: number;
  glare: number;
  motion: number;
  fps: number;
}

const UI_UPDATE_MS = 250; // on-screen refresh ~4Hz
const LOG_MS = 1000; // console log ~1Hz (throttled so it never spams)

export function LiveMetricsDebugOverlay({
  controllerRef,
  roiEnabled,
  onToggleRoi,
  legacyTimedAuto,
  onToggleLegacyTimedAuto,
}: Props) {
  const [view, setView] = useState<View | null>(null);
  const rafRef = useRef(0);

  useEffect(() => {
    let lastAt = 0;
    let fps = 0;
    let lastUiAt = 0;
    let lastLogAt = 0;
    let snapshot: View | null = null;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      const m: LiveMetrics | null = controllerRef.current?.getLatest() ?? null;
      // New sample? Measure real sampling frequency from its timestamp.
      if (m && m.at !== lastAt) {
        if (lastAt) {
          const dt = m.at - lastAt;
          if (dt > 0) {
            const inst = 1000 / dt;
            fps = fps ? fps * 0.8 + inst * 0.2 : inst; // EMA smoothing
          }
        }
        lastAt = m.at;
        snapshot = {
          sharpness: m.sharpness,
          brightness: m.brightness,
          glare: m.glare,
          motion: m.motion,
          fps,
        };
      }

      if (!snapshot) return;

      if (now - lastUiAt >= UI_UPDATE_MS) {
        lastUiAt = now;
        setView(snapshot);
      }
      if (now - lastLogAt >= LOG_MS) {
        lastLogAt = now;
        const s = snapshot;
        console.log(
          `[LiveMetrics] sharp=${s.sharpness.toFixed(1)} ` +
            `bright=${s.brightness.toFixed(1)} ` +
            `glare=${(s.glare * 100).toFixed(1)}% ` +
            `motion=${s.motion.toFixed(2)} ` +
            `fps=${s.fps.toFixed(1)}`
        );
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [controllerRef]);

  return (
    <div className="absolute bottom-2 left-2 z-20 select-none rounded-md border border-emerald-400/20 bg-black/70 px-2.5 py-1.5 font-mono text-[10px] leading-tight text-emerald-300 backdrop-blur-sm">
      <div className="mb-0.5 text-[9px] uppercase tracking-wider text-emerald-500/70">live metrics · dev</div>
      {view ? (
        <div className="pointer-events-none">
          <div>sharp&nbsp;&nbsp;<span className="text-white">{view.sharpness.toFixed(1)}</span></div>
          <div>bright&nbsp;<span className="text-white">{view.brightness.toFixed(1)}</span></div>
          <div>glare&nbsp;&nbsp;<span className="text-white">{(view.glare * 100).toFixed(1)}%</span></div>
          <div>motion&nbsp;<span className="text-white">{view.motion.toFixed(2)}</span></div>
          <div>fps&nbsp;&nbsp;&nbsp;<span className="text-white">{view.fps.toFixed(1)}</span></div>
        </div>
      ) : (
        <div className="pointer-events-none text-emerald-500/60">warming up…</div>
      )}
      {onToggleRoi && (
        <button
          type="button"
          onClick={onToggleRoi}
          className="mt-1.5 w-full rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20"
        >
          ROI: <span className="font-bold text-white">{roiEnabled ? "ON" : "OFF"}</span>
        </button>
      )}
      {onToggleLegacyTimedAuto && (
        <button
          type="button"
          onClick={onToggleLegacyTimedAuto}
          className="mt-1 w-full rounded border border-emerald-400/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] text-emerald-200 hover:bg-emerald-500/20"
        >
          AUTO: <span className="font-bold text-white">{legacyTimedAuto ? "TIMED" : "SMART"}</span>
        </button>
      )}
    </div>
  );
}
