// ─── Vision-call throttle ────────────────────────────────────────────────────
// Every scan fires TWO vision calls (full-card OCR + high-detail bottom strip),
// and in bulk mode those pairs arrive on the same warm instance every few
// seconds. Fired in the same instant they burst OpenAI's per-minute TOKEN limit
// and come back 429 ("please try again in 314ms"). Single scans never trip it
// because the bucket has 60s to refill between one-off pairs.
//
// This gate paces vision calls so the token bucket is never hit by two big
// image calls at once. It is NOT a retry mechanism — the OpenAI SDK still owns
// retries and already honors the server's retry-after timing. This only spaces
// the STARTS so retries rarely need to happen.
//
// Semantics, like the burst limiter in rate-limit.ts, are best-effort
// per-instance: state lives in module memory on the warm Vercel instance. In
// bulk the client serializes captures, so the sequence of scans lands on one
// warm instance — exactly the case this smooths.

/** Never let more than this many vision calls be in flight at once. A hung
 *  call can't pile a backlog on top of itself. */
const VISION_MAX_CONCURRENCY = 2;

/** Minimum spacing between successive vision-call STARTS. Staggers the
 *  full/strip pair (strip starts ~this long after full) and spaces one scan's
 *  calls from the next's, keeping OpenAI's token bucket from seeing two
 *  ~1k-token image calls in the same instant. Comfortably above the sub-second
 *  refill the 429s report, small enough to be invisible at bulk cadence
 *  (~1 scan / 2–3s). */
const VISION_MIN_GAP_MS = 500;

let activeCount = 0;
const waiters: Array<() => void> = [];
/** Wall-clock start already reserved for the most recent acquisition. The next
 *  acquisition reserves max(now, this + gap) — computed with no await in
 *  between, so reservations are atomic on JS's single thread. */
let lastStartAt = 0;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function acquire(): Promise<void> {
  // Concurrency gate: take a slot, or wait for release() to hand one over.
  if (activeCount < VISION_MAX_CONCURRENCY) {
    activeCount++;
  } else {
    await new Promise<void>((resolve) => waiters.push(resolve));
    // release() handed us its slot; activeCount already accounts for it.
  }
  // Spacing gate: reserve this call's start slot, then wait until it arrives.
  const now = Date.now();
  const startAt = Math.max(now, lastStartAt + VISION_MIN_GAP_MS);
  lastStartAt = startAt;
  const wait = startAt - now;
  if (wait > 0) await sleep(wait);
}

function release(): void {
  const next = waiters.shift();
  if (next) next(); // hand the slot directly to the next waiter
  else activeCount--; // nobody waiting — free the slot
}

// ─── 429 recovery (bulk-scan fix) ───────────────────────────────────────────
// In a long bulk session the org-level token bucket can be GENUINELY empty
// (Used 200000/200000) — the SDK's own quick retries all land inside the same
// exhausted minute and the 429 leaked to the collector as "AI vision error".
// The bucket refills at ~3.3k tokens/sec, so the right medicine is a short,
// bounded wait honoring the server's own "try again in Nms" hint, then one
// more attempt — repeated a few times before giving up for real.

/** Total attempts (1 initial + retries). */
const VISION_429_MAX_ATTEMPTS = 4;
/** Never wait longer than this for a single refill, or in total. */
const VISION_429_MAX_WAIT_MS = 4_000;
const VISION_429_TOTAL_WAIT_MS = 10_000;

function is429(err: any): boolean {
  return err?.status === 429 || err?.code === "rate_limit_exceeded";
}

/** The wait the server asked for, parsed from headers or the error message
 *  ("Please try again in 314ms" / "in 1.2s"), else an escalating default. */
function retryDelayMs(err: any, attempt: number): number {
  let hinted: number | null = null;
  const headers = err?.headers;
  const headerVal =
    (typeof headers?.get === "function" ? headers.get("retry-after-ms") : headers?.["retry-after-ms"]) ??
    (typeof headers?.get === "function" ? headers.get("retry-after") : headers?.["retry-after"]);
  if (headerVal != null && !Number.isNaN(Number(headerVal))) {
    const n = Number(headerVal);
    hinted = n < 100 ? n * 1000 : n; // bare seconds vs ms
  }
  if (hinted == null) {
    const m = /try again in ([\d.]+)\s*(ms|s)/i.exec(err?.message ?? "");
    if (m) hinted = m[2].toLowerCase() === "s" ? parseFloat(m[1]) * 1000 : parseFloat(m[1]);
  }
  // Pad the server's hint — other in-flight calls drain the same refill.
  const fallback = 750 * Math.pow(2, attempt - 1);
  return Math.min(Math.max((hinted ?? 0) + 250, fallback), VISION_429_MAX_WAIT_MS);
}

/**
 * Run a single OpenAI vision call under the concurrency + spacing gate. Always
 * releases, even if the call throws, so a failed call can't leak a slot.
 *
 * A 429 releases the slot, waits out the token-bucket refill (bounded), and
 * re-enters the gate for another attempt; any other error rethrows untouched.
 */
export async function throttleVision<T>(fn: () => Promise<T>): Promise<T> {
  let waited = 0;
  for (let attempt = 1; ; attempt++) {
    await acquire();
    let delay: number;
    try {
      return await fn();
    } catch (err: any) {
      delay = retryDelayMs(err, attempt);
      const retryable =
        is429(err) &&
        attempt < VISION_429_MAX_ATTEMPTS &&
        waited + delay <= VISION_429_TOTAL_WAIT_MS;
      if (!retryable) throw err;
      console.warn(
        `[Scanner] Vision 429 — waiting ${delay}ms for the token bucket to refill (attempt ${attempt}/${VISION_429_MAX_ATTEMPTS})`
      );
      waited += delay;
    } finally {
      release();
    }
    // Reached only on the retry path — the finally above has already freed the
    // slot, so this refill pause never blocks the other in-flight call.
    await sleep(delay);
  }
}
