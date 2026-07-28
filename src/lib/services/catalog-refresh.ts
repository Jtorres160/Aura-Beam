// ═══════════════════════════════════════════════════════════════════════════
// Catalog freshness phases (Scanner V2 · M-CATALOG · M5)
// ═══════════════════════════════════════════════════════════════════════════
// The two phases that keep catalog_cards fresh, lifted OUT of the route handler
// so they stay independently testable now that they share an invocation with the
// owned-price refresh (Hobby plan allows 2 cron entries; see vercel.json).
//
// They are still conceptually a separate job from owned-price refresh — that one
// serves a collector's archive, these serve the scanner's reference mirror — so
// they keep their own module, their own tests, and their own phase reports. All
// they share is a clock.
//
// Truth boundary (AGENTS.md), enforced in both phases:
//   • A failed fetch or an absent price NEVER nulls or zeroes a stored price.
//   • A phase that ran out of clock says so (PhaseStatus), so an empty finding is
//     never mistaken for a finding of empty.

import { formatPokemonCard } from "@/lib/services/pokemon";
import type { PrintingPrice } from "@/lib/scanner/evidence";
import {
  fetchAllSets,
  fetchSetCards,
  syncSet,
  findSetSyncState,
  setNeedsSync,
  classifyFailure,
  errMsg,
  sleep,
  type CatalogSyncDb,
} from "@/lib/services/catalog-sync";
import {
  BATCH_FETCH,
  SET_LIST_FETCH,
  outOfTime,
  phaseStatus,
  type PhaseReport,
} from "@/lib/services/cron-budget";

/** New sets are rare; a small cap per run is plenty and keeps the window short. */
const NEW_SET_MAX_PER_RUN = 3;
const NEW_SET_DELAY_MS = 250;

// ─── Price sweep sizing ──────────────────────────────────────────────────────
// The sweep refreshes whole SETS, not individual cards, because the upstream
// charges per REQUEST and a set costs the same as a card:
//
//     by-id, one card per request   ~780ms/card → 23 cards per 18s window
//     q=set.id:X&pageSize=250       a whole set → 100-250 cards in ~3-7s
//
// Measured against production on 2026-07-28: sv3 returned 230 cards in 6.7s and
// all 230 carried tcgplayer prices; base1 102 in 2.9s. The bulk response already
// carries everything formatPokemonCard reads (CARD_SELECT), so this is the same
// data by a cheaper route — roughly 50 cards/second instead of 1.3.
//
// That is the difference between a catalog that rotates and one that does not.
// At 23 cards/run a full sweep of the 20,479-row catalog takes ~890 days, which
// is why every stored price still read 2026-07-21 a week after the cron shipped.
// Per set it is ~11 days, inside the same 18s window and the same Hobby limits.
//
// It is NOT daily freshness, and nothing here should be read as promising it:
// 174 sets at ~4.9s each is ~14 minutes of upstream time, against the ~45s/day
// this plan allows. Closing that gap is an infrastructure decision, not a code
// one. What the code owes is honest rotation and an accurate priceCheckedAt.

/** Sets to attempt per run. A ceiling, not a target — the deadline usually binds
 *  first. Set high enough that a run of small/cached sets can use its whole
 *  window rather than idling. */
const PRICE_MAX_SETS_PER_RUN = 12;

/** How deep to look for the stalest sets. Because a refreshed set leaves all its
 *  cards sharing one fresh timestamp, stalest-card order naturally clusters by
 *  set, so scanning this many cards yields far more distinct sets than a run can
 *  use (~118 cards/set on average → ~17 sets from 2000 rows). Deliberately more
 *  than PRICE_MAX_SETS_PER_RUN needs, so a set whose cards are unevenly stale
 *  cannot hide the next set behind it. */
const PRICE_CANDIDATE_SCAN = 2_000;

/** Rows per write transaction. A set is one upstream request but up to ~250
 *  row updates, and issuing those one-by-one would spend the window on database
 *  round trips instead of cards. Chunked so one transaction never grows
 *  unbounded on a large set. */
const PRICE_UPDATE_CHUNK = 100;

/** Rate-respecting delay between upstream set requests. */
const PRICE_DELAY_MS = 150;

/** The prisma surface these phases touch, declared structurally so tests inject a
 *  fake (the DB is production — see aura-database-topology; tests never touch it). */
export interface CatalogRefreshDb extends CatalogSyncDb {
  catalogCard: CatalogSyncDb["catalogCard"] & {
    findMany(args: unknown): Promise<any[]>;
    update(args: unknown): Promise<unknown>;
    updateMany(args: unknown): Promise<unknown>;
  };
  /** Prisma's batch executor. Present so a set's ~250 row updates cost a handful
   *  of round trips rather than 250 — the window is short and the database is
   *  remote, so per-row chatter is the difference between finishing a set and
   *  timing out halfway through one. */
  $transaction(ops: unknown[]): Promise<unknown[]>;
}

// ─── Phase: new-set / changed-set sync ───────────────────────────────────────

export interface NewSetsReport extends PhaseReport {
  /** Sets found to be missing or changed. Meaningful ONLY when status is
   *  "complete" — otherwise it is a prefix of an unfinished scan. */
  detected: string[];
  wouldSync?: string[];
  imported: number;
  synced?: { setId: string; upserted: number; failed: number; incomplete?: boolean }[];
  failedSets?: { setId: string; reason: string }[];
}

export async function syncNewSets(
  db: CatalogRefreshDb,
  deadline: number,
  dryRun: boolean,
): Promise<NewSetsReport> {
  const empty = { detected: [] as string[], imported: 0 };

  let sets;
  try {
    sets = await fetchAllSets({ ...SET_LIST_FETCH, deadline });
  } catch (err) {
    // Could not enumerate at all. This is "failed", never an empty `detected` —
    // reporting zero detected sets here would claim the catalog is current on the
    // strength of a question we never got to ask.
    console.error("[CRON] new-set enumeration failed:", errMsg(err));
    return { ...empty, status: "failed", examined: 0, total: 0, error: errMsg(err) };
  }

  // Detect which sets are missing or changed. One indexed findFirst per set.
  const needy: { id: string; releaseDate: string | null }[] = [];
  let examined = 0;
  for (const meta of sets) {
    if (outOfTime(deadline)) break;
    const state = await findSetSyncState(db, meta.id);
    examined++;
    if (setNeedsSync(meta, state)) needy.push({ id: meta.id, releaseDate: meta.releaseDate });
  }

  // Newest release first — a just-released set is what collectors are scanning.
  needy.sort((a, b) => String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? "")));
  const detected = needy.map((n) => n.id);
  const status = phaseStatus(examined, sets.length);

  if (dryRun) {
    return {
      status,
      examined,
      total: sets.length,
      detected,
      wouldSync: detected.slice(0, NEW_SET_MAX_PER_RUN),
      imported: 0,
    };
  }

  let imported = 0;
  const synced: NonNullable<NewSetsReport["synced"]> = [];
  const failedSets: NonNullable<NewSetsReport["failedSets"]> = [];
  for (const { id } of needy.slice(0, NEW_SET_MAX_PER_RUN)) {
    if (outOfTime(deadline)) break;
    try {
      // resume:true so a set the clock cut short last run CONTINUES rather than
      // restarting from card one — the only way a ~250-card set can ever finish
      // inside a serverless window. Already-stored cards are skipped, so static
      // fields of a changed set are still refreshed for every card not yet seen.
      const r = await syncSet(db, id, {
        resume: true,
        delayMs: NEW_SET_DELAY_MS,
        budget: { ...BATCH_FETCH, deadline },
      });
      imported += r.upserted;
      synced.push({ setId: id, upserted: r.upserted, failed: r.failed, incomplete: r.incomplete });
    } catch (err) {
      failedSets.push({ setId: id, reason: classifyFailure(errMsg(err)) });
      console.error(`[CRON] new-set sync failed for ${id}: ${errMsg(err)}`);
    }
  }

  return { status, examined, total: sets.length, detected, imported, synced, failedSets };
}

// ─── Phase: catalog price refresh ────────────────────────────────────────────

export interface CatalogPricesReport extends PhaseReport {
  /** Sets this run intended to sweep — `examined`/`total` count SETS, so that a
   *  partial run reads as "3 of 12 sets", the unit the sweep actually works in. */
  batchSize: number;
  /** Cards whose stored price was replaced with a real upstream price. */
  refreshed: number;
  /** Cards upstream had no price for. Their price is left untouched; only
   *  priceCheckedAt moves, so they stop blocking the rotation. */
  skipped: number;
  /** Cards whose write failed. They keep their prior price AND their prior
   *  priceCheckedAt, so they are retried rather than silently passed over. */
  failed: number;
  /** Sets whose card list could not be fetched at all. Distinct from a set that
   *  answered with no prices: one is a hole, the other is a reading. */
  failedSets?: { setId: string; reason: string }[];
}

/**
 * The set id embedded in a catalog externalId — the "sv3" of "sv3-125".
 *
 * Safe because the catalog stores the Pokémon API's own card ids, which are
 * `${set.id}-${number}`, and no set id contains a hyphen. Verified against
 * production before this code was written: all 20,479 rows yield exactly 174
 * distinct prefixes and every one is a known set id. `existingIdsForSet` already
 * depends on the same convention, so this shares an assumption rather than
 * introducing one.
 *
 * Returns null rather than a guess for an id that doesn't fit the shape — such a
 * row is simply not swept, never swept as the wrong set.
 */
export function setIdFromExternalId(externalId: string): string | null {
  const i = externalId.indexOf("-");
  if (i <= 0 || i === externalId.length - 1) return null;
  return externalId.slice(0, i);
}

/**
 * Refresh catalog prices one SET at a time, stalest set first.
 *
 * Truth boundary, unchanged from the per-card sweep it replaces and the reason
 * the two timestamps are separate:
 *   • A set whose card list can't be fetched updates NOTHING — no price, no
 *     timestamp. It is reported as a failed set and retried next run.
 *   • A card the set listing carries no price for keeps its stored price. Only
 *     priceCheckedAt moves, recording that we asked and got no answer.
 *   • priceUpdatedAt moves ONLY alongside a real price, so the freshness a
 *     collector is shown never claims a check it didn't get an answer to.
 */
export async function refreshCatalogPrices(
  db: CatalogRefreshDb,
  deadline: number,
  dryRun: boolean,
): Promise<CatalogPricesReport> {
  const nothing = { batchSize: 0, refreshed: 0, skipped: 0, failed: 0 };

  let candidates: { externalId: string }[];
  try {
    // Stalest-CHECKED first, never-checked leading. Ordering by priceUpdatedAt
    // here is what starved the old sweep: a card upstream has no price for keeps
    // that timestamp forever and returns to the head of the queue every run.
    candidates = await db.catalogCard.findMany({
      where: { game: "POKEMON" },
      select: { externalId: true, priceCheckedAt: true },
      orderBy: [{ priceCheckedAt: { sort: "asc", nulls: "first" } }],
      take: PRICE_CANDIDATE_SCAN,
    });
  } catch (err) {
    console.error("[CRON] catalog price candidate query failed:", errMsg(err));
    return { ...nothing, status: "failed", examined: 0, total: 0, error: errMsg(err) };
  }

  // Distinct sets in staleness order. A Map keeps first-seen order, so the set
  // holding the single stalest card is swept first.
  const setIds: string[] = [];
  const seen = new Set<string>();
  for (const { externalId } of candidates) {
    const setId = setIdFromExternalId(externalId);
    if (!setId || seen.has(setId)) continue;
    seen.add(setId);
    setIds.push(setId);
    if (setIds.length >= PRICE_MAX_SETS_PER_RUN) break;
  }

  let examined = 0;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;
  const failedSets: NonNullable<CatalogPricesReport["failedSets"]> = [];

  for (const setId of setIds) {
    if (outOfTime(deadline)) break;

    let cards: any[];
    try {
      // One request per ~250 cards, on the batch profile: give up fast and let
      // the next run pick the set back up, rather than spend the whole window
      // rescuing one request nobody is waiting on.
      cards = await fetchSetCards(setId, {
        delayMs: PRICE_DELAY_MS,
        budget: { ...BATCH_FETCH, deadline },
      });
    } catch (err) {
      // A set we could not list teaches us nothing about its prices. Nothing is
      // written — not even priceCheckedAt — so it stays at the head of the
      // rotation and is retried, rather than being marked as swept.
      failedSets.push({ setId, reason: classifyFailure(errMsg(err)) });
      console.error(`[CRON] catalog price fetch failed for set ${setId}: ${errMsg(err)}`);
      continue;
    }

    // The set answered. Count it as examined even if every card in it turns out
    // to be unpriced — that is a reading, not a hole.
    examined++;

    const priced: { externalId: string; price: PrintingPrice }[] = [];
    const unpriced: string[] = [];
    for (const card of cards) {
      const p = formatPokemonCard(card).price;
      if (p && p.marketPrice !== undefined && p.marketPrice !== null) {
        priced.push({ externalId: card.id, price: p });
      } else {
        unpriced.push(card.id);
      }
    }

    if (dryRun) {
      refreshed += priced.length;
      skipped += unpriced.length;
      continue;
    }

    const checkedAt = new Date();

    // Priced cards: price + both timestamps, chunked so one transaction never
    // grows unbounded on a 250-card set.
    for (let i = 0; i < priced.length; i += PRICE_UPDATE_CHUNK) {
      if (outOfTime(deadline)) break;
      const chunk = priced.slice(i, i + PRICE_UPDATE_CHUNK);
      try {
        await db.$transaction(
          chunk.map(({ externalId, price }) =>
            db.catalogCard.update({
              where: { externalId },
              data: {
                marketPrice: price.marketPrice,
                lowPrice: price.lowPrice ?? null,
                midPrice: price.midPrice ?? null,
                highPrice: price.highPrice ?? null,
                priceUpdatedAt: checkedAt,
                priceCheckedAt: checkedAt,
              },
            }),
          ),
        );
        refreshed += chunk.length;
      } catch (err) {
        // A failed chunk leaves its rows entirely untouched — prior price, prior
        // priceCheckedAt — so they are retried rather than passed over.
        failed += chunk.length;
        console.error(`[CRON] catalog price update failed for set ${setId}: ${errMsg(err)}`);
      }
    }

    // Unpriced cards: record only that we ASKED. The stored price is not touched,
    // and priceUpdatedAt is not touched, so nothing claims a freshness we don't
    // have — but the rotation still advances past them.
    if (unpriced.length > 0 && !outOfTime(deadline)) {
      try {
        await db.catalogCard.updateMany({
          where: { externalId: { in: unpriced } },
          data: { priceCheckedAt: checkedAt },
        });
        skipped += unpriced.length;
      } catch (err) {
        failed += unpriced.length;
        console.error(`[CRON] catalog priceCheckedAt update failed for set ${setId}: ${errMsg(err)}`);
      }
    }
  }

  // `examined` counts sets that ANSWERED, so a set that failed to list leaves the
  // phase short of its plan and the status reads incomplete — correct, though the
  // "budget" in incomplete_budget is then the wrong cause. `failedSets` carries
  // the real reason, which is why it is reported rather than folded into a count.
  return {
    status: phaseStatus(examined, setIds.length),
    examined,
    total: setIds.length,
    batchSize: setIds.length,
    refreshed,
    skipped,
    failed,
    ...(failedSets.length > 0 ? { failedSets } : {}),
  };
}
