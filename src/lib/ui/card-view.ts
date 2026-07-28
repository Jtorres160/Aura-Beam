// ─── Card view preference — one rule, one place ─────────────────────────────
// Grid vs list is a per-surface preference that has to survive a reload, and
// the storage layer for it is the part worth pinning down: a stored value is
// untrusted input (another tab, an older build, a user editing devtools), and
// storage itself can throw — Safari private mode and blocked third-party
// storage both reject setItem outright.
//
// The React binding lives in @/hooks/use-card-view. Everything here is pure so
// the parsing and the failure behaviour can be tested without a DOM, and so
// both the collection and search pages read the preference through the SAME
// code rather than each page hand-rolling a localStorage call.

/** How a list of cards is laid out. */
export type CardView = "grid" | "list";

/**
 * Storage keys, namespaced under `aura.` to match the existing preferences
 * written by the scanner (`aura.roiCapture`, `aura.legacyTimedAuto`).
 *
 * Deliberately one key per surface. A binder page of owned cards and a page of
 * search results are read differently — a collector who browses their archive
 * as a grid may still want search as a scannable list — so the two preferences
 * are kept independent rather than fused into a single global setting.
 */
export const CARD_VIEW_KEYS = {
  collection: "aura.collectionView",
  search: "aura.searchView",
} as const;

/**
 * A raw stored value → a view, or null when it tells us nothing.
 *
 * Null means "no preference recorded", which is NOT the same as a preference
 * for the default: callers keep their own fallback and never let a corrupt or
 * absent value silently become a real choice.
 */
export function parseCardView(raw: unknown): CardView | null {
  return raw === "grid" || raw === "list" ? raw : null;
}

/**
 * The subset of the Storage API this module needs. Narrower than `Storage` so
 * tests can pass a plain object, and so nothing here can reach for other
 * storage keys by accident.
 */
export interface CardViewStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read a stored preference. Returns null for absent, unparseable, or
 * unreadable — a preference we cannot read is a preference we do not have, and
 * the caller's default stands.
 */
export function readCardView(
  storage: CardViewStorage | null | undefined,
  key: string,
): CardView | null {
  if (!storage) return null;
  try {
    return parseCardView(storage.getItem(key));
  } catch {
    // Storage access itself can throw when the browser has blocked it.
    return null;
  }
}

/**
 * Persist a preference. Returns whether it stuck, so a caller could surface the
 * difference if it ever mattered; today it never does — a preference that fails
 * to save costs the collector one click next visit, and refusing to change the
 * view over it would be the worse outcome.
 */
export function writeCardView(
  storage: CardViewStorage | null | undefined,
  key: string,
  view: CardView,
): boolean {
  if (!storage) return false;
  try {
    storage.setItem(key, view);
    return true;
  } catch {
    return false;
  }
}
