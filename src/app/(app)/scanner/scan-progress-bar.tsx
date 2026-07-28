"use client";

import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useState } from "react";

/**
 * How long the fill takes to travel from its initial sliver to the hold point.
 * Tuned to the typical scan round trip rather than to any reported stage.
 */
const TYPICAL_SCAN_MS = 3500;

/** Where the fill stops and waits for the real response. */
const HOLD_PERCENT = 90;

/**
 * Past this, the scan is genuinely unusual. The bar switches to a slow breathing
 * pulse so it reads as "still alive" instead of "stuck". Deliberately a change
 * in motion, not a sentence — the previous pass' status line is what this
 * screen is moving away from.
 */
const SLOW_SCAN_MS = 7000;

/**
 * How long the snap-to-full takes when the real response lands.
 *
 * Declared above the component because the exit transition has to reference it
 * inline (see the note on `exit` below) — and because the scanner page uses the
 * same value for the processing container's own exit, so the two leave together.
 */
export const SCAN_BAR_EXIT_MS = 140;

/**
 * Indeterminate pacing bar for the processing state.
 *
 * This is NOT progress. The scan is a single non-streaming POST, so there is no
 * completion fraction to report and the bar never claims one — it carries no
 * percentage, no label, and no stage. It is pacing animation in the same
 * category as a skeleton loader: it fills on a curve tuned to how long a scan
 * usually takes, holds short of the end, and is snapped to full by its exit
 * transition when the real result actually lands.
 *
 * Isolated into its own component so its slow-threshold timer re-renders only
 * this bar, not the whole scanner tree (same reason as CaptureGuidance).
 */
export function ScanProgressBar() {
  const [isSlow, setIsSlow] = useState(false);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    const id = setTimeout(() => setIsSlow(true), SLOW_SCAN_MS);
    return () => clearTimeout(id);
  }, []);

  return (
    <div
      className="h-1.5 w-full overflow-hidden rounded-full bg-border"
      // The live region on the scanner page carries the state for assistive
      // tech; the bar itself is decoration and would only add noise.
      aria-hidden="true"
    >
      <motion.div
        className="h-full rounded-full bg-brass"
        initial={{ width: "6%" }}
        animate={
          isSlow && !reduceMotion
            ? { width: `${HOLD_PERCENT}%`, opacity: [1, 0.4, 1] }
            : { width: `${HOLD_PERCENT}%`, opacity: 1 }
        }
        // Snapped shut when the real response arrives. The transition MUST be
        // declared inline here: framer resolves an exit against this component's
        // `transition` prop otherwise, which would hand the exit the 3.5s fill
        // duration below — and because AnimatePresence uses mode="wait", the
        // reveal cannot mount until this exit finishes. That is exactly the
        // stall this constant exists to prevent.
        exit={{
          width: "100%",
          opacity: 1,
          transition: { duration: SCAN_BAR_EXIT_MS / 1000, ease: "easeOut" },
        }}
        transition={{
          width: { duration: TYPICAL_SCAN_MS / 1000, ease: [0.16, 1, 0.3, 1] },
          opacity: isSlow && !reduceMotion
            ? { duration: 1.6, repeat: Infinity, ease: "easeInOut" }
            : { duration: 0.2 },
        }}
      />
    </div>
  );
}
