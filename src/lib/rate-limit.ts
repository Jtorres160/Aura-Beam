// ─── Scan Rate Limiting ─────────────────────────────────────────────────────
// Every scan costs real money (2–3 vision-model calls), so the scan API is
// capped per user at two layers:
//
//   1. BURST (per minute) — in-memory sliding window. Best-effort on
//      serverless: each warm instance keeps its own window, so the effective
//      global limit is (instances × limit). That still stops the runaway
//      client loop and the abusive script, which is the point.
//   2. DAILY — enforced by the caller against ScanHistory (persistent, exact
//      for saved scans). Attempts that end in disambiguation don't count,
//      which errs in the user's favor.
//
// Limits are deliberately generous: bulk mode at one scan every ~3 seconds is
// 20/min, well inside the burst cap. Honest users should never see a 429.

/** Max scan requests per user per minute (burst). */
export const SCAN_BURST_LIMIT = 30;
/** Max SAVED scans per user per day. */
export const SCAN_DAILY_LIMIT = 1000;

const WINDOW_MS = 60_000;
/** Entry cap so the map can't grow unbounded on a long-lived instance. */
const MAX_TRACKED_USERS = 10_000;

const windows = new Map<string, number[]>();

/**
 * Record a scan attempt and report whether the user is within the burst
 * limit. Denied attempts are not recorded, so a throttled user recovers as
 * soon as their window drains.
 */
export function checkScanBurst(userId: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
  const now = Date.now();
  const recent = (windows.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= SCAN_BURST_LIMIT) {
    windows.set(userId, recent);
    const retryAfterSeconds = Math.max(1, Math.ceil((recent[0] + WINDOW_MS - now) / 1000));
    return { ok: false, retryAfterSeconds };
  }

  recent.push(now);
  windows.set(userId, recent);

  // Opportunistic pruning: drop fully-drained windows once the map gets large.
  if (windows.size > MAX_TRACKED_USERS) {
    for (const [key, times] of windows) {
      if (times.every((t) => now - t >= WINDOW_MS)) windows.delete(key);
    }
  }

  return { ok: true };
}

/** Start of the current UTC day — the boundary the daily cap counts within. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
