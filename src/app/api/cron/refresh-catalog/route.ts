import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { allocateRunDeadlines } from "@/lib/services/cron-budget";
import {
  syncNewSets,
  refreshCatalogPrices,
  type CatalogRefreshDb,
} from "@/lib/services/catalog-refresh";

// ─── Catalog freshness — MANUAL / DIAGNOSTIC entry point ─────────────────────
// NOT scheduled. The Vercel Hobby plan allows two cron entries, and both are
// spoken for (update-prices, analyze-scans), so the two catalog phases now run as
// part of /api/cron/update-prices — see that route and
// docs/scanner-v2/M-CATALOG-M5-budget-bug-proposal.md.
//
// This route is kept because it stays useful and costs nothing: it invokes the
// SAME two phase functions with the catalog phases given the whole window, which
// makes it the natural way to exercise them in isolation (`?dry=1`) without
// waiting for the nightly slot or reading another job's numbers. It shares the
// phase implementations, so it can never drift from what the cron actually runs.

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const startedAt = Date.now();
  const deadlines = allocateRunDeadlines(startedAt);
  const db = prisma as unknown as CatalogRefreshDb;

  console.log(`[CRON] refresh-catalog (manual) starting${dryRun ? " (dry run)" : ""}…`);

  try {
    // Run standalone, the catalog phases get the slot the owned-price phase would
    // otherwise hold — newSets keeps its reservation, catalogPrices takes the rest.
    const newSets = await syncNewSets(db, deadlines.newSets, dryRun);
    const catalogPrices = await refreshCatalogPrices(db, deadlines.catalogPrices, dryRun);

    const complete = newSets.status === "complete" && catalogPrices.status === "complete";
    const durationMs = Date.now() - startedAt;
    const summary =
      `sets ${newSets.examined}/${newSets.total} (${newSets.status}), ` +
      `catalog ${catalogPrices.examined}/${catalogPrices.total} (${catalogPrices.status}), ${durationMs}ms`;

    if (complete) console.log(`[CRON] refresh-catalog complete — ${summary}`);
    else console.warn(`[CRON] refresh-catalog INCOMPLETE — ${summary}`);

    return NextResponse.json({ success: true, complete, dryRun, durationMs, newSets, catalogPrices });
  } catch (error) {
    console.error("[CRON] refresh-catalog fatal:", error);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
