import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { fetchProviderJson } from "@/lib/providers/http";

const BASE_URL = "https://api.pokemontcg.io/v2/cards";

function getHeaders(): Record<string, string> {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

// Per-request timeout (Phase 5.2.5): a hung upstream must become a classified
// failure, not an indefinitely spinning scan.
//
// Phase 5.13B: the CANDIDATE-generation functions below no longer swallow that
// failure into []. They throw a classified ProviderError, because "the API
// timed out" and "this card does not exist" are different facts and the caller
// is the only layer that can tell a collector which one happened. The comment
// that used to sit here — "callers already treat throws as no result, so an
// AbortError degrades gracefully" — described the bug: degrading a timeout to
// "no result" is exactly how a collector got told their card was not real.
//
// Phase 5.13C: the by-id lookup is now truth-aware TOO. fetchPokemonCardById()
// throws; getPokemonCardById() is the lenient adapter over it, kept for callers
// that genuinely want a null (the card route, price cron, watchlist — where a
// dark sensor should degrade quietly rather than fail a background job).
//
// The leniency is now an explicit ADAPTER rather than a property of the
// transport. 5.13B called those callers' leniency "a separate question"; it is,
// and it still gets the same answer. What changed is that scanner-adjacent
// callers can now ask a different one.

/** Throws ProviderError when the API does not answer. Never returns [] to mean
 *  "I broke" — an empty array here is a real "no cards match". */
export async function searchPokemonCards(query: string, setCode?: string, collectorNumber?: string) {
  let searchQuery = `name:"${query}"`;
  if (setCode) {
    searchQuery += ` (set.id:${setCode} OR set.ptcgoCode:${setCode} OR set.name:"*${setCode}*")`;
  }
  if (collectorNumber) {
    searchQuery += ` number:${collectorNumber}`;
  }

  // The whole q value is encoded ONCE, as a single parameter. The old code
  // encoded the inner text and left the operators raw, which double-encoded any
  // name with a space ("Mr. Mime" went up as "Mr.%20Mime") and only worked at
  // all because fetch re-normalized it.
  const json = await fetchProviderJson<{ data?: any[] }>(
    `${BASE_URL}?q=${encodeURIComponent(searchQuery)}&pageSize=50`,
    { headers: getHeaders() },
  );
  return json?.data ?? [];
}

/**
 * Direct lookup by set code + collector number — the Pokemon equivalent of the
 * Scryfall set/CN search. Bypasses the OCR'd name entirely, so a hallucinated
 * name can't poison the result; the caller verifies the returned card's name.
 * Matches both the printed ptcgo code ("SV3") and the API set id ("sv3"), and
 * both zero-padded and bare collector numbers ("021" vs "21").
 */
export async function searchPokemonBySetAndNumber(setCode: string, collectorNumber: string) {
  const num = collectorNumber.split("/")[0].trim();
  const bare = num.replace(/^0+(?=\d)/, "");
  const numberQuery = bare !== num ? `(number:"${num}" OR number:"${bare}")` : `number:"${num}"`;
  const setQuery = `(set.ptcgoCode:"${setCode}" OR set.id:"${setCode.toLowerCase()}")`;
  const json = await fetchProviderJson<{ data?: any[] }>(
    `${BASE_URL}?q=${encodeURIComponent(`${numberQuery} ${setQuery}`)}&pageSize=10`,
    { headers: getHeaders() },
  );
  return json?.data ?? [];
}

/**
 * Fetch ALL printings of a Pokemon card name for visual comparison.
 * Returns up to 20 printings including small thumbnail images.
 */
export async function fetchAllPokemonPrintings(name: string): Promise<any[]> {
  // Use exact name match to avoid getting unrelated cards
  const json = await fetchProviderJson<{ data?: any[] }>(
    `${BASE_URL}?q=${encodeURIComponent(`name:"${name}"`)}&pageSize=50&orderBy=releaseDate`,
    { headers: getHeaders() },
  );
  // Filter to only exact name matches, cap at 20
  const exact = (json?.data ?? []).filter((c: any) => c.name?.toLowerCase() === name.toLowerCase());
  return exact.slice(0, 20);
}

/**
 * Authoritative by-id lookup. Throws ProviderError when the API does not answer.
 *
 * Note 404 is NOT an empty status here, for the same reason it isn't anywhere
 * else we touch this API: it answers 404 both for a genuine miss and when it is
 * simply unwell. That reading is even safer on this path than on the search
 * path — the id we are asking about came FROM this API minutes ago (the user
 * picked it off a grid it populated), so a 404 for an id it just issued is far
 * more likely illness than absence.
 */
export async function fetchPokemonCardById(id: string) {
  const json = await fetchProviderJson<{ data?: any }>(
    `${BASE_URL}/${encodeURIComponent(id)}`,
    { headers: getHeaders() },
  );
  return json?.data ?? null;
}

/** Lenient adapter: null on ANY failure. Only for callers that would rather
 *  skip a card than know why it's missing (price cron, watchlist, card route). */
export async function getPokemonCardById(id: string) {
  try {
    return await fetchPokemonCardById(id);
  } catch (error) {
    console.error(`Failed to fetch card by ID ${id}:`, error);
    return null;
  }
}

export function formatPokemonCard(externalCard: any): CandidatePrinting {
  return {
    externalId: externalCard.id,
    name: externalCard.name,
    game: "POKEMON",
    setName: externalCard.set?.name || "Unknown Set",
    // ptcgoCode is what's actually printed on the card (e.g. "SV3")
    setCode: externalCard.set?.ptcgoCode || externalCard.set?.id || null,
    // printedTotal is what the card itself says ("/165"); total counts secret
    // rares the printed denominator excludes. Match on what the collector can
    // read off the card in their hand.
    setPrintedSize: typeof externalCard.set?.printedTotal === "number"
      ? externalCard.set.printedTotal
      : null,
    collectorNumber: externalCard.number || null,
    rarity: externalCard.rarity || "Common",
    imageUrl: externalCard.images?.large || externalCard.images?.small || null,
    thumbnailUrl: externalCard.images?.small || null,
    price: {
      marketPrice: externalCard.tcgplayer?.prices?.holofoil?.market ||
                   externalCard.tcgplayer?.prices?.normal?.market ||
                   externalCard.tcgplayer?.prices?.reverseHolofoil?.market || 0
    }
  };
}
