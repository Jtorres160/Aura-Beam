import type { CandidatePrinting } from "@/lib/scanner/evidence";

const BASE_URL = "https://api.pokemontcg.io/v2/cards";

function getHeaders(): HeadersInit {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

export async function searchPokemonCards(query: string, setCode?: string, collectorNumber?: string) {
  try {
    let searchQuery = `name:"${encodeURIComponent(query)}"`;
    if (setCode) {
      searchQuery += ` (set.id:${encodeURIComponent(setCode)} OR set.ptcgoCode:${encodeURIComponent(setCode)} OR set.name:"*${encodeURIComponent(setCode)}*")`;
    }
    if (collectorNumber) {
      searchQuery += ` number:${encodeURIComponent(collectorNumber)}`;
    }
    
    const response = await fetch(`${BASE_URL}?q=${searchQuery}&pageSize=50`, {
      headers: getHeaders(),
    });

    if (!response.ok) {
      throw new Error(`Pokemon TCG API Error: ${response.status}`);
    }

    const json = await response.json();
    return json.data || [];
  } catch (error) {
    console.error(`Failed to fetch from Pokemon TCG API:`, error);
    return [];
  }
}

/**
 * Direct lookup by set code + collector number — the Pokemon equivalent of the
 * Scryfall set/CN search. Bypasses the OCR'd name entirely, so a hallucinated
 * name can't poison the result; the caller verifies the returned card's name.
 * Matches both the printed ptcgo code ("SV3") and the API set id ("sv3"), and
 * both zero-padded and bare collector numbers ("021" vs "21").
 */
export async function searchPokemonBySetAndNumber(setCode: string, collectorNumber: string) {
  try {
    const num = collectorNumber.split("/")[0].trim();
    const bare = num.replace(/^0+(?=\d)/, "");
    const numberQuery = bare !== num ? `(number:"${num}" OR number:"${bare}")` : `number:"${num}"`;
    const setQuery = `(set.ptcgoCode:"${setCode}" OR set.id:"${setCode.toLowerCase()}")`;
    const response = await fetch(
      `${BASE_URL}?q=${encodeURIComponent(`${numberQuery} ${setQuery}`)}&pageSize=10`,
      { headers: getHeaders() }
    );
    if (!response.ok) return [];
    const json = await response.json();
    return json.data || [];
  } catch (error) {
    console.error(`[Pokemon] Set/number lookup failed for ${setCode} #${collectorNumber}:`, error);
    return [];
  }
}

/**
 * Fetch ALL printings of a Pokemon card name for visual comparison.
 * Returns up to 20 printings including small thumbnail images.
 */
export async function fetchAllPokemonPrintings(name: string): Promise<any[]> {
  try {
    // Use exact name match to avoid getting unrelated cards
    const searchQuery = `name:"${encodeURIComponent(name)}"`;
    const response = await fetch(`${BASE_URL}?q=${searchQuery}&pageSize=50&orderBy=releaseDate`, {
      headers: getHeaders(),
    });
    if (!response.ok) return [];
    const json = await response.json();
    // Filter to only exact name matches, cap at 20
    const exact = (json.data || []).filter((c: any) => c.name.toLowerCase() === name.toLowerCase());
    return exact.slice(0, 20);
  } catch {
    return [];
  }
}

export async function getPokemonCardById(id: string) {
  try {
    const response = await fetch(`${BASE_URL}/${id}`, {
      headers: getHeaders(),
    });
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
