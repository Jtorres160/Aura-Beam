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
// getPokemonCardById() below is deliberately NOT changed: its callers (the card
// route, price cron, watchlist) want a lenient null. Their leniency is a
// separate question from candidate generation's.
const fetchOpts = (): RequestInit => ({
  headers: getHeaders(),
  signal: AbortSignal.timeout(8_000),
});

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

export async function getPokemonCardById(id: string) {
  try {
    const response = await fetch(`${BASE_URL}/${id}`, fetchOpts());
    if (!response.ok) return null;
    const json = await response.json();
    return json.data;
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
