import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { fetchProviderJson } from "@/lib/providers/http";

const SEARCH_URL = "https://api.scryfall.com/cards/search";
const NAMED_URL = "https://api.scryfall.com/cards/named";

const SCRYFALL_HEADERS = {
  "User-Agent": "AuraBeam/1.0",
  "Accept": "application/json"
};

// Per-request timeout (Phase 5.2.5): a hung upstream must become a classified
// "candidates" failure, not an indefinitely spinning scan.
//
// Phase 5.13B: the CANDIDATE-generation functions below throw a classified
// ProviderError rather than swallowing a failure into null/[]. Scryfall answers
// 404 for a search that genuinely matched nothing, so 404 — and ONLY 404 —
// resolves to a real zero here.
//
// Phase 5.13C: the by-id lookup is truth-aware too — fetchScryfallCardById()
// throws, and getScryfallCardById() is the lenient adapter over it for callers
// (card route, price cron) that genuinely want a null.
//
// Every function in this file now goes through fetchProviderJson. The last raw
// fetch() lived in searchScryfallCards(), which 5.13C deleted: it had no callers
// and ended in `catch { return [] }` — the precise pattern the truth layer
// exists to forbid, sitting in the file a future engineer would copy from.
// Truth layers fail when the old escape hatches are left on the shelf.

// Scryfall requests 50-100ms delay between requests to avoid blacklisting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Primary search: Uses Scryfall's "named" endpoint for exact/fuzzy single-card lookup.
 */
export async function searchScryfallCardByName(query: string, setCode?: string) {
  let url = `${NAMED_URL}?exact=${encodeURIComponent(query)}`;
  if (setCode) url += `&set=${encodeURIComponent(setCode)}`;

  // 404 from /named means "no card by that name" — a real answer.
  const exact = await fetchProviderJson<any>(url, {
    headers: SCRYFALL_HEADERS,
    emptyStatuses: [404],
  });
  if (exact) {
    console.log(`[Scryfall] Exact match found: "${exact.name}" (Set: ${setCode || 'any'})`);
    return exact;
  }

  await delay(100);

  let fuzzyUrl = `${NAMED_URL}?fuzzy=${encodeURIComponent(query)}`;
  if (setCode) fuzzyUrl += `&set=${encodeURIComponent(setCode)}`;
  // 400 too: /named answers 400 when a fuzzy term matches too many cards to
  // disambiguate. That is an answer ("your term is ambiguous"), not a failure.
  const fuzzy = await fetchProviderJson<any>(fuzzyUrl, {
    headers: SCRYFALL_HEADERS,
    emptyStatuses: [404, 400],
  });
  if (fuzzy) {
    console.log(`[Scryfall] Fuzzy match found: "${fuzzy.name}"`);
    return fuzzy;
  }

  console.log(`[Scryfall] No named match for "${query}"`);
  return null;
}

/**
 * Super-accurate fallback: Search by Set Code and Collector Number directly.
 * This ignores the name entirely, bypassing OCR hallucinations.
 */
export async function searchScryfallBySetAndCollector(setCode: string, collectorNumber: string) {
  const query = `set:${setCode} cn:${collectorNumber}`;
  const json = await fetchProviderJson<{ data?: any[] }>(
    `${SEARCH_URL}?q=${encodeURIComponent(query)}`,
    { headers: SCRYFALL_HEADERS, emptyStatuses: [404] },
  );
  const hit = json?.data?.[0];
  if (hit) console.log(`[Scryfall] Found EXACT match via set/collector: ${hit.name}`);
  return hit ?? null;
}

/**
 * Deep Semantic Fallback: Search by combining partial name and physical attributes.
 * This is used when the name is misread but the AI extracts the mechanics.
 */
export async function searchScryfallDeepFallback(
  partialName: string,
  manaCost: string,
  typeLine: string,
  powerToughness: string,
  setCode: string
) {
  const queryParts = [];

  // Scryfall's exact text search requires exact words, so if the name is completely
  // hallucinated we might still miss. But we try to use the first word if it looks real,
  // or just pass the whole partial name in quotes.
  if (partialName && partialName.length > 2) {
    // Just use the first longest word to be safe against hallucinations
    const longestWord = partialName.split(' ').reduce((a, b) => a.length > b.length ? a : b, "");
    if (longestWord.length >= 3) {
      queryParts.push(`"${longestWord}"`);
    } else {
      queryParts.push(`"${partialName}"`);
    }
  }

  if (setCode) queryParts.push(`set:${setCode}`);

  // Type line (e.g. "Creature - Goblin" -> t:Creature t:Goblin)
  if (typeLine) {
    const types = typeLine.split(/[\s\-—]+/).filter(t => t.length > 2);
    for (const t of types) {
      queryParts.push(`t:"${t}"`);
    }
  }

  // Mana cost (e.g. "{3}" or "3")
  if (manaCost) {
    // Clean it up just in case, but scryfall accepts m:3 or m:{3}
    const cleanMana = manaCost.replace(/[^0-9WUBRGX{}]/gi, '');
    if (cleanMana) queryParts.push(`m:${cleanMana}`);
  }

  // Power and Toughness (e.g. "2/2")
  if (powerToughness && powerToughness.includes('/')) {
    const [pow, tou] = powerToughness.split('/');
    if (pow && pow.trim() !== "*") queryParts.push(`pow:${pow.trim()}`);
    if (tou && tou.trim() !== "*") queryParts.push(`tou:${tou.trim()}`);
  }

  const query = queryParts.join(' ');
  console.log(`[Scryfall] Deep Semantic Fallback Query: "${query}"`);

  const json = await fetchProviderJson<{ data?: any[] }>(
    `${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released`,
    { headers: SCRYFALL_HEADERS, emptyStatuses: [404] },
  );
  const hit = json?.data?.[0];
  if (hit) {
    console.log(`[Scryfall] Deep Semantic Fallback matched ${json!.data!.length} cards, picking: ${hit.name}`);
  }
  return hit ?? null;
}

/**
 * Fetch ALL unique printings of a card by name for visual comparison.
 * Returns printings with their image URLs for the AI to compare.
 */
export async function fetchAllMTGPrintings(name: string): Promise<any[]> {
  const query = `!"${name}" unique:prints`;
  const json = await fetchProviderJson<{ data?: any[] }>(
    `${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released&dir=desc`,
    { headers: SCRYFALL_HEADERS, emptyStatuses: [404] },
  );
  return json?.data ?? [];
}

/**
 * Authoritative by-id lookup. Throws ProviderError when Scryfall does not
 * answer. Unlike the Pokémon API, Scryfall's 404 on /cards/{id} is a real
 * answer — "no card has this id" — so it resolves to null, not a failure.
 */
export async function fetchScryfallCardById(id: string) {
  return await fetchProviderJson<any>(
    `https://api.scryfall.com/cards/${encodeURIComponent(id)}`,
    { headers: SCRYFALL_HEADERS, emptyStatuses: [404] },
  );
}

/** Lenient adapter: null on ANY failure. Only for callers that would rather
 *  skip a card than know why it's missing (price cron, card route). */
export async function getScryfallCardById(id: string) {
  try {
    return await fetchScryfallCardById(id);
  } catch (error) {
    console.error(`Failed to fetch Scryfall card by ID ${id}:`, error);
    return null;
  }
}

export function formatScryfallCard(externalCard: any): CandidatePrinting {
  // Double-faced cards keep images and illustration on the faces
  const front = externalCard.card_faces?.[0] || {};
  const imageUris = externalCard.image_uris || front.image_uris || {};

  return {
    externalId: externalCard.id,
    name: externalCard.name,
    game: "MTG",
    setName: externalCard.set_name || "Unknown Set",
    setCode: externalCard.set || undefined,
    collectorNumber: externalCard.collector_number || undefined,
    rarity: externalCard.rarity || "Common",
    imageUrl: imageUris.large || imageUris.normal || imageUris.png || null,
    thumbnailUrl: imageUris.small || imageUris.normal || null,
    price: {
      marketPrice: parseFloat(externalCard.prices?.usd || externalCard.prices?.usd_foil || "0"),
      lowPrice: null,
      midPrice: null,
      highPrice: parseFloat(externalCard.prices?.usd_foil || "0") || null,
    },
    // Printing evidence — same illustrationId means identical artwork, so the
    // decision layer forbids artwork-based disambiguation between them.
    oracleId: externalCard.oracle_id || null,
    illustrationId: externalCard.illustration_id || front.illustration_id || null,
    frame: externalCard.frame || null,
    borderColor: externalCard.border_color || null,
    finishes: externalCard.finishes || [],
    promoTypes: externalCard.promo_types || [],
    lang: externalCard.lang || null,
  };
}
