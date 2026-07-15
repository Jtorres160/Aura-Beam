// ─── Provider boundary (Phase 5.12A) ────────────────────────────────────────
// Above this file, nothing knows that Scryfall, the Pokémon TCG API or
// YGOPRODeck exist. A provider does exactly one job: given a parsed query,
// return normalized cards, or THROW a classified SearchProviderError.
//
// A provider must never return [] to mean "I broke".

import { formatPokemonCard } from "@/lib/services/pokemon";
import { formatScryfallCard } from "@/lib/services/scryfall";
import { formatYugiohCard } from "@/lib/services/yugioh";
import type { GameId } from "@/lib/scanner/evidence";
import type { ParsedQuery } from "@/lib/search/query";
import type { CardSearchResult, SearchSourceId } from "@/lib/search/types";
import { fetchProviderJson, SearchProviderError } from "@/lib/search/providers/http";
import { fromCandidatePrinting } from "@/lib/search/providers/map";

export interface SearchProvider {
  id: SearchSourceId;
  /** The game this provider serves. A query filtered to another game makes it
   *  structurally "unavailable" — not failed. */
  game: GameId;
  /** Throws SearchProviderError on any non-answer. [] means a real zero. */
  search(parsed: ParsedQuery): Promise<CardSearchResult[]>;
}

// ─── Scryfall (MTG) ─────────────────────────────────────────────────────────

const SCRYFALL_SEARCH = "https://api.scryfall.com/cards/search";
const SCRYFALL_HEADERS = { "User-Agent": "AuraBeam/1.0", Accept: "application/json" };

export const scryfallProvider: SearchProvider = {
  id: "scryfall",
  game: "MTG",
  async search(parsed) {
    // Recall on NAME only; match.ts judges the collector number. Pushing the
    // number upstream as a filter looks precise and is actively harmful: it is
    // printed zero-padded ("006") and stored bare ("6"), so the filter silently
    // deletes the very card the collector asked for. The provider is a sensor.
    const q = parsed.name || (parsed.collectorNumber ? `cn:${parsed.collectorNumber}` : "");
    if (!q) return [];
    const url = `${SCRYFALL_SEARCH}?q=${encodeURIComponent(q)}&order=released&dir=desc`;
    const json = await fetchProviderJson<{ data?: any[] }>(url, {
      headers: SCRYFALL_HEADERS,
      emptyStatuses: [404],
    });
    const rows = json?.data ?? [];
    return rows.map((r) => fromCandidatePrinting(formatScryfallCard(r), "scryfall"));
  },
};

// ─── Pokémon TCG API ────────────────────────────────────────────────────────

const POKEMON_URL = "https://api.pokemontcg.io/v2/cards";

export const pokemonProvider: SearchProvider = {
  id: "pokemon",
  game: "POKEMON",
  async search(parsed) {
    if (!parsed.name && !parsed.collectorNumber) return [];

    // Wildcarded name match gives us recall across punctuation ("Charizard ex"
    // vs "Charizard-EX"); match.ts supplies the precision. The whole q value is
    // encoded ONCE, as a single parameter — the previous code encoded the inner
    // text and left the operators raw, which only worked because fetch happened
    // to re-normalize the quotes for it.
    //
    // The collector number is deliberately NOT sent when we have a name: it is
    // printed "006" and stored "6", so `number:"006"` returns nothing and the
    // right card disappears. match.ts compares numbers with padding tolerance.
    // Only a number-ONLY query pushes it upstream, and then both spellings are
    // asked for, since there is no name to recall on instead.
    let q: string;
    if (parsed.name) {
      q = `name:"*${parsed.name}*"`;
    } else {
      const padded = parsed.collectorNumber as string;
      const bare = padded.replace(/^0+(?=\d)/, "");
      q = bare !== padded ? `(number:"${padded}" OR number:"${bare}")` : `number:"${padded}"`;
    }

    const url = `${POKEMON_URL}?q=${encodeURIComponent(q)}&pageSize=50`;
    const headers: Record<string, string> = {};
    const apiKey = process.env.POKEMON_TCG_API_KEY;
    if (apiKey) headers["X-Api-Key"] = apiKey;

    // This API answers 404 for a well-formed query that matched nothing AND
    // when it is simply unwell (observed: six consecutive 404s on a query that
    // returned 14 cards minutes earlier). It is not safe to read 404 as zero,
    // so it is classified as a failure — the honest reading.
    const json = await fetchProviderJson<{ data?: any[] }>(url, { headers });
    const rows = json?.data ?? [];
    return rows.map((r) => fromCandidatePrinting(formatPokemonCard(r), "pokemon"));
  },
};

// ─── YGOPRODeck (Yu-Gi-Oh!) ─────────────────────────────────────────────────

const YGO_URL = "https://db.ygoprodeck.com/api/v7/cardinfo.php";

export const ygoprodeckProvider: SearchProvider = {
  id: "ygoprodeck",
  game: "YUGIOH",
  async search(parsed) {
    if (!parsed.name) return [];

    // `fname` is a plain substring match, so "Blue Eyes White Dragon" finds
    // nothing — the real card is "Blue-Eyes White Dragon". Asking for the first
    // word instead trades precision for recall (69 cards for "Blue"), and
    // match.ts folds both sides to recover the exact card. Deterministic
    // judging is what makes the loose ask safe.
    const firstWord = parsed.name.split(/\s+/)[0];
    const term = parsed.name.length <= 3 ? parsed.name : firstWord;

    // 400 = "no card matching" for this API; a genuine zero.
    const json = await fetchProviderJson<{ data?: any[] }>(
      `${YGO_URL}?fname=${encodeURIComponent(term)}`,
      { emptyStatuses: [400] },
    );
    const rows = json?.data ?? [];
    return rows.map((r) => fromCandidatePrinting(formatYugiohCard(r), "ygoprodeck"));
  },
};

export const REMOTE_PROVIDERS: SearchProvider[] = [
  scryfallProvider,
  pokemonProvider,
  ygoprodeckProvider,
];

export { SearchProviderError };
