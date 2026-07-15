// ─── GET /api/cards — card search (Phase 5.12A) ─────────────────────────────
// This route speaks HTTP and nothing else. Provider dispatch, normalization,
// dedup, ranking and the found/not-found judgement all live in
// CardSearchService — the route must not know that Scryfall exists.
//
// It returns the SearchOutcome verbatim, including per-source availability, so
// the client can tell a collector the truth: "no such card" and "we couldn't
// reach the Pokémon database" are different answers and must look different.

import { NextRequest, NextResponse } from "next/server";
import { searchCards } from "@/lib/search/CardSearchService";
import { normalizeGame } from "@/lib/search/identity";

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url);
  const query = searchParams.get("q") ?? "";
  const gameParam = searchParams.get("game");

  // An unrecognized game filter is a client error, not an empty catalog.
  // Answering "no cards found" for game=FLESH_AND_BLOOD would be a false
  // negative about the catalog rather than an honest error about the request.
  const game = gameParam ? normalizeGame(gameParam) : null;
  if (gameParam && !game) {
    return NextResponse.json(
      { success: false, message: `Unknown game filter: "${gameParam}"` },
      { status: 400 },
    );
  }

  try {
    const outcome = await searchCards({ query, game });
    return NextResponse.json({ success: true, ...outcome });
  } catch (error: any) {
    // searchCards fault-isolates every source, so reaching here means the
    // search layer itself broke. That is still not "no cards found".
    console.error("[Search] Unhandled search failure:", error?.message ?? error);
    return NextResponse.json(
      { success: false, message: "Search is temporarily unavailable." },
      { status: 500 },
    );
  }
}
