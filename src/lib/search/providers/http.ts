// ─── Provider transport (Phase 5.12A) ───────────────────────────────────────
// The search layer needs something the scanner's service functions deliberately
// do NOT provide: the ability to tell "this source answered, and the answer was
// nothing" apart from "this source never answered".
//
// The existing src/lib/services/* functions catch everything and return []. The
// SCANNER depends on that (a throw there would kill a scan that could still
// succeed from another signal), so those functions are left exactly as they
// are. This module is the search layer's own transport: same upstreams, but
// failures arrive as classified errors instead of empty arrays.
//
// Measured justification for treating this as a first-class case: over one
// audit window the Pokémon API returned 404 on six consecutive identical
// requests and later 504 then 200 on the SAME url. Those are not zero-result
// answers, and collectors must never be told they are.

import type { SourceFailureReason } from "@/lib/search/types";

/** A source failed to answer. Carries a reason the UI is allowed to show.
 *
 *  Written without a TypeScript parameter property on purpose: the test runner
 *  strips types rather than compiling them (see test/alias-loader.mjs), and
 *  strip-only mode rejects parameter properties. A class the tests cannot load
 *  is a class the tests cannot hold to its contract. */
export class SearchProviderError extends Error {
  readonly reason: SourceFailureReason;

  constructor(reason: SourceFailureReason, message: string) {
    super(message);
    this.name = "SearchProviderError";
    this.reason = reason;
  }
}

/** Matches the ceiling already used by the scanner's service layer. */
export const PROVIDER_TIMEOUT_MS = 8_000;

/**
 * Fetch JSON from a card database, converting every non-answer into a
 * classified SearchProviderError.
 *
 * `emptyStatuses` lists status codes that genuinely mean "I looked and found
 * nothing" for that particular API — Scryfall answers 404 for a search with no
 * hits, and YGOPRODeck answers 400. Those are real zero-result answers and
 * resolve to null. Any OTHER non-2xx is a failure.
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
      throw new SearchProviderError("timeout", `No response within ${PROVIDER_TIMEOUT_MS}ms`);
    }
    throw new SearchProviderError("network", err?.message ?? "Network error");
  }

  if (emptyStatuses.includes(response.status)) return null;

  if (response.status === 429) {
    throw new SearchProviderError("rate_limited", "Upstream rate limit reached");
  }
  if (!response.ok) {
    throw new SearchProviderError("http_error", `Upstream responded ${response.status}`);
  }

  try {
    return (await response.json()) as T;
  } catch {
    throw new SearchProviderError("unexpected", "Upstream returned malformed JSON");
  }
}
