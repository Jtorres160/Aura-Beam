"use client";

import { useEffect, useState } from "react";

/** After this long, the scan is honestly unusual — say so rather than keep
 *  cycling reassurances. Chosen to sit above the normal OCR round trip so a
 *  healthy scan never trips it. */
const SLOW_SCAN_MS = 6000;

/**
 * Elapsed-time readout for the processing state.
 *
 * Isolated into its own component for the same reason as CaptureGuidance: it
 * ticks several times a second, and the scanner page is a large tree we don't
 * want re-rendering at that rate.
 *
 * Deliberately NOT a stage checklist. The scan is a single POST to
 * /api/scanner/scan which returns once; the client observes no intermediate
 * pipeline milestones, so anything staged would be a timer wearing a
 * progress bar's clothes. Elapsed time is the one thing actually being
 * measured here, so it's the one thing reported.
 */
export function ExaminingStatus() {
  const [elapsedMs, setElapsedMs] = useState(0);

  useEffect(() => {
    const startedAt = performance.now();
    const id = setInterval(() => setElapsedMs(performance.now() - startedAt), 100);
    return () => clearInterval(id);
  }, []);

  const isSlow = elapsedMs >= SLOW_SCAN_MS;

  return (
    <div className="space-y-1">
      <p
        className="font-mono text-xs uppercase tracking-[0.14em] text-muted-foreground tabular-nums"
        aria-live="off"
      >
        {(elapsedMs / 1000).toFixed(1)}s elapsed
      </p>
      {/* Only announced once it becomes true — a live region that fires every
          tick would make screen readers unusable. */}
      <p
        className="text-xs text-muted-foreground min-h-[1rem]"
        role="status"
        aria-live="polite"
      >
        {isSlow
          ? "Still working — this one is taking longer than usual."
          : "Identifying the printing and pulling live market pricing."}
      </p>
    </div>
  );
}
