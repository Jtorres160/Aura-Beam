import { NextResponse } from "next/server";
import { prisma, dbRetry } from "@/lib/prisma";
import { getPokemonCardById, formatPokemonCard } from "@/lib/services/pokemon";
import {
  fetchAllSets,
  syncSet,
  findSetSyncState,
  setNeedsSync,
  classifyFailure,
  errMsg,
  sleep,
} from "@/lib/services/catalog-sync";

// ─── Catalog freshness cron (Scanner V2 · M-CATALOG · M5) ────────────────────
// Keeps catalog_cards fresh without a human re-running scripts/build-catalog.mjs.
// Sibling to update-prices: that cron refreshes Card/CardPrice for OWNED + WATCHED
// cards (collection value + alerts); it never touches catalog_cards, which is the
// reference mirror the scanner reads. So catalog freshness needs its own job — this
// one — sharing update-prices' shape exactly: mandatory CRON_SECRET guard, a bounded
// per-run batch, and per-item failure isolation.
//
// Two phases, each self-contained (one phase failing never kills the other, and a
// single bad card/set never fails the run — the AGENTS.md truth boundary is what
// lets this run unattended):
//   1. New-set sync — sets missing from the catalog, or reported changed upstream
//      (set.updatedAt newer than what we stored), imported through the SAME
//      catalog-sync core scripts/build-catalog.mjs uses (never a reimplementation).
//   2. Price refresh — re-fetch prices for the stalest catalog rows and update in
//      place. A failed fetch leaves the existing (stale) price ALONE: never nulled,
//      never zeroed by a non-answer. A stale/missing price degrades a scan to the
//      live path; it never fails one.
//
// NOTE: intentionally NOT wired in vercel.json yet — same discipline as
// CATALOG_LOCAL_ENABLED. Build + verify; the schedule goes live only on explicit
// sign-off (see docs/scanner-v2/M-CATALOG-M5-report.md for the entry to add).

// Give the platform room; each phase self-limits well under this via the budget.
export const maxDuration = 60;

// Wall-clock budget: stop LAUNCHING new external work past this so we never blow
// the function limit. Whatever's left is simply picked up next run (rows are
// processed stalest-first, so repeated runs make steady, resumable progress).
const TOTAL_BUDGET_MS = 55_000;

// New-set sync — new sets are rare, so a small cap per run is plenty.
const NEW_SET_MAX_PER_RUN = 3;
const NEW_SET_DELAY_MS = 250;

// Price refresh — bounded batch, rate-respecting delay between upstream calls.
const PRICE_MAX_CARDS_PER_RUN = 300;
const PRICE_DELAY_MS = 150;

// Cron retry: lighter than the manual builder's (6×) because we're inside a
// function budget — a set that stays flaky is retried on the next scheduled run.
const CRON_RETRY = { tries: 3, baseMs: 1500 };

export async function GET(request: Request) {
  // Mandatory cron-secret guard (Vercel's recommended pattern, matching the other
  // two crons): a missing OR mismatched secret returns 401. CRON_SECRET must be
  // set in every deployed environment; Vercel sends `Authorization: Bearer
  // $CRON_SECRET` on its own scheduled invocations, so the real cron passes and
  // everyone else is rejected.
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // ?dry=1 → verify the pipeline (reads + upstream fetches) WITHOUT any catalog
  // writes: reports what WOULD change. Lets the route be exercised without the
  // production writes M5 is holding for sign-off.
  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const deadline = Date.now() + TOTAL_BUDGET_MS;

  console.log(`[CRON] refresh-catalog starting${dryRun ? " (dry run)" : ""}...`);

  try {
    const newSets = await syncNewSets(deadline, dryRun);
    const prices = await refreshPrices(deadline, dryRun);

    console.log(
      `[CRON] refresh-catalog done — new-set imported ${newSets.imported ?? 0}, prices refreshed ${prices.refreshed ?? 0}.`,
    );
    return NextResponse.json({ success: true, dryRun, newSets, prices });
  } catch (error) {
    // Only reached on a truly unexpected error; each phase already isolates its own.
    console.error("[CRON] refresh-catalog fatal:", error);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}

// ─── Phase 1: new-set / changed-set sync ─────────────────────────────────────
async function syncNewSets(deadline: number, dryRun: boolean) {
  try {
    const sets = await fetchAllSets(CRON_RETRY); // throws → phase-level error, prices still run

    // Detect which sets are missing or changed. Cheap indexed findFirst per set;
    // completes well within budget on a normal run (guard is a safety net).
    const needy: { id: string; releaseDate: string | null }[] = [];
    for (const meta of sets) {
      if (Date.now() > deadline) break;
      const state = await dbRetry(() => findSetSyncState(prisma, meta.id));
      if (setNeedsSync(meta, state)) needy.push({ id: meta.id, releaseDate: meta.releaseDate });
    }
    // Newest release first — a just-released set is what collectors are scanning.
    needy.sort((a, b) => String(b.releaseDate ?? "").localeCompare(String(a.releaseDate ?? "")));
    const detected = needy.map((n) => n.id);

    if (dryRun) {
      return { detected, wouldSync: detected.slice(0, NEW_SET_MAX_PER_RUN), imported: 0, dryRun: true };
    }

    let imported = 0;
    const synced: { setId: string; upserted: number; failed: number }[] = [];
    const failedSets: { setId: string; reason: string }[] = [];
    for (const { id } of needy.slice(0, NEW_SET_MAX_PER_RUN)) {
      if (Date.now() > deadline) break;
      try {
        // resume:false → re-upsert existing rows too, so a CHANGED set's static
        // fields + prices are refreshed, not just brand-new cards inserted.
        const r = await syncSet(prisma, id, { resume: false, delayMs: NEW_SET_DELAY_MS, retry: CRON_RETRY });
        imported += r.upserted;
        synced.push({ setId: id, upserted: r.upserted, failed: r.failed });
      } catch (err) {
        // A set that can't be listed is logged and skipped — never fails the run.
        failedSets.push({ setId: id, reason: classifyFailure(errMsg(err)) });
        console.error(`[CRON] new-set sync failed for ${id}: ${errMsg(err)}`);
      }
    }
    return { detected, synced, imported, failedSets };
  } catch (err) {
    console.error("[CRON] new-set sync phase error:", errMsg(err));
    return { error: errMsg(err) };
  }
}

// ─── Phase 2: price refresh ──────────────────────────────────────────────────
async function refreshPrices(deadline: number, dryRun: boolean) {
  try {
    // Stalest first (never-priced rows lead), bounded per run so repeated runs
    // sweep the whole catalog over time without one run fanning out unbounded.
    const rows = await dbRetry(() =>
      prisma.catalogCard.findMany({
        where: { game: "POKEMON" },
        select: { externalId: true, priceUpdatedAt: true },
        orderBy: [{ priceUpdatedAt: { sort: "asc", nulls: "first" } }],
        take: PRICE_MAX_CARDS_PER_RUN,
      }),
    );

    let examined = 0;
    let refreshed = 0;
    let skipped = 0;
    let failed = 0;

    for (const row of rows) {
      if (Date.now() > deadline) break;
      examined++;

      // Lenient by-id lookup: null on ANY upstream failure (a background job wants
      // to skip a card, not fail over it).
      const ext = await getPokemonCardById(row.externalId);
      const price = ext ? formatPokemonCard(ext).price : null;

      // Truth boundary: a non-answer (fetch failed) or an absent price NEVER
      // overwrites the stored price. Leave the stale value exactly as-is.
      if (!price || price.marketPrice === undefined || price.marketPrice === null) {
        skipped++;
        if (PRICE_DELAY_MS) await sleep(PRICE_DELAY_MS);
        continue;
      }

      if (dryRun) {
        refreshed++; // would update
        if (PRICE_DELAY_MS) await sleep(PRICE_DELAY_MS);
        continue;
      }

      try {
        await dbRetry(() =>
          prisma.catalogCard.update({
            where: { externalId: row.externalId },
            data: {
              marketPrice: price.marketPrice,
              lowPrice: price.lowPrice ?? null,
              midPrice: price.midPrice ?? null,
              highPrice: price.highPrice ?? null,
              priceUpdatedAt: new Date(),
            },
          }),
        );
        refreshed++;
      } catch (err) {
        // One bad update never fails the batch — the row keeps its prior price.
        failed++;
        console.error(`[CRON] catalog price update failed for ${row.externalId}: ${errMsg(err)}`);
      }

      if (PRICE_DELAY_MS) await sleep(PRICE_DELAY_MS);
    }

    return { batchSize: rows.length, examined, refreshed, skipped, failed, dryRun };
  } catch (err) {
    console.error("[CRON] price refresh phase error:", errMsg(err));
    return { error: errMsg(err) };
  }
}
