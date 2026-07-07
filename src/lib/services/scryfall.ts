const SEARCH_URL = "https://api.scryfall.com/cards/search";
const NAMED_URL = "https://api.scryfall.com/cards/named";

const SCRYFALL_HEADERS = {
  "User-Agent": "AuraBeam/1.0",
  "Accept": "application/json"
};

// Scryfall requests 50-100ms delay between requests to avoid blacklisting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Primary search: Uses Scryfall's "named" endpoint for exact/fuzzy single-card lookup.
 * This is the most reliable way to find a card by name.
 */
export async function searchScryfallCardByName(query: string) {
  try {
    // Try exact match first
    const exactRes = await fetch(`${NAMED_URL}?exact=${encodeURIComponent(query)}`, { headers: SCRYFALL_HEADERS });
    if (exactRes.ok) {
      const card = await exactRes.json();
      console.log(`[Scryfall] Exact match found: "${card.name}"`);
      return card;
    }

    // Rate limit delay before next request
    await delay(100);

    // Fall back to fuzzy match (handles minor typos/variations)
    const fuzzyRes = await fetch(`${NAMED_URL}?fuzzy=${encodeURIComponent(query)}`, { headers: SCRYFALL_HEADERS });
    if (fuzzyRes.ok) {
      const card = await fuzzyRes.json();
      console.log(`[Scryfall] Fuzzy match found: "${card.name}"`);
      return card;
    }

    console.log(`[Scryfall] No named match for "${query}"`);
    return null;
  } catch (error) {
    console.error(`[Scryfall] Named lookup failed for "${query}":`, error);
    return null;
  }
}

/**
 * Fallback search: Uses Scryfall's full-text search endpoint.
 * Returns an array of results. Less precise but catches edge cases.
 */
export async function searchScryfallCards(query: string) {
  try {
    // Use exact name search syntax first
    const exactQuery = `!"${query}"`;
    const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(exactQuery)}&order=released&dir=desc`, { headers: SCRYFALL_HEADERS });
    
    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.length > 0) {
        console.log(`[Scryfall] Exact search found ${json.data.length} results for "${query}"`);
        return json.data;
      }
    }

    // Rate limit delay before next request
    await delay(100);

    // If exact fails, try a broader search
    const broadResponse = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released&dir=desc`, { headers: SCRYFALL_HEADERS });
    
    if (!broadResponse.ok) {
      if (broadResponse.status === 404) {
        console.log(`[Scryfall] No results found for "${query}"`);
        return [];
      }
      throw new Error(`Scryfall API Error: ${broadResponse.status}`);
    }

    const json = await broadResponse.json();
    console.log(`[Scryfall] Broad search found ${json.data?.length || 0} results for "${query}"`);
    return json.data || [];
  } catch (error) {
    console.error(`[Scryfall] Search failed for "${query}":`, error);
    return [];
  }
}

export async function getScryfallCardById(id: string) {
  try {
    const response = await fetch(`https://api.scryfall.com/cards/${encodeURIComponent(id)}`, { headers: SCRYFALL_HEADERS });
    if (!response.ok) return null;
    const json = await response.json();
    return json;
  } catch (error) {
    console.error(`Failed to fetch Scryfall card by ID ${id}:`, error);
    return null;
  }
}

export function formatScryfallCard(externalCard: any) {
  // Handle double-faced cards which have image_uris on the card_faces array
  const imageUris = externalCard.image_uris || externalCard.card_faces?.[0]?.image_uris || {};
  
  return {
    externalId: externalCard.id,
    name: externalCard.name,
    game: "MTG",
    setName: externalCard.set_name || "Unknown Set",
    setCode: externalCard.set || undefined,
    collectorNumber: externalCard.collector_number || undefined,
    rarity: externalCard.rarity || "Common",
    imageUrl: imageUris.large || imageUris.normal || imageUris.png || null,
    thumbnailUrl: imageUris.normal || imageUris.small || null,
    price: {
      marketPrice: parseFloat(externalCard.prices?.usd || externalCard.prices?.usd_foil || "0"),
      lowPrice: null,
      midPrice: null,
      highPrice: parseFloat(externalCard.prices?.usd_foil || "0") || null,
    }
  };
}
