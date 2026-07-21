// ─── Provider transport (Phase 5.13B) ───────────────────────────────────────
// One transport for every card database Aura consults, shared by BOTH consumers:
//
//     search  → CardSearchService  → SearchOutcome
//     scanner → fetchAllPrintings  → CandidateOutcome
//
// It answers exactly one question honestly: did this source ANSWER, or not?
//
//     returns   a value or null   the source answered ("null" = a real zero)
//     throws    ProviderError     the source did not answer
//
// It never returns [] to mean "I broke". That collapse is the bug this whole
// module exists to make unrepresentable, and it has now been found twice: once
// in search (Phase 5.12A) and once in the scanner's candidate layer (5.13B),
// where a Pokémon timeout was reported to collectors as "no match was found in
// any card database" — a card database asserting the non-existence of a card it
// never managed to look up.
//
// This lived in src/lib/search/providers/http.ts until 5.13B. It was moved here
// verbatim, not rewritten, when the scanner turned out to need the same rule —
// two transports would eventually disagree about what a 404 means, and that
// disagreement would surface as one of them lying to a collector.
//
// Measured justification: over one audit window the Pokémon API returned 404 on
// six consecutive identical requests and later 504 then 200 on the SAME url.
// Phase 5.13 measured it again — median 1785ms against Scryfall's 47ms, with
// hangs past 25s. Those are not zero-result answers.

/**
 * Why a source produced no reading. Kept coarse and closed: this reaches
 * collectors, so it must be truthful and finite — never a raw upstream string.
 */
export type ProviderFailureReason =
  | "timeout"        // upstream exceeded our per-request ceiling
  | "rate_limited"   // upstream refused us (429)
  | "bad_query"      // upstream rejected OUR question as malformed (400)
  | "http_error"     // upstream answered, but not with an answer
  | "network"        // we never reached it
  | "not_configured" // we lack the credentials to ask
  | "unexpected";    // anything else — still a failure, never a zero

/** A source failed to answer. Carries a reason the UI is allowed to show.
 *
 *  Written without a TypeScript parameter property on purpose: the test runner
 *  strips types rather than compiling them (see test/alias-loader.mjs), and
 *  strip-only mode rejects parameter properties. A class the tests cannot load
 *  is a class the tests cannot hold to its contract. */
export class ProviderError extends Error {
  readonly reason: ProviderFailureReason;

  constructor(reason: ProviderFailureReason, message: string) {
    super(message);
    this.name = "ProviderError";
    this.reason = reason;
  }
}

/** The per-request ceiling for every card database.
 *
 *  Phase 5.13 note: the Pokémon API is measurably slower than this ceiling some
 *  of the time (hangs past 25s observed). That is not a reason to raise it — a
 *  scan that hangs for 25s is worse than one that says "I couldn't check". It IS
 *  the reason the timeout must surface as unavailable evidence rather than as an
 *  empty result, which is what 5.13B fixes. */
export const PROVIDER_TIMEOUT_MS = 8_000;

// ─── Transient-failure retry (Phase 5.19) ────────────────────────────────────
// The Pokémon TCG API fails INDIVIDUAL requests at a high rate while staying
// broadly reachable: a measured burst returned HTTP 500 on ~half of identical
// requests, with 200s interleaved seconds apart on the same URL. That is not an
// outage the truth layer should surface to a collector on every scan — it is
// per-request flakiness that a retry within one scan almost always rides out.
//
// The rule this adds sits UNDER the truth layer, not beside it: a request that
// never got a real answer is retried; a request that DID answer — including a
// clean zero — is not. So this only ever converts "we couldn't ask" into "we
// asked and here's the answer". It can never turn a real "not found" into a
// retry, because a real answer isn't a failure and never enters the loop.
//
// Latency is bounded two ways at once, because the two failure shapes are
// different: fast 500s (~140ms) let many attempts fit under the budget, and a
// true 8s hang consumes ~half the budget on its own so it never stacks more than
// two. A healthy request returns on the first attempt and pays nothing.
//
// Attempt count set by MEASUREMENT, not guesswork. A 9.5-minute soak against the
// live API during a 42%-per-request-failure window (225 HTTP-500s + 2 timeouts
// of 541 requests) showed:
//
//     no retry (1 attempt):   42% of scans fail   ← what the demo hit
//     5 attempts:            ~2% of scans fail     (0.45^5 ≈ 1.8%, confirmed)
//     8 attempts:          ~0.2% of scans fail     (0.45^8 ≈ 0.17%)
//
// 2% is ~1-in-50 — still a coin-flip chance of one failure across a 20-card demo.
// 8 attempts takes that demo-session risk from ~33% to ~3%. The cost is paid only
// on the tail: a scan that would have FAILED now takes up to ~6.5s and succeeds,
// while healthy scans are untouched (p50 stayed ~700ms in the soak).

/** Failure reasons worth retrying: the source didn't give us a real answer.
 *  bad_query (our malformed question), not_configured (missing creds) and
 *  unexpected (deterministic malformed JSON) are excluded — a retry re-sends the
 *  same doomed request. */
const RETRYABLE_REASONS: ReadonlySet<ProviderFailureReason> = new Set([
  "timeout",
  "http_error",
  "network",
  "rate_limited",
]);

/** Total attempts including the first. 8 attempts against ~45% per-request
 *  failure leaves ~0.45^8 ≈ 0.17% residual (measured ~0.2% in a live soak). For
 *  fast 500s this ceiling — not the budget — is the binding limit. */
const RETRY_MAX_ATTEMPTS = 8;

/** Wall-clock ceiling for all attempts of one request. Two per-request timeouts
 *  wide: a single 8s hang no longer exhausts the whole budget (the demo's one
 *  timeout-shaped failure did), so a hung request still earns a second full try,
 *  while a run of genuine hangs is still capped at ~16s rather than stacking
 *  unbounded. Fast failures never approach it — 8 of them fit in ~6.5s. */
const RETRY_BUDGET_MS = 2 * PROVIDER_TIMEOUT_MS;

/** Base backoff; the delay grows 200 → 400 → 800 → 1000(cap) with jitter.
 *  Read from env so the test harness can zero it out (see test/register.mjs). */
const RETRY_BASE_MS = Number(process.env.PROVIDER_RETRY_BASE_MS ?? 200);

function backoffDelay(attempt: number): number {
  if (RETRY_BASE_MS <= 0) return 0;
  const exp = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), 1_000);
  // Jitter decorrelates the concurrent calls a scan fires at one source, so a
  // bad instant doesn't retry them all in lockstep into the same bad instant.
  return exp + Math.floor(Math.random() * RETRY_BASE_MS);
}

/**
 * Fetch JSON from a card database, converting every non-answer into a
 * classified ProviderError.
 *
 * `emptyStatuses` lists status codes that genuinely mean "I looked and found
 * nothing" for that particular API — Scryfall answers 404 for a search with no
 * hits, and YGOPRODeck answers 400. Those are real zero-result answers and
 * resolve to null. Any OTHER non-2xx is a failure.
 *
 * Note what is NOT in that list for the Pokémon API: 404. It answers 404 both
 * for a well-formed query that matched nothing AND when it is simply unwell, so
 * reading 404 as zero there would reintroduce the exact lie this module
 * prevents. When a source cannot distinguish its own zero from its own illness,
 * the honest reading is "it did not answer".
 */
export async function fetchProviderJson<T = any>(
  url: string,
  opts: { headers?: Record<string, string>; emptyStatuses?: number[] } = {},
): Promise<T | null> {
  const startedAt = Date.now();
  let lastError: ProviderError | undefined;

  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    try {
      // A real answer — a value OR a null from an emptyStatus — returns straight
      // through. Only a ProviderError (the source did not answer) reaches catch.
      return await fetchProviderJsonOnce<T>(url, opts);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      lastError = err;

      const budgetLeft = RETRY_BUDGET_MS - (Date.now() - startedAt);
      const retryable = RETRYABLE_REASONS.has(err.reason);
      const hasAttemptsLeft = attempt < RETRY_MAX_ATTEMPTS;
      // Stop if it's not worth retrying, we're out of tries, or the budget can't
      // even fit a backoff. Throwing the LAST error preserves its reason for the
      // truth layer, so a card is still never called "not found" on a failure.
      if (!retryable || !hasAttemptsLeft || budgetLeft <= 0) throw err;

      const delay = Math.min(backoffDelay(attempt), budgetLeft);
      console.warn(
        `[Provider] ${err.reason} on attempt ${attempt}/${RETRY_MAX_ATTEMPTS} — retrying in ${delay}ms: ${url}`,
      );
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    }
  }

  // Unreachable: the loop either returns an answer or throws lastError above.
  throw lastError ?? new ProviderError("unexpected", "Retry loop exited without a result");
}

/** One attempt: fetch + classify. Throws ProviderError on any non-answer; the
 *  retry wrapper above decides whether that failure is worth another try. */
async function fetchProviderJsonOnce<T = any>(
  url: string,
  opts: { headers?: Record<string, string>; emptyStatuses?: number[] } = {},
): Promise<T | null> {
  const { headers, emptyStatuses = [] } = opts;

  let response: Response;
  try {
    response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(PROVIDER_TIMEOUT_MS),
    });
  } catch (err: any) {
    // AbortSignal.timeout rejects with a TimeoutError DOMException.
    const name = err?.name ?? "";
    if (name === "TimeoutError" || name === "AbortError") {
      throw new ProviderError("timeout", `No response within ${PROVIDER_TIMEOUT_MS}ms`);
    }
    throw new ProviderError("network", err?.message ?? "Network error");
  }

  if (emptyStatuses.includes(response.status)) return null;

  if (response.status === 429) {
    throw new ProviderError("rate_limited", "Upstream rate limit reached");
  }
  // ─── 400: OUR bug, not theirs (Phase 5.13C) ───────────────────────────────
  // Several of these queries are built out of raw OCR text — Scryfall syntax
  // like `set:MH2 cn:267` or `t:"Creature"`. A stray quote or bracket from a
  // misread strip produces a query the API is right to reject. The source is
  // healthy; the question was malformed.
  //
  // It is still a FAILURE, and deliberately so: a question that was never
  // validly asked has not established that the card is absent, so this must
  // never resolve to a zero. Reading it as "no such card" would be a false
  // negative manufactured out of our own OCR noise — the same lie as a timeout
  // becoming "not found", just with a more embarrassing cause.
  //
  // What the distinct reason buys is TELEMETRY: bad_query separates "we are
  // generating garbage queries" (an OCR/extraction problem, fixable by us) from
  // "the provider is down" (not). Folded into http_error, an extraction
  // regression would read as an upstream outage and be chased in the wrong
  // codebase entirely.
  //
  // Note this is only reached when 400 is NOT in emptyStatuses. Where 400 is a
  // real answer — YGOPRODeck's "no card by that name", Scryfall /named's "your
  // fuzzy term is ambiguous" — the caller lists it and it returns null above.
  if (response.status === 400) {
    throw new ProviderError("bad_query", "Upstream rejected the query as malformed");
  }
  if (!response.ok) {
    throw new ProviderError("http_error", `Upstream responded ${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("unexpected", "Upstream returned malformed JSON");
  }
}
