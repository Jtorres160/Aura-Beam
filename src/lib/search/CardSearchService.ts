// ─── CardSearchService (Phase 5.12A) ────────────────────────────────────────
// The single entry point for finding a card. Everything above this line asks
// one question ("find me X") and gets back a truth claim; everything below is
// provider detail.
//
//   route.ts
//      │
//   CardSearchService  ← parses intent, consults sources, judges, classifies
//      │
//      ├── local (Prisma)
//      ├── scryfall (MTG)
//      ├── pokemon
//      └── ygoprodeck
//
// Responsibilities that used to live in the route — provider dispatch, price
// shaping, dedup, formatting — live here. The route now only speaks HTTP.

import type { GameId } from "@/lib/scanner/evidence";
import { dedupeByIdentity } from "@/lib/search/identity";
import { rankResults } from "@/lib/search/match";
import { parseSearchQuery } from "@/lib/search/query";
// Imported from the explicit module rather than a directory index: the test
// loader (test/alias-loader.mjs) resolves "@/x" to "src/x.ts" and does not do
// index resolution, so a barrel here would build but be untestable.
import { REMOTE_PROVIDERS, SearchProviderError, type SearchProvider } from "@/lib/search/providers/registry";
import { searchLocalCards } from "@/lib/search/providers/local";
import {
  classifyOutcome,
  SOURCE_LABELS,
  type CardSearchResult,
  type SearchOutcome,
  type SearchSourceStatus,
} from "@/lib/search/types";

export interface CardSearchOptions {
  query: string;
  /** Restrict to one game. Sources for other games become "unavailable". */
  game?: GameId | null;
  /** Max cards returned after ranking. */
  limit?: number;
}

const DEFAULT_LIMIT = 40;
const LOCAL_FETCH_LIMIT = 50;

/** Run one source, timing it and converting a throw into a "failed" reading. */
async function runSource(
  source: SearchSourceStatus["source"],
  fn: () => Promise<CardSearchResult[]>,
): Promise<{ cards: CardSearchResult[]; status: SearchSourceStatus }> {
  const startedAt = Date.now();
  const base = { source, label: SOURCE_LABELS[source] };
  try {
    const cards = await fn();
    return {
      cards,
      status: {
        ...base,
        availability: "completed",
        resultCount: cards.length,
        durationMs: Date.now() - startedAt,
      },
    };
  } catch (err) {
    // A source that throws contributes NO cards and NO zero — only a failure.
    const reason = err instanceof SearchProviderError ? err.reason : "unexpected";
    console.warn(`[Search] Source "${source}" failed (${reason}):`, (err as Error)?.message);
    return {
      cards: [],
      status: {
        ...base,
        availability: "failed",
        reason,
        resultCount: 0,
        durationMs: Date.now() - startedAt,
      },
    };
  }
}

function skipped(source: SearchSourceStatus["source"]): SearchSourceStatus {
  return {
    source,
    label: SOURCE_LABELS[source],
    availability: "unavailable",
    resultCount: 0,
    durationMs: 0,
  };
}

/**
 * Search every applicable card database and return a truth claim.
 *
 * Sources are consulted in PARALLEL and are independently fault-isolated: one
 * source failing never prevents another's results from reaching the collector,
 * and never turns into a claim that the card does not exist.
 */
export async function searchCards(options: CardSearchOptions): Promise<SearchOutcome> {
  const { query, game = null, limit = DEFAULT_LIMIT } = options;
  const parsed = parseSearchQuery(query);

  // An empty query is a real, answerable question ("show me nothing yet") —
  // not a failure and not worth waking three APIs for.
  if (!parsed.name && !parsed.collectorNumber) {
    return { status: "no_matches", cards: [], sources: [] };
  }

  const applicable: SearchProvider[] = REMOTE_PROVIDERS.filter((p) => !game || p.game === game);
  const excluded: SearchProvider[] = REMOTE_PROVIDERS.filter((p) => game !== null && p.game !== game);

  const settled = await Promise.all([
    runSource("local", () => searchLocalCards({ parsed, game, limit: LOCAL_FETCH_LIMIT })),
    ...applicable.map((p) => runSource(p.id, () => p.search(parsed))),
  ]);

  // Local first: its rows carry our own id and price history, so when the same
  // printing arrives from both, the local copy is the one we keep.
  const merged = settled.flatMap((s) => s.cards);
  const sources: SearchSourceStatus[] = [
    ...settled.map((s) => s.status),
    // Sources a game filter excluded were never asked. That is "unavailable",
    // NOT a failure — the Phase 5.10 rule, unchanged: an unavailable source is
    // not a contradiction, and must not make the answer uncertain.
    ...excluded.map((p) => skipped(p.id)),
  ];

  const ranked = rankResults(parsed, dedupeByIdentity(merged)).slice(0, limit);

  return classifyOutcome(ranked, sources);
}
