// ─── Candidate Generation ───────────────────────────────────────────────────
// Step 2 of the scan pipeline: given the OCR'd fields, fetch every printing of
// the identified card from the game's card database. Produces evidence only —
// the decision layer decides which printing (if any) to accept.

import { searchPokemonCards, searchPokemonBySetAndNumber, fetchAllPokemonPrintings, formatPokemonCard, getPokemonCardById } from "@/lib/services/pokemon";
import { searchScryfallCardByName, fetchAllMTGPrintings, formatScryfallCard, searchScryfallBySetAndCollector, searchScryfallDeepFallback, getScryfallCardById } from "@/lib/services/scryfall";
import { searchYugiohCards, getYugiohPrintings, formatYugiohCard, getYugiohCardById } from "@/lib/services/yugioh";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { type MatchMethod, nameMatchesOcr } from "@/lib/scanner/decision";

export interface PrintingsResult {
  printings: CandidatePrinting[];
  fallbackCard: CandidatePrinting | null;
  /** HOW fallbackCard was found — decides whether it may be auto-saved. */
  fallbackMethod?: MatchMethod;
}

// ─── Fetch all printings for visual comparison ─────────────────────────────
export async function fetchAllPrintings(
  cardName: string, game: string, setCode: string, collectorNumber: string,
  manaCost: string, typeLine: string, powerToughness: string
): Promise<PrintingsResult> {
  const normalizedGame = game?.toUpperCase?.() || "";

  if (normalizedGame.includes("MTG") || normalizedGame.includes("MAGIC")) {
    return await fetchMTGPrintings(cardName, setCode, collectorNumber, manaCost, typeLine, powerToughness);
  }
  if (normalizedGame.includes("POKEMON") || normalizedGame.includes("POKÉMON")) {
    return await fetchPokemonPrintings(cardName, setCode, collectorNumber);
  }
  if (normalizedGame.includes("YUGIOH") || normalizedGame.includes("YU-GI-OH")) {
    return await fetchYugiohPrintings(cardName);
  }

  // Unknown game — try all, return first hit
  const mtg = await fetchMTGPrintings(cardName, setCode, collectorNumber, manaCost, typeLine, powerToughness);
  if (mtg.printings.length > 0 || mtg.fallbackCard) return mtg;

  const pkmn = await fetchPokemonPrintings(cardName, setCode, collectorNumber);
  if (pkmn.printings.length > 0 || pkmn.fallbackCard) return pkmn;

  return await fetchYugiohPrintings(cardName);
}

// ─── Authoritative lookup by identifier ─────────────────────────────────────
// Fetch ONE printing straight from its source database by external id. This is
// the server-side trust anchor for user selections: the client names a card by
// (game, externalId) only, and everything persisted about it comes from here —
// never from the request body.
export async function fetchPrintingById(game: string, externalId: string): Promise<CandidatePrinting | null> {
  const g = game?.toUpperCase?.() || "";
  try {
    if (g.includes("MTG") || g.includes("MAGIC")) {
      const card = await getScryfallCardById(externalId);
      return card ? formatScryfallCard(card) : null;
    }
    if (g.includes("POKEMON") || g.includes("POKÉMON")) {
      const card = await getPokemonCardById(externalId);
      return card ? formatPokemonCard(card) : null;
    }
    if (g.includes("YUGIOH") || g.includes("YU-GI-OH")) {
      const card = await getYugiohCardById(externalId);
      if (!card) return null;
      // Variant-qualified ids ("cardId:imageId") name one artwork of a
      // multi-art card. Rebuild that exact variant — same shape as
      // fetchYugiohPrintings — so the saved row keeps the variant id/images.
      const imageId = externalId.split(":")[1];
      if (imageId) {
        const variant = getYugiohPrintings(card).find((p: any) => p.illustrationId === imageId);
        if (!variant) return null;
        return {
          externalId,
          name: card.name,
          game: "YUGIOH",
          setName: variant.setName,
          setCode: variant.setCode,
          rarity: variant.rarity,
          imageUrl: variant.imageUrl,
          thumbnailUrl: variant.thumbnailUrl,
          price: { marketPrice: variant.price },
          illustrationId: variant.illustrationId,
        };
      }
      return formatYugiohCard(card);
    }
    return null;
  } catch {
    return null;
  }
}

async function fetchMTGPrintings(cardName: string, setCode: string, collectorNumber: string, manaCost: string, typeLine: string, powerToughness: string): Promise<PrintingsResult> {
  try {
    // ─── Set+collector lookup — bypasses OCR name hallucinations ────
    // Only trusted ("set-cn-verified") when the card it returns also bears
    // the OCR'd name; otherwise the set/CN may itself be the misread field.
    //
    // Both lookups read ONLY the OCR fields — neither consumes the other's
    // result — so they are started together and the direct hit's round trip
    // hides behind the name search's instead of adding to it (Phase 5.13).
    const cleanCn = collectorNumber ? collectorNumber.split('/')[0].trim() : "";
    const directPromise = setCode && cleanCn
      // e.g. "MH2", "267" or "267/303" -> use just the prefix
      ? searchScryfallBySetAndCollector(setCode, cleanCn)
      : Promise.resolve(null);
    // Floated on purpose: a verified direct hit returns WITHOUT awaiting this,
    // so it must never surface as an unhandled rejection. [] then flows through
    // the same "name search found nothing" path it always did.
    const allPromise = fetchAllMTGPrintings(cardName).catch(() => [] as any[]);

    let directMatch: CandidatePrinting | null = null;
    const direct = await directPromise;
    if (direct) {
      directMatch = formatScryfallCard(direct);
      if (nameMatchesOcr(cardName, directMatch.name)) {
        console.log(`[Scanner] Set/CN match verified by name: "${directMatch.name}" (${setCode} #${cleanCn})`);
        return { printings: [], fallbackCard: directMatch, fallbackMethod: "set-cn-verified" };
      }
      console.log(`[Scanner] Set/CN lookup returned "${directMatch.name}" but OCR read "${cardName}" — holding it as a weak guess.`);
    }

    // Get all unique printings
    const allPrintings = await allPromise;
    const printings = allPrintings.map(formatScryfallCard);

    if (printings.length > 0) {
      console.log(`[Scanner] MTG: fetched ${printings.length} printings for "${cardName}"`);
      return { printings, fallbackCard: null };
    }

    // Name search failed, so the name was probably the hallucinated field
    // after all — an unverified set/CN hit is the best remaining guess.
    if (directMatch) {
      return { printings: [], fallbackCard: directMatch, fallbackMethod: "fallback-guess" };
    }

    // ─── Fallback 2: Deep Semantic Search based on physical attributes ──
    const deepMatch = await searchScryfallDeepFallback(cardName, manaCost, typeLine, powerToughness, setCode);
    if (deepMatch) {
      console.log(`[Scanner] Fallback 2 (Deep Semantic) succeeded for: ${deepMatch.name}`);
      return { printings: [], fallbackCard: formatScryfallCard(deepMatch), fallbackMethod: "fallback-guess" };
    }

    // Fallback 3: single card exact/fuzzy name lookup
    const namedResult = await searchScryfallCardByName(cardName);
    if (namedResult) return { printings: [], fallbackCard: formatScryfallCard(namedResult), fallbackMethod: "fallback-guess" };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchPokemonPrintings(cardName: string, setCode?: string, collectorNumber?: string): Promise<PrintingsResult> {
  try {
    // ─── Set+number lookup — the Pokemon mirror of the MTG path ─────
    // Only trusted ("set-cn-verified") when the card it returns also bears
    // the OCR'd name; otherwise the set/CN may itself be the misread field.
    //
    // Both lookups read ONLY the OCR fields — neither consumes the other's
    // result — so they are started together and the direct hit's round trip
    // hides behind the name search's instead of adding to it (Phase 5.13).
    const directPromise = setCode && collectorNumber
      ? searchPokemonBySetAndNumber(setCode, collectorNumber)
      : Promise.resolve([] as any[]);
    // Floated on purpose: a verified direct hit returns WITHOUT awaiting this,
    // so it must never surface as an unhandled rejection. [] then flows through
    // the same "name search found nothing" path it always did.
    const allPromise = fetchAllPokemonPrintings(cardName).catch(() => [] as any[]);

    let directMatch: CandidatePrinting | null = null;
    const hits = await directPromise;
    if (hits.length === 1) {
      directMatch = formatPokemonCard(hits[0]);
      if (nameMatchesOcr(cardName, directMatch.name)) {
        console.log(`[Scanner] Pokemon set/number match verified by name: "${directMatch.name}" (${setCode} #${collectorNumber})`);
        return { printings: [], fallbackCard: directMatch, fallbackMethod: "set-cn-verified" };
      }
      console.log(`[Scanner] Pokemon set/number lookup returned "${directMatch.name}" but OCR read "${cardName}" — holding it as a weak guess.`);
    }

    const allPrintings = await allPromise;
    const printings = allPrintings.map(formatPokemonCard);

    if (printings.length > 0) {
      console.log(`[Scanner] Pokemon: fetched ${printings.length} printings for "${cardName}"`);
      return { printings, fallbackCard: null };
    }

    // Name search failed, so the name was probably the misread field after
    // all — an unverified set/number hit is the best remaining guess.
    if (directMatch) {
      return { printings: [], fallbackCard: directMatch, fallbackMethod: "fallback-guess" };
    }

    // Fallback: fuzzy name search
    const results = await searchPokemonCards(cardName);
    const exactMatch = results.find((c: any) => c.name.toLowerCase() === cardName.toLowerCase());
    const card = exactMatch || results[0];
    if (card) return { printings: [], fallbackCard: formatPokemonCard(card), fallbackMethod: "fallback-guess" };

    return { printings: [], fallbackCard: null };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}

async function fetchYugiohPrintings(cardName: string): Promise<PrintingsResult> {
  try {
    const results = await searchYugiohCards(cardName);
    const exactMatch = results.find((c: any) => c.name.toLowerCase() === cardName.toLowerCase()) || results[0];

    if (!exactMatch) return { printings: [], fallbackCard: null };

    // Yugioh packs alternate arts into card_images[] — treat each as a separate "printing"
    const artVariants = getYugiohPrintings(exactMatch);
    // Alternate arts share one API card id. Left unqualified, every variant would
    // collide on the same local Card row and a scan of art B could silently save
    // art A. Qualify the id per artwork when the card has more than one;
    // getYugiohCardById strips the ":imageId" suffix before hitting the API.
    const qualifyId = (p: any) =>
      artVariants.length > 1 ? `${exactMatch.id}:${p.illustrationId}` : exactMatch.id.toString();
    const imagePrintings: CandidatePrinting[] = artVariants.map((p: any) => ({
      externalId: qualifyId(p),
      name: exactMatch.name,
      game: "YUGIOH",
      setName: p.setName,
      setCode: p.setCode,
      rarity: p.rarity,
      imageUrl: p.imageUrl,
      thumbnailUrl: p.thumbnailUrl,
      price: { marketPrice: p.price },
      // Distinct per art variant — without it, the shared card id would fold
      // every variant into one illustration group and block vision comparison.
      illustrationId: p.illustrationId,
    }));

    if (imagePrintings.length > 0) {
      console.log(`[Scanner] Yugioh: fetched ${imagePrintings.length} art variants for "${cardName}"`);
      return { printings: imagePrintings, fallbackCard: null };
    }

    return { printings: [], fallbackCard: formatYugiohCard(exactMatch), fallbackMethod: "fallback-guess" };
  } catch {
    return { printings: [], fallbackCard: null };
  }
}
