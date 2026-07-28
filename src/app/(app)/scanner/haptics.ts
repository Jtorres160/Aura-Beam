/**
 * A single short confirmation tick for successful identification.
 *
 * Deliberately one brief pulse, not a pattern — this is an instrument
 * confirming a reading, not a game rewarding a catch. Skipped entirely when
 * the user has asked for reduced motion, and a no-op wherever the Vibration
 * API is absent (all of desktop, and iOS Safari).
 */
export function confirmationTick() {
  if (typeof window === "undefined") return;
  if (typeof navigator.vibrate !== "function") return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
  navigator.vibrate(12);
}
