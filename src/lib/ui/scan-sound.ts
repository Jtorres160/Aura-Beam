// ─── Scan sound preference — one rule, one place ────────────────────────────
// Whether a successful identification makes a noise. Same shape as
// @/lib/ui/card-view: pure so it can be tested without a DOM, and treating a
// stored value as untrusted input (another tab, an older build, devtools) and
// storage itself as something that can throw — Safari private mode and blocked
// third-party storage both reject setItem outright.
//
// The React binding lives in @/hooks/use-scan-sound; the audio engine that
// actually makes the sound is @/lib/audio/scan-chime. Kept separate so the
// preference can be reasoned about without pulling in WebAudio.

/** Whether the success chime plays. */
export type ScanSound = "on" | "off";

/**
 * Namespaced under `aura.` to match the preferences already written by the
 * scanner (`aura.roiCapture`, `aura.legacyTimedAuto`) and the card views
 * (`aura.collectionView`, `aura.searchView`).
 */
export const SCAN_SOUND_KEY = "aura.scanSound";

/**
 * Default for a collector who has never expressed a preference.
 *
 * ON: the chime is the point of this feature, and a muted-by-default reward is
 * a reward nobody discovers. It is one short quiet tone, gated behind an
 * explicit "Open Camera" tap, and switched off from a control on the same
 * screen — so the cost of guessing wrong is one click, once.
 */
export const SCAN_SOUND_DEFAULT: ScanSound = "on";

/**
 * A raw stored value → a preference, or null when it tells us nothing.
 *
 * Null means "no preference recorded", which is NOT the same as a preference
 * for the default: callers keep their own fallback and never let a corrupt or
 * absent value silently become a real choice.
 */
export function parseScanSound(raw: unknown): ScanSound | null {
  return raw === "on" || raw === "off" ? raw : null;
}

/**
 * The subset of the Storage API this module needs — narrow so tests can pass a
 * plain object, and so nothing here can reach other keys by accident.
 */
export interface ScanSoundStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the stored preference. Null for absent, unparseable, or unreadable — a
 * preference we cannot read is a preference we do not have.
 */
export function readScanSound(
  storage: ScanSoundStorage | null | undefined,
): ScanSound | null {
  if (!storage) return null;
  try {
    return parseScanSound(storage.getItem(SCAN_SOUND_KEY));
  } catch {
    return null;
  }
}

/**
 * Persist the preference. Returns whether it stuck. A failed write costs the
 * collector one click next visit, which beats refusing to toggle at all.
 */
export function writeScanSound(
  storage: ScanSoundStorage | null | undefined,
  value: ScanSound,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(SCAN_SOUND_KEY, value);
    return true;
  } catch {
    return false;
  }
}
