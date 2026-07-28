import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { allocateRunDeadlines, TOTAL_BUDGET_MS } from "@/lib/services/cron-budget";
import { refreshOwnedPrices, type OwnedPriceDb } from "@/lib/services/owned-price-refresh";
import {
  syncNewSets,
  refreshCatalogPrices,
  type CatalogRefreshDb,
} from "@/lib/services/catalog-refresh";

// ─── Combined nightly maintenance cron ───────────────────────────────────────
// Three phases, one invocation, one clock.
//
// They share a slot because the Vercel Hobby plan allows exactly two cron
// entries and this project needs both this and analyze-scans. They do NOT share
// internals: each phase lives in its own module with its own tests, because they
// remain conceptually distinct jobs (a collector's archive vs. the scanner's
// reference mirror) that merely happen to run back to back.
//
// Phase order is by user impact, and the allocator reserves time for the phases
// that follow, so slack flows FORWARD: a fast phase hands its leftover window to
// the next one, and a slow phase can never starve them. That property is the fix
// for the M5 budget bug, where new-set enumeration consumed an entire 55s window
// and the price sweep reported "examined: 0" while looking successful.
//
// See docs/scanner-v2/M-CATALOG-M5-budget-bug-proposal.md.

// The Vercel Hobby ceiling. TOTAL_BUDGET_MS (45s) sits well inside it, and
// because the deadline now reaches into the transport layer, overrun past the
// budget is bounded by one clamped attempt rather than a full retry sequence.
export const maxDuration = 60;

export async function GET(request: Request) {
  // Mandatory cron-secret guard (Vercel's recommended pattern). Vercel sends
  // `Authorization: Bearer $CRON_SECRET` on its own scheduled invocations.
  const authHeader = request.headers.get("authorization");
  if (!process.env.CRON_SECRET || authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // ?dry=1 → exercise every read and upstream fetch, perform NO writes.
  const dryRun = new URL(request.url).searchParams.get("dry") === "1";
  const startedAt = Date.now();
  const deadlines = allocateRunDeadlines(startedAt);

  console.log(`[CRON] nightly maintenance starting${dryRun ? " (dry run)" : ""}…`);

  try {
    // Sequential on purpose: they contend for the same upstream and the same
    // connection pool, and a shared budget is only meaningful if spending is
    // ordered. Each phase isolates its own failures and returns a report.
    const ownedPrices = await refreshOwnedPrices(
      prisma as unknown as OwnedPriceDb,
      deadlines.ownedPrices,
      dryRun,
    );
    const newSets = await syncNewSets(
      prisma as unknown as CatalogRefreshDb,
      deadlines.newSets,
      dryRun,
    );
    const catalogPrices = await refreshCatalogPrices(
      prisma as unknown as CatalogRefreshDb,
      deadlines.catalogPrices,
      dryRun,
    );

    // `complete` is the health signal, NOT `success`. `success` only ever meant
    // "the handler didn't throw"; conflating the two is how a run that examined
    // 3 of 174 sets reported itself as a clean bill of health.
    const phases = [ownedPrices, newSets, catalogPrices];
    const complete = phases.every((p) => p.status === "complete");
    const durationMs = Date.now() - startedAt;

    const summary =
      `owned ${ownedPrices.examined}/${ownedPrices.total} (${ownedPrices.status}), ` +
      `sets ${newSets.examined}/${newSets.total} (${newSets.status}), ` +
      `catalog ${catalogPrices.examined}/${catalogPrices.total} (${catalogPrices.status}), ` +
      `${durationMs}ms of ${TOTAL_BUDGET_MS}ms`;

    // An incomplete run is a WARN, so it is greppable in Vercel logs without
    // anyone having to run a dry run to discover it.
    if (complete) console.log(`[CRON] nightly maintenance complete — ${summary}`);
    else console.warn(`[CRON] nightly maintenance INCOMPLETE — ${summary}`);

    return NextResponse.json({
      success: true,
      complete,
      dryRun,
      durationMs,
      ownedPrices,
      newSets,
      catalogPrices,
    });
  } catch (error) {
    // Only reached on a truly unexpected error; each phase isolates its own.
    console.error("[CRON] nightly maintenance fatal:", error);
    return NextResponse.json({ success: false, message: "Internal server error" }, { status: 500 });
  }
}
