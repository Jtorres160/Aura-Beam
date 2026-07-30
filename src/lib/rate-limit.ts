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
/**
 * Max SAVED scans per user per day.
 *
 * Sized for the tester window: 1000 was a runaway guard for a single-owner
 * world, not a cost ceiling. With multiple concurrent testers the per-user cap
 * has to be small enough that the worst case is affordable, while staying well
 * above what an honest session reaches (a long bulk run is tens of cards, not
 * hundreds).
 */
export const SCAN_DAILY_LIMIT = 100;

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

/**
 * Max scan-feedback reports per user per minute.
 *
 * Low, because this endpoint is human-paced: filing a report means opening a
 * form, picking a category and typing. Ten a minute is far more than a person
 * reporting real problems will ever send, and it caps what a session can push
 * into a free-text column. Unlike the capture limit above, a throttled report
 * here is never a lost measurement — the collector is told it was not received
 * and can retry.
 */
export const FEEDBACK_BURST_LIMIT = 10;

/**
 * Max contact-form submissions per client per minute.
 *
 * Three, because this is the slowest human action in the app: typing a name, an
 * email and a paragraph. Anything sending more than three a minute is not a
 * person with three things to say.
 *
 * ─── THIS ONE IS KEYED ON AN IP, NOT A USER ─────────────────────────────────
 *
 * Every other limiter here keys on a session-verified userId. The contact form
 * is public by design — someone who cannot log in is exactly who needs it — so
 * the only available key is the client address. Two honest consequences:
 *
 *   1. It is WEAKER. An address can be spoofed upstream of us and rotated
 *      freely, so this raises the cost of casual spam; it does not stop a
 *      determined sender. It is not a substitute for a real anti-abuse control.
 *   2. It is COARSER. Visitors behind one NAT or corporate proxy share a key,
 *      which is why the limit is per minute and not per hour — a shared address
 *      drains its window quickly rather than locking a building out for an hour.
 *
 * Combined with the per-instance in-memory caveat at the top of this file, treat
 * this as a speed bump that is honestly described rather than a guarantee.
 */
export const CONTACT_BURST_LIMIT = 3;

const WINDOW_MS = 60_000;
/** Entry cap so the map can't grow unbounded on a long-lived instance. */
const MAX_TRACKED_USERS = 10_000;

export type BurstVerdict = { ok: true } | { ok: false; retryAfterSeconds: number };

/** Each limiter gets its OWN window map: a user's capture reports must never
 *  consume their scan allowance, or a noisy camera would throttle scanning. */
const scanWindows = new Map<string, number[]>();
const captureReportWindows = new Map<string, number[]>();
const feedbackWindows = new Map<string, number[]>();
const contactWindows = new Map<string, number[]>();

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

/**
 * Record a scan-feedback report and report whether the user is within the burst
 * limit. Its own window: filing a report must never consume scan allowance.
 */
export function checkFeedbackBurst(userId: string): BurstVerdict {
  return checkBurst(feedbackWindows, userId, FEEDBACK_BURST_LIMIT);
}

/**
 * Record a contact-form submission and report whether the client is within the
 * burst limit. `clientKey` is an IP (or the "unknown" bucket) rather than a
 * userId — see CONTACT_BURST_LIMIT for what that costs.
 */
export function checkContactBurst(clientKey: string): BurstVerdict {
  return checkBurst(contactWindows, clientKey, CONTACT_BURST_LIMIT);
}

/**
 * Best-effort client address for the public contact endpoint.
 *
 * `x-forwarded-for` is set by Vercel's edge and is the address to use in
 * production; it is a client-controllable header anywhere that does not
 * overwrite it, which is the second half of why the contact limiter is a speed
 * bump rather than a control.
 *
 * When no header is present (local dev, an unusual proxy) every such request
 * shares the single "unknown" bucket. That is deliberately the STRICTEST
 * outcome, not a bypass: an unidentifiable client must not get a free pass by
 * being unidentifiable.
 */
export function clientKeyFromHeaders(headers: Headers): string {
  // First entry is the original client; the rest are proxies that appended
  // themselves. Any of them can be forged, so this is a key, not an identity.
  const forwarded = headers.get("x-forwarded-for");
  const first = forwarded?.split(",")[0]?.trim();
  if (first) return first;
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  return "unknown";
}

/** Start of the current UTC day — the boundary the daily cap counts within. */
export function startOfUtcDay(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}
