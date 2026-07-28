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

import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";
import {
  fetchAllSets,
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

/** Bounded batch, rate-respecting delay between upstream calls. */
const PRICE_MAX_CARDS_PER_RUN = 300;
const PRICE_DELAY_MS = 150;

/** The prisma surface these phases touch, declared structurally so tests inject a
 *  fake (the DB is production — see aura-database-topology; tests never touch it). */
export interface CatalogRefreshDb extends CatalogSyncDb {
  catalogCard: CatalogSyncDb["catalogCard"] & {
    findMany(args: unknown): Promise<any[]>;
    update(args: unknown): Promise<unknown>;
  };
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
  batchSize: number;
  refreshed: number;
  skipped: number;
  failed: number;
}

export async function refreshCatalogPrices(
  db: CatalogRefreshDb,
  deadline: number,
  dryRun: boolean,
): Promise<CatalogPricesReport> {
  let rows: { externalId: string }[];
  try {
    // Stalest first (never-priced rows lead), bounded per run so repeated runs
    // sweep the catalog over time without one run fanning out unbounded.
    rows = await db.catalogCard.findMany({
      where: { game: "POKEMON" },
      select: { externalId: true, priceUpdatedAt: true },
      orderBy: [{ priceUpdatedAt: { sort: "asc", nulls: "first" } }],
      take: PRICE_MAX_CARDS_PER_RUN,
    });
  } catch (err) {
    console.error("[CRON] catalog price candidate query failed:", errMsg(err));
    return {
      status: "failed", examined: 0, total: 0, error: errMsg(err),
      batchSize: 0, refreshed: 0, skipped: 0, failed: 0,
    };
  }

  let examined = 0;
  let refreshed = 0;
  let skipped = 0;
  let failed = 0;

  for (const row of rows) {
    if (outOfTime(deadline)) break;
    examined++;

    // Lenient by-id lookup: null on ANY upstream failure (a background job wants
    // to skip a card, not fail over it). The batch profile makes that give-up
    // fast — a card we skip today is simply first in line tomorrow.
    const ext = await getPokemonCardById(row.externalId, { ...BATCH_FETCH, deadline });
    const price = ext ? formatPokemonCard(ext).price : null;

    // Truth boundary: a non-answer NEVER overwrites the stored price.
    if (!price || price.marketPrice === undefined || price.marketPrice === null) {
      skipped++;
      if (PRICE_DELAY_MS && !outOfTime(deadline)) await sleep(PRICE_DELAY_MS);
      continue;
    }

    if (dryRun) {
      refreshed++; // would update
      if (PRICE_DELAY_MS && !outOfTime(deadline)) await sleep(PRICE_DELAY_MS);
      continue;
    }

    try {
      await db.catalogCard.update({
        where: { externalId: row.externalId },
        data: {
          marketPrice: price.marketPrice,
          lowPrice: price.lowPrice ?? null,
          midPrice: price.midPrice ?? null,
          highPrice: price.highPrice ?? null,
          priceUpdatedAt: new Date(),
        },
      });
      refreshed++;
    } catch (err) {
      // One bad update never fails the batch — the row keeps its prior price.
      failed++;
      console.error(`[CRON] catalog price update failed for ${row.externalId}: ${errMsg(err)}`);
    }

    if (PRICE_DELAY_MS && !outOfTime(deadline)) await sleep(PRICE_DELAY_MS);
  }

  return {
    status: phaseStatus(examined, rows.length),
    examined,
    total: rows.length,
    batchSize: rows.length,
    refreshed,
    skipped,
    failed,
  };
}
