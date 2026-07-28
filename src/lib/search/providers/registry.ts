// ─── Provider boundary (Phase 5.12A) ────────────────────────────────────────
// Above this file, nothing knows that Scryfall, the Pokémon TCG API or
// YGOPRODeck exist. A provider does exactly one job: given a parsed query,
// return normalized cards, or THROW a classified SearchProviderError.
//
// A provider must never return [] to mean "I broke".

import { formatPokemonCard } from "@/lib/services/pokemon";
import { CATALOG_LOCAL_ENABLED, catalogSearchForQuery } from "@/lib/services/pokemon-catalog";
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

/** The live upstream, unchanged. Still the fallback, and still the only path
 *  when the local catalog is disabled or genuinely doesn't have the card. */
export const pokemonLiveProvider: SearchProvider = {
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

// ─── Pokémon: local catalog first ───────────────────────────────────────────
// The scan path was repointed off the live API and onto our own catalog_cards in
// M-CATALOG · M4. Search never was, and went on asking api.pokemontcg.io for
// every query. Measured on 2026-07-28, through this exact provider:
//
//     pokemon    p50 1903ms   p95 7644ms   max 11786ms   (~55% of requests 500)
//     scryfall   p50   27ms   p95  140ms
//     ygoprodeck p50  290ms   p95  442ms
//
// and those pokemon figures are a FLOOR — the harness zeroes the retry backoff
// that production pays. Because CardSearchService fans out with Promise.all, an
// unfiltered search is as slow as this one source.
//
// Meanwhile the catalog already holds the answer. Over ten sampled names, 452 of
// 452 cards the live API returned were already in catalog_cards, with prices.
//
// FAIL-OPEN, and it is the whole safety argument for this change:
//
//     catalog has cards  → serve them, never touch the live API
//     catalog has none   → ask the live API, exactly as before
//     catalog ERRORS     → ask the live API, exactly as before
//
// So a card in a set newer than the last sync is still findable, and a local DB
// hiccup degrades to today's behaviour rather than to a worse one. What it can
// never do is turn a local miss into "no such card" — the empty list is handed
// to the live provider as a question, not returned as an answer.
//
// The truth boundary is untouched. This provider throws SearchProviderError from
// the live path exactly as before, and a catalog hit is a source that ANSWERED,
// so `provider_unavailable` still means what it has always meant.

/** The three collaborators the local-first path needs, injectable so the
 *  fail-open behaviour can be tested without a database, without the network,
 *  and without juggling a module-load-time env flag. */
export interface PokemonSearchDeps {
  enabled: boolean;
  catalogSearch: typeof catalogSearchForQuery;
  live: SearchProvider["search"];
}

const defaultPokemonDeps: PokemonSearchDeps = {
  enabled: CATALOG_LOCAL_ENABLED,
  catalogSearch: catalogSearchForQuery,
  live: (parsed) => pokemonLiveProvider.search(parsed),
};

export async function searchPokemonLocalFirst(
  parsed: ParsedQuery,
  deps: PokemonSearchDeps = defaultPokemonDeps,
): Promise<CardSearchResult[]> {
  if (!parsed.name && !parsed.collectorNumber) return [];

  if (deps.enabled) {
    // Errors are swallowed HERE deliberately. Letting one propagate would surface
    // as a FAILED pokemon source — i.e. "we couldn't reach the Pokémon database" —
    // which a local Postgres hiccup must never claim while the live API is sitting
    // there reachable. Same reasoning as lookupBySource() in candidates.ts.
    const local = await deps
      .catalogSearch(parsed.name, parsed.collectorNumber)
      .catch((err: unknown) => {
        console.warn(
          "[Search] Local Pokémon catalog failed — falling back to the live API:",
          (err as Error)?.message,
        );
        return [];
      });

    if (local.length > 0) {
      // Explicit local-serve marker, matching the scan path's (candidates.ts):
      // both paths label the source "pokemon", so without this line there is no
      // way to tell from logs which one answered.
      console.log(
        `[Search] served Pokémon from local catalog (${local.length} cards for "${parsed.raw}")`,
      );
      return local.map((c) => fromCandidatePrinting(c, "pokemon"));
    }
  }

  // A local miss is a QUESTION passed to the live API, never an answer returned
  // to the collector. Whatever the live provider does — cards, a real zero, or a
  // thrown SearchProviderError — is what search sees, exactly as before.
  return deps.live(parsed);
}

export const pokemonProvider: SearchProvider = {
  id: "pokemon",
  game: "POKEMON",
  search: (parsed) => searchPokemonLocalFirst(parsed),
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
