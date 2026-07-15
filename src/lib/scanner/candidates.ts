// ─── Candidate Generation ───────────────────────────────────────────────────
// Step 2 of the scan pipeline: given the OCR'd fields, fetch every printing of
// the identified card from the game's card database. Produces evidence only —
// the decision layer decides which printing (if any) to accept.
//
// ─── Candidate Truth Layer (Phase 5.13B) ────────────────────────────────────
// This module used to answer with `{ printings: [], fallbackCard: null }` for
// BOTH of these:
//
//     A. the card database answered, and this card is not in it
//     B. the card database never answered
//
// The route could not tell them apart, so it said the same thing either way:
// "no match was found in any card database". In case B that is a card database
// asserting the non-existence of a card it never looked up — the exact lie
// Phase 5.12A removed from search, still live here.
//
// CandidateOutcome is the scanner's SearchOutcome: same rule, same asymmetry,
// applied to candidate retrieval.
//
//     search   classifyOutcome()          → SearchOutcome
//     scanner  classifyCandidateOutcome() → CandidateOutcome
//
// Note what this does NOT do: a provider failure never lowers confidence. That
// would still be treating absence as evidence, just more quietly. The scorer
// receives exactly what it always did — the printings we actually have — and
// the failure travels alongside as CONTEXT, so the route can decline to claim
// "not found" rather than claim it less loudly.

import { searchPokemonCards, searchPokemonBySetAndNumber, fetchAllPokemonPrintings, formatPokemonCard, fetchPokemonCardById } from "@/lib/services/pokemon";
import { searchScryfallCardByName, fetchAllMTGPrintings, formatScryfallCard, searchScryfallBySetAndCollector, searchScryfallDeepFallback, fetchScryfallCardById } from "@/lib/services/scryfall";
import { searchYugiohCards, getYugiohPrintings, formatYugiohCard, fetchYugiohCardById } from "@/lib/services/yugioh";
import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { type MatchMethod, nameMatchesOcr } from "@/lib/scanner/decision";
import { ProviderError, type ProviderFailureReason } from "@/lib/providers/http";

/** The card databases candidate generation can consult. Deliberately the same
 *  ids the search layer uses (SearchSourceId minus "local"), so a source is
 *  named identically wherever a collector meets it. */
export type CandidateSourceId = "scryfall" | "pokemon" | "ygoprodeck";

/** Human-facing source names. The UI must never invent its own spellings. */
export const CANDIDATE_SOURCE_LABELS: Record<CandidateSourceId, string> = {
  scryfall: "Scryfall (MTG)",
  pokemon: "Pokémon TCG API",
  ygoprodeck: "YGOPRODeck (Yu-Gi-Oh!)",
};

export interface CandidateSourceStatus {
  source: CandidateSourceId;
  label: string;
  /** "completed": it answered — a zero from it is a REAL zero.
   *  "failed":    it did not answer. A zero from it means nothing. */
  availability: "completed" | "failed";
  /** Set only when availability is "failed". */
  reason?: ProviderFailureReason;
}

/**
 * The result of candidate generation, as a truth claim rather than a list.
 *
 * Only `no_candidates` asserts the card was not found. `provider_unavailable`
 * asserts that we do not know — and those are different sentences to a
 * collector holding a real card in their hand.
 */
export type CandidateOutcome =
  | {
      status: "found";
      printings: CandidatePrinting[];
      fallbackCard: CandidatePrinting | null;
      /** HOW fallbackCard was found — decides whether it may be auto-saved. */
      fallbackMethod?: MatchMethod;
      sources: CandidateSourceStatus[];
    }
  | {
      status: "no_candidates";
      printings: [];
      fallbackCard: null;
      sources: CandidateSourceStatus[];
    }
  | {
      status: "provider_unavailable";
      printings: [];
      fallbackCard: null;
      sources: CandidateSourceStatus[];
      /** Labels of the sources that failed, for a UI that must not guess. */
      unavailable: string[];
    };

/**
 * Turn per-source readings into a truth claim. The single place allowed to
 * conclude "this card is not in any database".
 *
 * The rule, stated exactly — and deliberately identical to classifyOutcome():
 *
 *   Candidate generation is "no_candidates" ONLY when every source we consulted
 *   answered and none of them had the card. If any source failed, we do not know
 *   whether the card exists, and we must say so.
 *
 * Note the asymmetry: cards we HAVE outrank a failure ("found" wins even if a
 * source failed, with the failure still reported in `sources`), because a card
 * in hand is positive evidence. Zero cards never outranks a failure, because
 * zero-from-a-failed-source is not evidence at all.
 */
export function classifyCandidateOutcome(
  printings: CandidatePrinting[],
  fallbackCard: CandidatePrinting | null,
  fallbackMethod: MatchMethod | undefined,
  sources: CandidateSourceStatus[],
): CandidateOutcome {
  if (printings.length > 0 || fallbackCard) {
    return { status: "found", printings, fallbackCard, fallbackMethod, sources };
  }

  const failed = sources.filter((s) => s.availability === "failed");
  if (failed.length > 0) {
    return {
      status: "provider_unavailable",
      printings: [],
      fallbackCard: null,
      sources,
      unavailable: failed.map((s) => s.label),
    };
  }

  // Every consulted source answered and none had it. Only now may we say so.
  return { status: "no_candidates", printings: [], fallbackCard: null, sources };
}

/**
 * Tracks the availability of ONE source across the several calls a game's
 * candidate path makes to it.
 *
 * A source is "failed" if ANY of its calls failed and we ended up with nothing:
 * each call asks a different question ("is it at this set/number?", "what is
 * printed under this name?"), so an unanswered one leaves a hole we cannot
 * honestly paper over. `run()` never throws — a failure is recorded and the
 * caller receives the empty value, exactly as before — so no provider hiccup
 * can kill a scan that another signal could still rescue.
 */
class SourceTracker {
  readonly source: CandidateSourceId;
  private failure: ProviderFailureReason | null = null;

  constructor(source: CandidateSourceId) {
    this.source = source;
  }

  async run<T>(fn: () => Promise<T>, whenUnavailable: T): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      const reason: ProviderFailureReason =
        err instanceof ProviderError ? err.reason : "unexpected";
      // First failure wins: it is the one that opened the hole.
      this.failure ??= reason;
      console.warn(
        `[Scanner] Candidate source "${this.source}" failed (${reason}):`,
        (err as Error)?.message,
      );
      return whenUnavailable;
    }
  }

  status(): CandidateSourceStatus {
    const base = { source: this.source, label: CANDIDATE_SOURCE_LABELS[this.source] };
    return this.failure
      ? { ...base, availability: "failed" as const, reason: this.failure }
      : { ...base, availability: "completed" as const };
  }
}

// ─── Fetch all printings for visual comparison ─────────────────────────────
export async function fetchAllPrintings(
  cardName: string, game: string, setCode: string, collectorNumber: string,
  manaCost: string, typeLine: string, powerToughness: string
): Promise<CandidateOutcome> {
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

  // ─── Unknown game — try all, return the first hit ──────────────────
  // Every source consulted along the way is carried forward, so a Pokémon
  // timeout still counts against a final "not in any database" verdict even
  // though the MTG attempt answered cleanly. Otherwise this path would launder
  // a failure into a confident zero: "we checked everywhere" is only true if
  // everywhere answered.
  const attempts: CandidateOutcome[] = [];

  const mtg = await fetchMTGPrintings(cardName, setCode, collectorNumber, manaCost, typeLine, powerToughness);
  if (mtg.status === "found") return mtg;
  attempts.push(mtg);

  const pkmn = await fetchPokemonPrintings(cardName, setCode, collectorNumber);
  if (pkmn.status === "found") return pkmn;
  attempts.push(pkmn);

  const ygo = await fetchYugiohPrintings(cardName);
  if (ygo.status === "found") return ygo;
  attempts.push(ygo);

  return classifyCandidateOutcome([], null, undefined, attempts.flatMap((a) => a.sources));
}

// ─── Authoritative lookup by identifier ─────────────────────────────────────
// Fetch ONE printing straight from its source database by external id. This is
// the server-side trust anchor for user selections: the client names a card by
// (game, externalId) only, and everything persisted about it comes from here —
// never from the request body.
//
// ─── Phase 5.13C ────────────────────────────────────────────────────────────
// This function used to be `Promise<CandidatePrinting | null>` with a bare
// `catch { return null }` around the whole body — the SAME collapse 5.13B
// removed from fetchAllPrintings, one hop downstream, and worse:
//
//     provider timeout → null → 404 "Could not verify the selected card.
//                                    Please scan again."
//
// That sentence is told to a collector who has ALREADY passed capture, OCR,
// vision and candidate generation, and then confirmed the card by eye on a grid
// Aura itself drew from that provider's own data. The card's existence is not
// in question at that point — ours to look it up is. And "scan again" is not
// just wrong, it is irrational advice: it sends the user back through the whole
// pipeline to land on the same grid and the same timeout.
//
//     Selection failed  ≠  Card does not exist
//
// So this returns a truth claim, exactly like CandidateOutcome does one layer up.

/**
 * The result of an authoritative by-id lookup, as a truth claim rather than a
 * nullable card. Only `not_found` asserts the source has no such card.
 */
export type PrintingLookupResult =
  | { status: "found"; card: CandidatePrinting }
  | { status: "not_found" }
  | {
      status: "provider_unavailable";
      source: CandidateSourceId;
      /** Human-facing name of the source that went quiet. */
      label: string;
      reason: ProviderFailureReason;
    };

/** Which database owns this game's cards, or null if we have no source for it. */
function sourceForGame(game: string): CandidateSourceId | null {
  const g = game?.toUpperCase?.() || "";
  if (g.includes("MTG") || g.includes("MAGIC")) return "scryfall";
  if (g.includes("POKEMON") || g.includes("POKÉMON")) return "pokemon";
  if (g.includes("YUGIOH") || g.includes("YU-GI-OH")) return "ygoprodeck";
  return null;
}

export async function fetchPrintingById(game: string, externalId: string): Promise<PrintingLookupResult> {
  const source = sourceForGame(game);
  // No source for this game is an ANSWERED question: we know we cannot hold a
  // card for it. That is absence of support, not absence of an answer.
  if (!source) return { status: "not_found" };

  try {
    const card = await lookupBySource(source, externalId);
    return card ? { status: "found", card } : { status: "not_found" };
  } catch (err) {
    const reason: ProviderFailureReason =
      err instanceof ProviderError ? err.reason : "unexpected";
    console.warn(
      `[Scanner] By-id lookup of "${externalId}" from "${source}" failed (${reason}):`,
      (err as Error)?.message,
    );
    return {
      status: "provider_unavailable",
      source,
      label: CANDIDATE_SOURCE_LABELS[source],
      reason,
    };
  }
}

/** Games we can authoritatively re-fetch a printing for, in probe order. */
const SUPPORTED_GAMES: readonly string[] = ["MTG", "POKEMON", "YUGIOH"];

/**
 * Resolve a printing by id WITHOUT being told its game — try each source in
 * turn (Phase 5.13C).
 *
 * Lives here, beside fetchAllPrintings' unknown-game path, because it is the
 * same judgement and must not drift from it: a route is not the layer allowed
 * to decide what a silent provider means.
 *
 * It replaces a loop in collections/add that was the most confident liar in the
 * codebase. Every lookup returned `Card | null`, so:
 *
 *     MTG times out      → null → keep going
 *     Pokemon times out  → null → keep going
 *     YGO answers "no"   → null
 *                        → 404 "Card not found in local DB or external API"
 *
 * Three sources, two of which never answered, and it reported the confident
 * negative anyway. It asked "does this card not exist?" when the only question
 * it had actually put to anyone was "did the providers answer?".
 *
 * Same asymmetry as everywhere else in the truth layer: found outranks a
 * failure, a failure outranks a zero.
 */
export async function fetchPrintingByIdAcrossGames(externalId: string): Promise<PrintingLookupResult> {
  const attempts: PrintingLookupResult[] = [];

  for (const game of SUPPORTED_GAMES) {
    const result = await fetchPrintingById(game, externalId);
    // A card in hand is positive evidence — it ends the probe, and a failure
    // elsewhere cannot erase it.
    if (result.status === "found") return result;
    attempts.push(result);
  }

  // Zero from a source that never answered is not evidence of absence. If ANY
  // source went quiet we do not know, and we say so instead of asserting a 404.
  const unavailable = attempts.find((a) => a.status === "provider_unavailable");
  if (unavailable) return unavailable;

  // Every source we have answered, and none of them has this id. Earned.
  return { status: "not_found" };
}

/** The per-source fetch+format. Throws ProviderError; never swallows. */
async function lookupBySource(source: CandidateSourceId, externalId: string): Promise<CandidatePrinting | null> {
  if (source === "scryfall") {
    const card = await fetchScryfallCardById(externalId);
    return card ? formatScryfallCard(card) : null;
  }
  if (source === "pokemon") {
    const card = await fetchPokemonCardById(externalId);
    return card ? formatPokemonCard(card) : null;
  }

  const card = await fetchYugiohCardById(externalId);
  if (!card) return null;
  // Variant-qualified ids ("cardId:imageId") name one artwork of a
  // multi-art card. Rebuild that exact variant — same shape as
  // fetchYugiohPrintings — so the saved row keeps the variant id/images.
  const imageId = externalId.split(":")[1];
  if (!imageId) return formatYugiohCard(card);

  const variant = getYugiohPrintings(card).find((p: any) => p.illustrationId === imageId);
  // The card answered and has no such artwork — a real, earned "not found".
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

async function fetchMTGPrintings(cardName: string, setCode: string, collectorNumber: string, manaCost: string, typeLine: string, powerToughness: string): Promise<CandidateOutcome> {
  const scryfall = new SourceTracker("scryfall");

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
    ? scryfall.run(() => searchScryfallBySetAndCollector(setCode, cleanCn), null)
    : Promise.resolve(null);
  // Started before we know whether we'll await it: a verified direct hit returns
  // without touching this, so run() must absorb any rejection rather than let it
  // surface unhandled.
  const allPromise = scryfall.run(() => fetchAllMTGPrintings(cardName), [] as any[]);

  let directMatch: CandidatePrinting | null = null;
  const direct = await directPromise;
  if (direct) {
    directMatch = formatScryfallCard(direct);
    if (nameMatchesOcr(cardName, directMatch.name)) {
      console.log(`[Scanner] Set/CN match verified by name: "${directMatch.name}" (${setCode} #${cleanCn})`);
      return classifyCandidateOutcome([], directMatch, "set-cn-verified", [scryfall.status()]);
    }
    console.log(`[Scanner] Set/CN lookup returned "${directMatch.name}" but OCR read "${cardName}" — holding it as a weak guess.`);
  }

  // Get all unique printings
  const allPrintings = await allPromise;
  const printings = allPrintings.map(formatScryfallCard);

  if (printings.length > 0) {
    console.log(`[Scanner] MTG: fetched ${printings.length} printings for "${cardName}"`);
    return classifyCandidateOutcome(printings, null, undefined, [scryfall.status()]);
  }

  // Name search failed, so the name was probably the hallucinated field
  // after all — an unverified set/CN hit is the best remaining guess.
  if (directMatch) {
    return classifyCandidateOutcome([], directMatch, "fallback-guess", [scryfall.status()]);
  }

  // ─── Fallback 2: Deep Semantic Search based on physical attributes ──
  const deepMatch = await scryfall.run(
    () => searchScryfallDeepFallback(cardName, manaCost, typeLine, powerToughness, setCode),
    null,
  );
  if (deepMatch) {
    console.log(`[Scanner] Fallback 2 (Deep Semantic) succeeded for: ${deepMatch.name}`);
    return classifyCandidateOutcome([], formatScryfallCard(deepMatch), "fallback-guess", [scryfall.status()]);
  }

  // Fallback 3: single card exact/fuzzy name lookup
  const namedResult = await scryfall.run(() => searchScryfallCardByName(cardName), null);
  if (namedResult) {
    return classifyCandidateOutcome([], formatScryfallCard(namedResult), "fallback-guess", [scryfall.status()]);
  }

  return classifyCandidateOutcome([], null, undefined, [scryfall.status()]);
}

async function fetchPokemonPrintings(cardName: string, setCode?: string, collectorNumber?: string): Promise<CandidateOutcome> {
  const pokemon = new SourceTracker("pokemon");

  // ─── Set+number lookup — the Pokemon mirror of the MTG path ─────
  // Only trusted ("set-cn-verified") when the card it returns also bears
  // the OCR'd name; otherwise the set/CN may itself be the misread field.
  //
  // Both lookups read ONLY the OCR fields — neither consumes the other's
  // result — so they are started together and the direct hit's round trip
  // hides behind the name search's instead of adding to it (Phase 5.13).
  const directPromise = setCode && collectorNumber
    ? pokemon.run(() => searchPokemonBySetAndNumber(setCode, collectorNumber), [] as any[])
    : Promise.resolve([] as any[]);
  // Started before we know whether we'll await it: a verified direct hit returns
  // without touching this, so run() must absorb any rejection rather than let it
  // surface unhandled.
  const allPromise = pokemon.run(() => fetchAllPokemonPrintings(cardName), [] as any[]);

  let directMatch: CandidatePrinting | null = null;
  const hits = await directPromise;
  if (hits.length === 1) {
    directMatch = formatPokemonCard(hits[0]);
    if (nameMatchesOcr(cardName, directMatch.name)) {
      console.log(`[Scanner] Pokemon set/number match verified by name: "${directMatch.name}" (${setCode} #${collectorNumber})`);
      return classifyCandidateOutcome([], directMatch, "set-cn-verified", [pokemon.status()]);
    }
    console.log(`[Scanner] Pokemon set/number lookup returned "${directMatch.name}" but OCR read "${cardName}" — holding it as a weak guess.`);
  }

  const allPrintings = await allPromise;
  const printings = allPrintings.map(formatPokemonCard);

  if (printings.length > 0) {
    console.log(`[Scanner] Pokemon: fetched ${printings.length} printings for "${cardName}"`);
    return classifyCandidateOutcome(printings, null, undefined, [pokemon.status()]);
  }

  // Name search failed, so the name was probably the misread field after
  // all — an unverified set/number hit is the best remaining guess.
  if (directMatch) {
    return classifyCandidateOutcome([], directMatch, "fallback-guess", [pokemon.status()]);
  }

  // Fallback: fuzzy name search
  const results = await pokemon.run(() => searchPokemonCards(cardName), [] as any[]);
  const exactMatch = results.find((c: any) => c.name?.toLowerCase() === cardName.toLowerCase());
  const card = exactMatch || results[0];
  if (card) {
    return classifyCandidateOutcome([], formatPokemonCard(card), "fallback-guess", [pokemon.status()]);
  }

  return classifyCandidateOutcome([], null, undefined, [pokemon.status()]);
}

async function fetchYugiohPrintings(cardName: string): Promise<CandidateOutcome> {
  const ygo = new SourceTracker("ygoprodeck");
  const results = await ygo.run(() => searchYugiohCards(cardName), [] as any[]);
  const exactMatch = results.find((c: any) => c.name?.toLowerCase() === cardName.toLowerCase()) || results[0];

  if (!exactMatch) return classifyCandidateOutcome([], null, undefined, [ygo.status()]);

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
    return classifyCandidateOutcome(imagePrintings, null, undefined, [ygo.status()]);
  }

  return classifyCandidateOutcome([], formatYugiohCard(exactMatch), "fallback-guess", [ygo.status()]);
}
