const BASE_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

export async function searchYugiohCards(query: string, setCode?: string) {
  try {
    // Try exact name first
    const exactRes = await fetch(`${BASE_URL}?name=${encodeURIComponent(query)}`);
    if (exactRes.ok) {
      const json = await exactRes.json();
      if (json.data && json.data.length > 0) {
        console.log(`[Yugioh] Exact match found for "${query}"`);
        return json.data;
      }
    }

    // Fall back to fuzzy name search
    const fuzzyRes = await fetch(`${BASE_URL}?fname=${encodeURIComponent(query)}`);
    
    if (!fuzzyRes.ok) {
      if (fuzzyRes.status === 400) {
        console.log(`[Yugioh] No results for "${query}"`);
        return [];
      }
      throw new Error(`YGOPRODeck API Error: ${fuzzyRes.status}`);
    }

    const json = await fuzzyRes.json();
    console.log(`[Yugioh] Fuzzy search found ${json.data?.length || 0} results for "${query}"`);
    return json.data || [];
  } catch (error) {
    console.error(`[Yugioh] Search failed for "${query}":`, error);
    return [];
  }
}

export async function getYugiohCardById(id: string) {
  try {
    const response = await fetch(`${BASE_URL}?id=${encodeURIComponent(id)}`);
    if (!response.ok) return null;
    const json = await response.json();
    return json.data && json.data.length > 0 ? json.data[0] : null;
  } catch (error) {
    console.error(`Failed to fetch Yugioh card by ID ${id}:`, error);
    return null;
  }
}

/**
 * Extract all unique card_images from a Yugioh card for visual comparison.
 * Yugioh alternate arts are stored as separate items in card_images[].
 * Returns an array of { imageUrl, imageUrlSmall, setCode, setName, rarity, price }
 */
export function getYugiohPrintings(externalCard: any): any[] {
  const images = externalCard.card_images || [];
  const sets = externalCard.card_sets || [];
  const prices = externalCard.card_prices || [];

  return images.map((img: any, idx: number) => ({
    imageUrl: img.image_url || null,
    thumbnailUrl: img.image_url_small || null,
    // Best-effort set association: map by index (alternate arts often have separate set entries)
    setName: sets[idx]?.set_name || sets[0]?.set_name || "Unknown Set",
    setCode: sets[idx]?.set_code || sets[0]?.set_code || null,
    rarity: sets[idx]?.set_rarity || sets[0]?.set_rarity || "Common",
    price: parseFloat(prices[0]?.tcgplayer_price || "0"),
  }));
}

export function formatYugiohCard(externalCard: any, setCode?: string) {
  let cardSet = null;
  let cardPrice = null;

  if (externalCard.card_sets && externalCard.card_sets.length > 0) {
    if (setCode) {
      const exactSet = externalCard.card_sets.find((s: any) => 
        s.set_code?.toLowerCase() === setCode.toLowerCase() || 
        s.set_name?.toLowerCase().includes(setCode.toLowerCase())
      );
      cardSet = exactSet || externalCard.card_sets[0];
    } else {
      cardSet = externalCard.card_sets[0];
    }
  }

  if (externalCard.card_prices && externalCard.card_prices.length > 0) {
    cardPrice = externalCard.card_prices[0];
  }
  const cardImage = externalCard.card_images && externalCard.card_images.length > 0 ? externalCard.card_images[0] : null;

  return {
    externalId: externalCard.id.toString(),
    name: externalCard.name,
    game: "YUGIOH",
    setName: cardSet?.set_name || "Unknown Set",
    rarity: cardSet?.set_rarity || "Common",
    imageUrl: cardImage?.image_url || null,
    thumbnailUrl: cardImage?.image_url_small || null,
    price: {
      marketPrice: parseFloat(cardPrice?.tcgplayer_price || "0")
    }
  };
}
