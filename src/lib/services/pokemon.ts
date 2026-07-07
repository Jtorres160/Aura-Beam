const BASE_URL = "https://api.pokemontcg.io/v2/cards";

function getHeaders(): HeadersInit {
  const apiKey = process.env.POKEMON_TCG_API_KEY;
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers["X-Api-Key"] = apiKey;
  }
  return headers;
}

export async function searchPokemonCards(query: string) {
  try {
    const searchQuery = `name:"*${encodeURIComponent(query)}*"`;
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
