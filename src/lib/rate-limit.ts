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

/**
 * Max capture-rejection reports per user per minute (Phase 5.14.3).
 *
 * Set deliberately ABOVE what the capture machine can physically emit: a
 * rejection needs a readiness dwell (500ms) plus a cooldown (1200ms), capping
 * an honest client near ~35/min. So this is an ABUSE guard on a
 * write-per-request endpoint, not a sampler — which matters for honesty, not
 * just cost. If this limit trimmed real traffic, the stored rejection counts
 * would silently become a SAMPLE while still reading like a total, and a
 * throttled measurement presented as a complete one is a fabricated number.
 * Dropped reports are simply unmeasured; they are never estimated back.
 */
export const CAPTURE_REPORT_BURST_LIMIT = 60;

const WINDOW_MS = 60_000;
/** Entry cap so the map can't grow unbounded on a long-lived instance. */
const MAX_TRACKED_USERS = 10_000;

export type BurstVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Each limiter gets its OWN window map: a user's capture reports must never
 *  consume their scan allowance, or a noisy camera would throttle scanning. */
const scanWindows = new Map<string, number[]>();
const captureReportWindows = new Map<string, number[]>();

/**
 * Shared sliding-window check. Denied attempts are not recorded, so a
 * throttled user recovers as soon as their window drains.
 */
function checkBurst(windows: Map<string, number[]>, userId: string, limit: number): BurstVerdict {
  const now = Date.now();
  const recent = (windows.get(userId) ?? []).filter((t) => now - t < WINDOW_MS);

  if (recent.length >= limit) {
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

/**
 * Record a scan attempt and report whether the user is within the burst limit.
 */
export function checkScanBurst(userId: string): BurstVerdict {
  return checkBurst(scanWindows, userId, SCAN_BURST_LIMIT);
}

/**
 * Record a capture-rejection report and report whether the user is within the
 * burst limit (Phase 5.14.3). See CAPTURE_REPORT_BURST_LIMIT: this guards a
 * write-per-request telemetry endpoint against abuse and is set high enough
 * that real capture traffic never reaches it.
 */
export function checkCaptureReportBurst(userId: string): BurstVerdict {
  return checkBurst(captureReportWindows, userId, CAPTURE_REPORT_BURST_LIMIT);
}

/** Start of the current UTC day — the boundary the daily cap counts within. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
