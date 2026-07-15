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
  if (!response.ok) {
    throw new ProviderError("http_error", `Upstream responded ${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new ProviderError("unexpected", "Upstream returned malformed JSON");
  }
}
