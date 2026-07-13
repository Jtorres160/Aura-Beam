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

/**
 * Run a single OpenAI vision call under the concurrency + spacing gate. Always
 * releases, even if the call throws, so a failed call can't leak a slot.
 */
export async function throttleVision<T>(fn: () => Promise<T>): Promise<T> {
  await acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
