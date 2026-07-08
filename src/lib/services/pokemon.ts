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

export function formatPokemonCard(externalCard: any) {
  return {
    externalId: externalCard.id,
    name: externalCard.name,
    game: "POKEMON",
    setName: externalCard.set?.name || "Unknown Set",
    rarity: externalCard.rarity || "Common",
    imageUrl: externalCard.images?.large || externalCard.images?.small,
    thumbnailUrl: externalCard.images?.small,
    price: {
      marketPrice: externalCard.tcgplayer?.prices?.holofoil?.market ||
                   externalCard.tcgplayer?.prices?.normal?.market ||
                   externalCard.tcgplayer?.prices?.reverseHolofoil?.market || 0
    }
  };
}
