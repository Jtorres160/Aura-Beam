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
 * same shape and the same defaults — notably `marketPrice` coalesces to 0 just
 * as extractPokemonPrice() does, so a null-priced catalog row and a live-fetched
 * unpriced card both surface `price.marketPrice === 0`.
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
      marketPrice: row.marketPrice ?? 0,
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
 * Local mirror of fetchAllPokemonPrintings(): every printing of an exact card
 * name, for visual comparison. Exact (case-insensitive) name match, capped at 20
 * — same contract as the live call. The live call orders by release date, which
 * the catalog does not store; ordering only decides WHICH 20 survive the cap for
 * a name with more than 20 printings (rare), and never affects an exact-name
 * membership test, so a stable set/number ordering is used instead.
 */
export async function catalogFetchAllPrintings(
  name: string,
  db: CatalogDb = defaultDb,
): Promise<CandidatePrinting[]> {
  const rows = await dbRetry(() =>
    db.catalogCard.findMany({
      where: { game: "POKEMON", name: { equals: name, mode: "insensitive" } },
      select: CATALOG_SELECT,
      orderBy: [{ setName: "asc" }, { collectorNumber: "asc" }],
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
