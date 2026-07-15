// ─── Local catalog provider (Phase 5.12A) ───────────────────────────────────
// Aura's own Prisma catalog. Queried alongside the remote card databases and
// ranked first, because a local row carries our id and our price history.

import { dbRetry, prisma } from "@/lib/prisma";
import type { GameId } from "@/lib/scanner/evidence";
import { normalizeGame } from "@/lib/search/identity";
import type { ParsedQuery } from "@/lib/search/query";
import type { CardSearchResult } from "@/lib/search/types";
import { SearchProviderError } from "@/lib/search/providers/http";

interface LocalSearchArgs {
  parsed: ParsedQuery;
  /** Restrict to one game, or search the whole catalog when null. */
  game: GameId | null;
  limit: number;
}

/**
 * Search the local catalog.
 *
 * Case sensitivity: `contains` on PostgreSQL is CASE-SENSITIVE unless told
 * otherwise, so the previous query matched "Charizard" and missed "charizard"
 * entirely. `mode: "insensitive"` is what a collector actually expects.
 *
 * Throws SearchProviderError on a database failure rather than returning [] —
 * an unreachable database is not an empty catalog.
 */
export async function searchLocalCards({
  parsed,
  game,
  limit,
}: LocalSearchArgs): Promise<CardSearchResult[]> {
  const where: Record<string, unknown> = {};
  if (game) where.game = game;

  const or: Record<string, unknown>[] = [];
  if (parsed.name) {
    or.push({ name: { contains: parsed.name, mode: "insensitive" } });
    or.push({ setName: { contains: parsed.name, mode: "insensitive" } });
  }
  if (parsed.collectorNumber) {
    or.push({ collectorNumber: { contains: parsed.collectorNumber, mode: "insensitive" } });
  }
  if (or.length > 0) where.OR = or;

  let rows;
  try {
    rows = await dbRetry(() =>
      prisma.card.findMany({
        where,
        include: { prices: true },
        orderBy: { name: "asc" },
        take: limit,
      }),
    );
  } catch (err: any) {
    throw new SearchProviderError("unexpected", err?.message ?? "Local catalog unavailable");
  }

  return rows.flatMap((row): CardSearchResult[] => {
    // A row whose game column is unrecognized can't be typed as a GameId, and
    // guessing one would be a fabrication. Skip it rather than mislabel it.
    const rowGame = normalizeGame(row.game);
    if (!rowGame) return [];

    const market = row.prices?.marketPrice;
    return [
      {
        // ROUTABLE id — /cards/[id] resolves a local row by its primary key.
        id: row.id,
        game: rowGame,
        name: row.name,
        set: {
          name: row.setName || "Unknown Set",
          code: row.setCode ?? null,
          // The catalog stores no printed set size (Card has no such column), so
          // this is null — "we never recorded it", not "this set has none". The
          // ranker reads that as neutral and will not hold it against the row.
          printedSize: null,
        },
        collectorNumber: row.collectorNumber ?? null,
        rarity: row.rarity || "Unknown",
        artwork: {
          imageUrl: row.imageUrl ?? null,
          thumbnailUrl: row.thumbnailUrl ?? row.imageUrl ?? null,
        },
        metadata: {
          source: "local",
          externalId: row.externalId ?? null,
          localId: row.id,
          marketPrice: typeof market === "number" && market > 0 ? market : null,
        },
      },
    ];
  });
}
