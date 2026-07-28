// ─── Local Pokémon catalog reads (Scanner V2 · M-CATALOG · M4) ───────────────
// Read side of the catalog repoint: serve candidate generation and the by-id
// selection re-fetch from our OWN catalog_cards table instead of the live
// api.pokemontcg.io, so the flaky upstream is no longer on the scan critical
// path (the dependency that made the demo fail — see M-CATALOG-investigation.md).
//
// TRUTH BOUNDARY (the rule the whole task turns on): a MISS in the local catalog
// — a card in a set released since the last sync, say — is NOT "card not found".
// The catalog is a fast, complete-ISH mirror, not an oracle. Every function here
// answers a local miss with an EMPTY value (or null), and the caller in
// candidates.ts treats that as "ask the live API", never as absence. Combined
// with the caller's try/catch, a local error degrades to today's behavior too.
// So: catalog hit → skip the API; catalog miss OR error → exactly today's path.
//
// The catalog stores formatPokemonCard()'s OWN output column-for-column
// (scripts/build-catalog.mjs upserts a formatted CandidatePrinting), so
// formatCatalogCard() below is its exact inverse — the card data a local hit
// yields is byte-identical to what the live API path would have produced for the
// same printing. That equality is the thing the M4 tests pin down.
//
// Gated by CATALOG_LOCAL_ENABLED (default OFF), same discipline as
// FINGERPRINT_SHADOW_ENABLED / RECOGNITION_MEMORY_SERVE: unset ⇒ this module is
// never consulted and the scan path is unchanged.

import type { CandidatePrinting } from "@/lib/scanner/evidence";
import { dbRetry, prisma } from "@/lib/prisma";

/** Off unless explicitly enabled. Turning it on is a separate, reviewed decision
 *  (M6), never a side effect of shipping this code. */
export const CATALOG_LOCAL_ENABLED = process.env.CATALOG_LOCAL_ENABLED === "1";

/** Rows a catalog-backed SEARCH may return before ranking. See
 *  catalogSearchForQuery for why this is wider than the live pageSize it
 *  mirrors — measured at no latency cost, and 400/400 result parity instead
 *  of 230/400. */
export const CATALOG_SEARCH_TAKE = 250;

/** The catalog_cards columns a CandidatePrinting is rebuilt from. Exactly the
 *  fields formatPokemonCard() emits — nothing else is read on the scan path. */
export interface CatalogCardRow {
  externalId: string;
  name: string;
  setName: string;
  setCode: string | null;
  setPrintedSize: number | null;
  collectorNumber: string | null;
  rarity: string;
  imageUrl: string | null;
  thumbnailUrl: string | null;
  marketPrice: number | null;
  lowPrice: number | null;
  midPrice: number | null;
  highPrice: number | null;
}

/** Minimal structural view of the two Prisma reads this module performs. Declared
 *  as a seam so the M4 invariant tests can inject a fake catalog without a live
 *  DB (the DB is production — see the aura-database-topology memory — so tests
 *  must never touch it). */
export interface CatalogDb {
  catalogCard: {
    findMany(args: unknown): Promise<CatalogCardRow[]>;
    findUnique(args: unknown): Promise<CatalogCardRow | null>;
  };
}

// prisma's generated delegate is far more specifically typed than the loose seam
// above; the cast lets the real client stand in for CatalogDb by default while a
// test can pass a hand-rolled fake. Only the two methods on the seam are used.
const defaultDb = prisma as unknown as CatalogDb;

/** The exact column set formatCatalogCard() needs — keeps every read narrow. */
const CATALOG_SELECT = {
  externalId: true,
  name: true,
  setName: true,
  setCode: true,
  setPrintedSize: true,
  collectorNumber: true,
  rarity: true,
  imageUrl: true,
  thumbnailUrl: true,
  marketPrice: true,
  lowPrice: true,
  midPrice: true,
  highPrice: true,
} as const;

/**
 * A catalog_cards row → CandidatePrinting: the exact inverse of
 * formatPokemonCard() (src/lib/services/pokemon.ts). Because build-catalog.mjs
 * stored formatPokemonCard()'s own output, this reconstruction reproduces the
 * same shape and the same absences: a catalog row with no stored price surfaces
 * `price.marketPrice === null`, exactly as a live-fetched unpriced card now
 * does. (It used to coalesce to 0 on both paths, which is what made "never
 * priced" and "worth nothing" the same value — see PrintingPrice.marketPrice.)
 */
export function formatCatalogCard(row: CatalogCardRow): CandidatePrinting {
  return {
    externalId: row.externalId,
    name: row.name,
    game: "POKEMON",
    setName: row.setName,
    setCode: row.setCode,
    setPrintedSize: row.setPrintedSize,
    collectorNumber: row.collectorNumber,
    rarity: row.rarity,
    imageUrl: row.imageUrl,
    thumbnailUrl: row.thumbnailUrl,
    price: {
      marketPrice: row.marketPrice ?? null,
      lowPrice: row.lowPrice ?? null,
      midPrice: row.midPrice ?? null,
      highPrice: row.highPrice ?? null,
    },
  };
}

/**
 * Local mirror of searchPokemonBySetAndNumber(): direct hit by set code +
 * collector number. Replicates the live query's tolerance so set/CN matches
 * don't silently drop (investigation risk #3):
 *  - collector number matches both the zero-padded and bare forms ("021" ⇄ "21");
 *  - set code matches case-insensitively.
 *
 * The one shape the live query has that a single column can't: it matches
 * set.ptcgoCode OR set.id. The catalog stores whichever was present (ptcgoCode
 * preferred), which is the code actually PRINTED on the card and thus what OCR
 * reads — so a case-insensitive match on that one stored value covers the common
 * path. The rare residual (OCR of an internal set.id for a set whose ptcgoCode
 * we stored) simply misses locally and falls through to the live API. Fail-open,
 * never a wrong match.
 */
export async function catalogSearchBySetAndNumber(
  setCode: string,
  collectorNumber: string,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const num = collectorNumber.split("/")[0].trim();
  const bare = num.replace(/^0+(?=\d)/, "");
  const numbers = bare !== num ? [num, bare] : [num];
  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where: {
        game: "POKEMON",
        collectorNumber: { in: numbers },
        setCode: { equals: setCode, mode: "insensitive" },
      },
      select: CATALOG_SELECT,
      take: 10,
    }),
  );
  return rows.map(formatCatalogCard);
}

/**
 * Candidates sharing a collector number AND a set printed total — the "138" and
 * the "132" of a printed "138/132" (Scanner V2 · set-code-optional matching).
 *
 * Name is deliberately NOT part of the SQL. The comparable name form is
 * foldName() (accent/punctuation/case stripped), which Postgres cannot express,
 * and a `name equals insensitive` predicate would silently drop the exact OCR
 * noise foldName exists to absorb ("Poke Ball" vs "Poké Ball"). So the query
 * narrows on the two numeric fields and the CALLER folds names over the handful
 * of rows that come back — one folding function for the whole codebase, as
 * foldName's own docstring requires.
 *
 * Cheap despite having no dedicated index: the planner serves this from the
 * existing [game, setCode, collectorNumber] index by scanning on
 * game+collectorNumber and filtering setPrintedSize (measured on production:
 * 6.9ms execution, ~130 rows examined for a common number). `take` is a safety
 * ceiling well above the worst real collision — the largest CN+printedTotal
 * group in the entire catalog is 10 rows.
 *
 * Collector-number tolerance matches catalogSearchBySetAndNumber(): both the
 * zero-padded and bare forms ("021" ⇄ "21").
 */
export async function catalogSearchByNumberAndPrintedTotal(
  collectorNumber: string,
  printedTotal: number,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const num = collectorNumber.split("/")[0].trim();
  const bare = num.replace(/^0+(?=\d)/, "");
  const numbers = bare !== num ? [num, bare] : [num];
  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where: {
        game: "POKEMON",
        collectorNumber: { in: numbers },
        setPrintedSize: printedTotal,
      },
      select: CATALOG_SELECT,
      take: 25,
    }),
  );
  return rows.map(formatCatalogCard);
}

/**
 * Local mirror of fetchAllPokemonPrintings(): every printing of an exact card
 * name, for visual comparison. Exact (case-insensitive) name match, capped at 20
 * — same contract as the live call, INCLUDING its newest-first ordering.
 *
 * That ordering is load-bearing, not cosmetic. For a name with more than 20
 * printings the cap decides which candidates the user is ever offered, so
 * ordering decides whether the right card is reachable at all. This originally
 * ordered by setName asc on the reasoning that >20 printings was rare; it isn't
 * (Vulpix has 35, Pikachu far more), and alphabetical ordering systematically
 * buried the NEWEST sets — the ones people actually scan. A real Vulpix from
 * Mega Evolution (me1-138) was cut at position 21+ behind "McDonald's
 * Collection 2016" and could not be picked. Newest-first restores parity with
 * the live path this replaced.
 *
 * Nulls sort last: a card whose set has no stored release date is still
 * reachable, but never displaces one whose recency we actually know.
 */
export async function catalogFetchAllPrintings(
  name: string,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where: { game: "POKEMON", name: { equals: name, mode: "insensitive" } },
      select: CATALOG_SELECT,
      orderBy: [
        { setReleaseDate: { sort: "desc", nulls: "last" } },
        { setName: "asc" },
        { collectorNumber: "asc" },
      ],
      take: 20,
    }),
  );
  return rows.map(formatCatalogCard);
}

/**
 * Local mirror of searchPokemonCards()'s fuzzy fallback: name contains, capped.
 * The caller (candidates.ts) picks the exact match or the first result from this
 * list exactly as it does for the live path, so the local list just has to
 * surface the same candidates.
 */
export async function catalogSearchByName(
  name: string,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where: { game: "POKEMON", name: { contains: name, mode: "insensitive" } },
      select: CATALOG_SELECT,
      orderBy: [{ name: "asc" }, { setName: "asc" }, { collectorNumber: "asc" }],
      take: 50,
    }),
  );
  return rows.map(formatCatalogCard);
}

/**
 * Local mirror of the SEARCH provider's Pokémon query (registry.ts).
 *
 * The scan path was repointed at this catalog in M4; search never was, and went
 * on asking api.pokemontcg.io for every keystroke. Measured on 2026-07-28 that
 * cost a p50 of 1903ms and a p95 of 7644ms against Scryfall's 27ms, with ~55% of
 * individual upstream requests returning HTTP 500 — while 452 of 452 results the
 * live API returned for a sample of ten names were already sitting in these rows.
 *
 * Deliberately mirrors the live query's SHAPE, not just its data:
 *  - name recall is a CONTAINS match, the local equivalent of the live
 *    `name:"*X*"` wildcard. Precision is match.ts's job, here as there — a
 *    narrower predicate would delete cards the ranker exists to order.
 *  - a number-ONLY query pushes the number down instead, matching both the
 *    zero-padded and bare spellings ("006" ⇄ "6"), exactly as the live provider
 *    does when it has no name to recall on.
 *
 * THE CAP IS DELIBERATELY WIDER THAN THE LIVE ONE, and this is the one place the
 * mirror should NOT copy the original. The live pageSize of 50 is a NETWORK
 * economy — 50 cards is a payload crossing the internet. Locally the cost is one
 * round trip regardless: measured against production, take=50 and take=250 both
 * ran in ~356ms, because the time is the trip, not the rows.
 *
 * Keeping 50 was measurably harmful. Both queries cap at 50 but ORDER
 * differently, so they select different 50s out of a larger pool — "Charizard"
 * has 108 catalog matches — and the repoint returned only 230 of the 400 cards
 * the live API did across eight sampled names. At take=250 the overlap is
 * 400/400: every card the live API would have surfaced is still reachable, plus
 * the ones its own cap was hiding. CardSearchService ranks and slices to 40
 * afterwards, so a collector sees no more rows — only better ones.
 *
 * Ordering is newest-first because the cap DECIDES REACHABILITY: whatever falls
 * past it cannot be found at all. That is the same lesson M7 learned on
 * catalogFetchAllPrintings, where alphabetical ordering buried a real Mega
 * Evolution Vulpix behind "McDonald's Collection 2016". Nulls sort last: a card
 * whose set has no stored release date stays reachable but never displaces one
 * whose recency we actually know.
 *
 * Returns [] for a genuine local miss. The CALLER decides what that means — and
 * it means "ask the live API", never "no such card".
 */
export async function catalogSearchForQuery(
  name: string,
  collectorNumber: string | null,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const where: Record<string, unknown> = { game: "POKEMON" };

  if (name) {
    where.name = { contains: name, mode: "insensitive" };
  } else if (collectorNumber) {
    const bare = collectorNumber.replace(/^0+(?=\d)/, "");
    where.collectorNumber = {
      in: bare !== collectorNumber ? [collectorNumber, bare] : [collectorNumber],
    };
  } else {
    // No name and no number is not a question. Answering it with 50 arbitrary
    // rows would be worse than answering it with nothing.
    return [];
  }

  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where,
      select: CATALOG_SELECT,
      orderBy: [
        { setReleaseDate: { sort: "desc", nulls: "last" } },
        { setName: "asc" },
        { collectorNumber: "asc" },
      ],
      take: CATALOG_SEARCH_TAKE,
    }),
  );
  return rows.map(formatCatalogCard);
}

/**
 * Local mirror of fetchPokemonCardById(): authoritative by-id re-fetch for the
 * selection save path. A miss returns null; the caller falls through to the live
 * by-id lookup. externalId is the shared join key, unique in catalog_cards.
 */
export async function catalogFetchCardById(
  externalId: string,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting | null> {
  const row = await dbRetry(() =>
    db.catalogCard.findUnique({
      where: { externalId },
      select: CATALOG_SELECT,
    }),
  );
  return row ? formatCatalogCard(row) : null;
}
