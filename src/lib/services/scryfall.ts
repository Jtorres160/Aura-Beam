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
 */
export async function searchScryfallCardByName(query: string, setCode?: string) {
  try {
    let url = `${NAMED_URL}?exact=${encodeURIComponent(query)}`;
    if (setCode) url += `&set=${encodeURIComponent(setCode)}`;

    const exactRes = await fetch(url, { headers: SCRYFALL_HEADERS });
    if (exactRes.ok) {
      const card = await exactRes.json();
      console.log(`[Scryfall] Exact match found: "${card.name}" (Set: ${setCode || 'any'})`);
      return card;
    }

    await delay(100);

    let fuzzyUrl = `${NAMED_URL}?fuzzy=${encodeURIComponent(query)}`;
    if (setCode) fuzzyUrl += `&set=${encodeURIComponent(setCode)}`;
    const fuzzyRes = await fetch(fuzzyUrl, { headers: SCRYFALL_HEADERS });
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
 * Super-accurate fallback: Search by Set Code and Collector Number directly.
 * This ignores the name entirely, bypassing OCR hallucinations.
 */
export async function searchScryfallBySetAndCollector(setCode: string, collectorNumber: string) {
  try {
    const query = `set:${setCode} cn:${collectorNumber}`;
    const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}`, { headers: SCRYFALL_HEADERS });
    
    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.length > 0) {
        console.log(`[Scryfall] Found EXACT match via set/collector: ${json.data[0].name}`);
        return json.data[0];
      }
    }
    return null;
  } catch (error) {
    console.error(`[Scryfall] Set/Collector search failed:`, error);
    return null;
  }
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
  try {
    let queryParts = [];
    
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
      const cleanMana = manaCost.replace(/[^0-9WUBRGX\{\}]/gi, '');
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

    const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released`, { headers: SCRYFALL_HEADERS });
    
    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.length > 0) {
        console.log(`[Scryfall] Deep Semantic Fallback matched ${json.data.length} cards, picking: ${json.data[0].name}`);
        return json.data[0];
      }
    }
    return null;
  } catch (error) {
    console.error(`[Scryfall] Deep Semantic search failed:`, error);
    return null;
  }
}

/**
 * Fallback search: Uses Scryfall's full-text search endpoint.
 */
export async function searchScryfallCards(query: string, setCode?: string, collectorNumber?: string) {
  try {
    let exactQuery = `!"${query}"`;
    if (setCode) exactQuery += ` set:${setCode}`;
    if (collectorNumber) exactQuery += ` cn:${collectorNumber}`;

    const response = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(exactQuery)}&order=released&dir=desc`, { headers: SCRYFALL_HEADERS });
    
    if (response.ok) {
      const json = await response.json();
      if (json.data && json.data.length > 0) {
        console.log(`[Scryfall] Exact search found ${json.data.length} results for "${exactQuery}"`);
        return json.data;
      }
    }

    await delay(100);

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

/**
 * Fetch ALL unique printings of a card by name for visual comparison.
 * Returns printings with their image URLs for the AI to compare.
 */
export async function fetchAllMTGPrintings(name: string): Promise<any[]> {
  try {
    const query = `!"${name}" unique:prints`;
    const res = await fetch(`${SEARCH_URL}?q=${encodeURIComponent(query)}&order=released&dir=desc`, { headers: SCRYFALL_HEADERS });
    if (!res.ok) return [];
    const json = await res.json();
    return json.data || [];
  } catch {
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
    thumbnailUrl: imageUris.small || imageUris.normal || null,
    price: {
      marketPrice: parseFloat(externalCard.prices?.usd || externalCard.prices?.usd_foil || "0"),
      lowPrice: null,
      midPrice: null,
      highPrice: parseFloat(externalCard.prices?.usd_foil || "0") || null,
    }
  };
}
