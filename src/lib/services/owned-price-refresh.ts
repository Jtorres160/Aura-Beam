// ═══════════════════════════════════════════════════════════════════════════
// Owned + watched card price refresh
// ═══════════════════════════════════════════════════════════════════════════
// The original /api/cron/update-prices workload, lifted out of the route handler
// so it can share one invocation (and one clock) with the catalog phases without
// the two jobs' internals tangling. This one serves a COLLECTOR'S ARCHIVE —
// collection value, the portfolio chart, and price alerts — which is why it runs
// first and gets the largest share of the run.
//
// Three defects from the original are fixed here, all of the same family: the job
// claimed more than it did.
//
//   1. NO DEADLINE. It processed up to 250 cards with no clock at all, and the
//      route exported no maxDuration, so it ran under the platform default. Once
//      PR #2 gave each fetch up to 16s of retries, a single degraded upstream
//      window could stall the whole job.
//   2. `card.game === "Pokemon"` NEVER MATCHED. Production stores "POKEMON"
//      (verified: 36 POKEMON / 84 MTG / 11 YUGIOH rows). Every Pokémon card
//      silently fell through all three branches, contributed nothing, and the run
//      still reported success. Matching is now case-insensitive.
//   3. `success: true` regardless of how much was actually done. The phase now
//      reports its own completeness (PhaseStatus).

import {
  BATCH_FETCH,
  outOfTime,
  phaseStatus,
  type PhaseReport,
} from "@/lib/services/cron-budget";
import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";
import { getScryfallCardById, formatScryfallCard } from "@/lib/services/scryfall";
import { getYugiohCardById, formatYugiohCard } from "@/lib/services/yugioh";
import { errMsg } from "@/lib/services/catalog-sync";

/** Bounded batch so one run never fans out to an unbounded number of calls. */
const MAX_CARDS_PER_RUN = 250;

/** Structural seam over the prisma models this phase touches, so tests inject a
 *  fake (the DB is production — see aura-database-topology). */
export interface OwnedPriceDb {
  collectionCard: { findMany(args: unknown): Promise<any[]> };
  watchlist: { findMany(args: unknown): Promise<any[]>; update(args: unknown): Promise<unknown> };
  cardPrice: { findMany(args: unknown): Promise<any[]>; upsert(args: unknown): Promise<unknown> };
  priceHistory: { create(args: unknown): Promise<unknown> };
  notification: { create(args: unknown): Promise<unknown> };
}

export interface OwnedPricesReport extends PhaseReport {
  updated: number;
  alertsTriggered: number;
  /** Cards whose source did not answer. Skipped, never zeroed. */
  skipped: number;
}

/**
 * Normalize the stored game string to the three games we price.
 *
 * Case-insensitive on purpose: rows have been written as both "POKEMON" and
 * "Pokemon" over the project's life, and an exact-match comparison here is
 * precisely the bug that silently skipped every Pokémon card. A game we don't
 * recognise returns null and is counted as skipped — never guessed at.
 */
export function normalizeGame(game: string | null | undefined): "POKEMON" | "MTG" | "YUGIOH" | null {
  const g = String(game ?? "").trim().toUpperCase();
  if (g === "POKEMON") return "POKEMON";
  if (g === "MTG" || g === "MAGIC") return "MTG";
  if (g === "YUGIOH" || g === "YU-GI-OH" || g === "YGO") return "YUGIOH";
  return null;
}

export async function refreshOwnedPrices(
  db: OwnedPriceDb,
  deadline: number,
  dryRun: boolean,
): Promise<OwnedPricesReport> {
  const nothing = { updated: 0, alertsTriggered: 0, skipped: 0 };

  let ownedCardLinks: any[];
  let activeWatchlists: any[];
  try {
    [ownedCardLinks, activeWatchlists] = await Promise.all([
      db.collectionCard.findMany({
        distinct: ["cardId"],
        select: { card: { select: { id: true, externalId: true, game: true } } },
      }),
      db.watchlist.findMany({
        where: {
          alertEnabled: true,
          OR: [{ alertAbove: { not: null } }, { alertBelow: { not: null } }],
        },
        include: { card: true, user: true },
      }),
    ]);
  } catch (err) {
    console.error("[CRON] owned-price candidate query failed:", errMsg(err));
    return { ...nothing, status: "failed", examined: 0, total: 0, error: errMsg(err) };
  }

  // Alerts to evaluate, grouped by card.
  const watchlistsByCard = activeWatchlists.reduce((acc: Record<string, any[]>, w: any) => {
    (acc[w.cardId] ??= []).push(w);
    return acc;
  }, {} as Record<string, any[]>);

  // Union of card records to refresh, de-duplicated by id.
  const cardsById = new Map<string, { id: string; externalId: string | null; game: string }>();
  for (const link of ownedCardLinks) {
    if (link.card) cardsById.set(link.card.id, link.card);
  }
  for (const w of activeWatchlists) {
    cardsById.set(w.card.id, { id: w.card.id, externalId: w.card.externalId, game: w.card.game });
  }
  if (cardsById.size === 0) {
    return { ...nothing, status: "complete", examined: 0, total: 0 };
  }

  // Prioritize the stalest prices so repeated runs make steady progress.
  const priceRows = await db.cardPrice.findMany({
    where: { cardId: { in: Array.from(cardsById.keys()) } },
    select: { cardId: true, lastUpdated: true },
  });
  const lastUpdatedByCard = new Map<string, Date>(
    priceRows.map((p: any) => [p.cardId, p.lastUpdated]),
  );

  const orderedCards = Array.from(cardsById.values())
    .filter((c) => c.externalId)
    .sort((a, b) => {
      // Never-priced cards first, then oldest lastUpdated first.
      const ta = lastUpdatedByCard.get(a.id)?.getTime() ?? 0;
      const tb = lastUpdatedByCard.get(b.id)?.getTime() ?? 0;
      return ta - tb;
    })
    .slice(0, MAX_CARDS_PER_RUN);

  let examined = 0;
  let updated = 0;
  let skipped = 0;
  let alertsTriggered = 0;
  const budget = { ...BATCH_FETCH, deadline };

  for (const card of orderedCards) {
    if (outOfTime(deadline)) break;
    if (!card.externalId) continue;
    examined++;

    let newPriceData: { marketPrice: number } | null = null;
    try {
      const game = normalizeGame(card.game);
      if (game === "POKEMON") {
        const ext = await getPokemonCardById(card.externalId, budget);
        if (ext) newPriceData = formatPokemonCard(ext).price;
      } else if (game === "MTG") {
        const ext = await getScryfallCardById(card.externalId, budget);
        if (ext) newPriceData = formatScryfallCard(ext).price;
      } else if (game === "YUGIOH") {
        const ext = await getYugiohCardById(card.externalId, budget);
        if (ext) newPriceData = formatYugiohCard(ext).price;
      }
    } catch (err) {
      console.error(`[CRON] Failed to fetch external price for card ${card.id}:`, err);
      skipped++;
      continue;
    }

    // Truth boundary: a non-answer never overwrites a stored price.
    if (!newPriceData || newPriceData.marketPrice === undefined || newPriceData.marketPrice === null) {
      skipped++;
      continue;
    }

    const newMarketPrice = newPriceData.marketPrice;
    if (dryRun) {
      updated++; // would update
      continue;
    }

    await db.cardPrice.upsert({
      where: { cardId: card.id },
      update: { marketPrice: newMarketPrice, lastUpdated: new Date() },
      create: { cardId: card.id, marketPrice: newMarketPrice },
    });
    // Recorded history is what powers real price movers — never simulated.
    await db.priceHistory.create({
      data: { cardId: card.id, marketPrice: newMarketPrice },
    });
    updated++;

    for (const watchlist of watchlistsByCard[card.id] ?? []) {
      let alertMessage = "";
      if (watchlist.alertAbove && newMarketPrice >= watchlist.alertAbove) {
        alertMessage = `${watchlist.card.name} has risen above $${watchlist.alertAbove.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
      } else if (watchlist.alertBelow && newMarketPrice <= watchlist.alertBelow) {
        alertMessage = `${watchlist.card.name} has dropped below $${watchlist.alertBelow.toFixed(2)}! Current price: $${newMarketPrice.toFixed(2)}`;
      }
      if (!alertMessage) continue;

      await db.notification.create({
        data: {
          userId: watchlist.userId,
          title: "Price Alert Triggered",
          message: alertMessage,
          type: "price_alert",
          data: JSON.stringify({ cardId: card.id, newPrice: newMarketPrice }),
        },
      });
      // Disable the alert so it doesn't fire endlessly.
      await db.watchlist.update({ where: { id: watchlist.id }, data: { alertEnabled: false } });
      alertsTriggered++;
    }
  }

  return {
    status: phaseStatus(examined, orderedCards.length),
    examined,
    total: orderedCards.length,
    updated,
    skipped,
    alertsTriggered,
  };
}
