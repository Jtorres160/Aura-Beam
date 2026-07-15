import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { fetchProviderJson } from "@/lib/providers/http";

const BASE_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

// Per-request timeout (Phase 5.2.5): a hung upstream must become a classified
// failure, not an indefinitely spinning scan.
//
// Phase 5.13B: searchYugiohCards throws a classified ProviderError instead of
// swallowing a failure into []. YGOPRODeck answers 400 for a name that matched
// nothing, so 400 — and only 400 — is a real zero here.
//
// getYugiohCardById() stays lenient for its non-scanner callers.
const fetchOpts = (): RequestInit => ({
  signal: AbortSignal.timeout(8_000),
});

export async function searchYugiohCards(query: string, setCode?: string) {
  // Try exact name first. 400 = "no card by that name" — a real answer.
  const exact = await fetchProviderJson<{ data?: any[] }>(
    `${BASE_URL}?name=${encodeURIComponent(query)}`,
    { emptyStatuses: [400] },
  );
  if (exact?.data?.length) {
    console.log(`[Yugioh] Exact match found for "${query}"`);
    return exact.data;
  }

  // Fall back to fuzzy name search
  const fuzzy = await fetchProviderJson<{ data?: any[] }>(
    `${BASE_URL}?fname=${encodeURIComponent(query)}`,
    { emptyStatuses: [400] },
  );
  console.log(`[Yugioh] Fuzzy search found ${fuzzy?.data?.length || 0} results for "${query}"`);
  return fuzzy?.data ?? [];
}

export async function getYugiohCardById(id: string) {
  try {
    // Scanner ids for alternate-art cards are variant-qualified ("cardId:imageId")
    // so each artwork gets its own local Card row; the API only knows the base id.
    const baseId = id.split(":")[0];
    const response = await fetch(`${BASE_URL}?id=${encodeURIComponent(baseId)}`, fetchOpts());
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
    // Every entry in card_images IS a distinct artwork; without this id all
    // variants would share one illustration group (they share the card id)
    // and the decision layer would refuse to vision-compare them.
    illustrationId: img.id != null ? String(img.id) : `art-${idx}`,
    imageUrl: img.image_url || null,
    thumbnailUrl: img.image_url_small || null,
    // Best-effort set association: map by index (alternate arts often have separate set entries)
    setName: sets[idx]?.set_name || sets[0]?.set_name || "Unknown Set",
    setCode: sets[idx]?.set_code || sets[0]?.set_code || null,
    rarity: sets[idx]?.set_rarity || sets[0]?.set_rarity || "Common",
    price: parseFloat(prices[0]?.tcgplayer_price || "0"),
  }));
}

export function formatYugiohCard(externalCard: any, setCode?: string): CandidatePrinting {
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
    setCode: cardSet?.set_code || null,
    rarity: cardSet?.set_rarity || "Common",
    imageUrl: cardImage?.image_url || null,
    thumbnailUrl: cardImage?.image_url_small || null,
    price: {
      marketPrice: parseFloat(cardPrice?.tcgplayer_price || "0")
    }
  };
}
