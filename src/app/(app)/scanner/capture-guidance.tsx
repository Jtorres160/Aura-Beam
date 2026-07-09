"use client";

// ─── Live Capture Guidance (Phase 4.5 · Commit 3) ────────────────────────────
// A single, user-facing guidance chip driven by the live-metrics engine. It is
// deliberately ISOLATED: it owns its own rAF poll and state, so live updates
// re-render only this chip — never the scanner page (which holds the video/
// canvas refs). It reads controller.getLatest(), maps it through the shared
// evaluateReadiness() policy, debounces to prevent flicker, and shows at most
// ONE message at a time.
//
// It consumes only — it triggers no capture. Commit 4's auto-capture will run
// its own loop over the SAME evaluateReadiness(), independent of this chip.

import { useEffect, useRef, useState } from "react";
import { Check, AlertTriangle } from "lucide-react";
import type { LiveMetricsController } from "@/lib/scanner/live-metrics";
import { evaluateReadiness, type GuidanceCode, type Readiness } from "@/lib/scanner/readiness";
import { cn } from "@/lib/utils";

interface Props {
  controllerRef: { current: LiveMetricsController | null };
}

/** A sample older than this (ms) is stale — hide the chip (camera warming up,
 *  tab was hidden, loop paused). */
const STALE_MS = 500;

/** Debounce: a new state must persist this long before it's displayed, so the
 *  chip doesn't flicker at ~10Hz near a threshold. "ready" confirms slower than
 *  a problem — hysteresis so green doesn't flash prematurely. */
const CONFIRM_MS_PROBLEM = 200;
const CONFIRM_MS_READY = 350;

type DisplayCode = GuidanceCode | "hidden";

export function CaptureGuidance({ controllerRef }: Props) {
  const [display, setDisplay] = useState<Readiness | null>(null);
  const rafRef = useRef(0);
  const displayCodeRef = useRef<DisplayCode>("hidden");

  useEffect(() => {
    let candidate: DisplayCode | null = null;
    let candidateSince = 0;

    const loop = (now: number) => {
      rafRef.current = requestAnimationFrame(loop);

      const m = controllerRef.current?.getLatest() ?? null;

      // Resolve the target state for this frame.
      let targetCode: DisplayCode;
      let readiness: Readiness | null;
      if (!m || now - m.at > STALE_MS) {
        targetCode = "hidden";
        readiness = null;
      } else {
        readiness = evaluateReadiness(m);
        targetCode = readiness.code;
      }

      // Already showing it → cancel any pending change, nothing to do.
      if (targetCode === displayCodeRef.current) {
        candidate = null;
        return;
      }

      // Debounce the transition.
      if (candidate !== targetCode) {
        candidate = targetCode;
        candidateSince = now;
        return;
      }
      const needed = targetCode === "ready" ? CONFIRM_MS_READY : CONFIRM_MS_PROBLEM;
      if (now - candidateSince < needed) return;

      // Commit the change (only place that re-renders).
      candidate = null;
      displayCodeRef.current = targetCode;
      setDisplay(readiness);

      if (process.env.NODE_ENV === "development" && readiness) {
        const d = readiness.debug;
        console.log(
          `[Readiness] ${readiness.code} via ${d.metric}=${d.value.toFixed(2)} thr=${d.threshold}`
        );
      }
    };

    rafRef.current = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(rafRef.current);
  }, [controllerRef]);

  if (!display) return null;

  const isReady = display.ready;
  return (
    <div className="pointer-events-none absolute left-1/2 top-4 z-10 -translate-x-1/2">
      <div
        className={cn(
          "flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-semibold text-white shadow-lg backdrop-blur-sm transition-colors duration-300 border",
          isReady
            ? "bg-emerald-500/85 border-emerald-300/30 shadow-emerald-500/20"
            : "bg-amber-500/85 border-amber-300/30 shadow-amber-500/20"
        )}
        data-metric={display.debug.metric}
      >
        {isReady ? <Check className="h-3.5 w-3.5" /> : <AlertTriangle className="h-3.5 w-3.5" />}
        {display.message}
      </div>
    </div>
  );
}
