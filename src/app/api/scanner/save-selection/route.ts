import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { METHOD_CONFIDENCE } from "@/lib/scanner/decision";

// The user looked at the physical card and picked — that's ground truth.
const USER_SELECTION_CONFIDENCE = Math.round(METHOD_CONFIDENCE["user-selection"] * 100);

// ─── POST /api/scanner/save-selection ─────────────────────────────────────
// Called by the frontend when the user manually selects their card variant
// from the disambiguation grid.
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    const { candidate } = body;

    if (!candidate || !candidate.externalId) {
      return NextResponse.json({ success: false, message: "No card selection provided." }, { status: 400 });
    }

    // Upsert card into local DB
    let localCard = await prisma.card.findFirst({
      where: { externalId: candidate.externalId }
    });

    if (!localCard) {
      localCard = await prisma.card.create({
        data: {
          externalId: candidate.externalId,
          name: candidate.name,
          game: candidate.game,
          setName: candidate.setName,
          setCode: candidate.setCode || null,
          collectorNumber: candidate.collectorNumber || null,
          rarity: candidate.rarity,
          imageUrl: candidate.imageUrl,
          thumbnailUrl: candidate.thumbnailUrl,
        }
      });

      await prisma.cardPrice.create({
        data: {
          cardId: localCard.id,
          marketPrice: candidate.price?.marketPrice || 0,
          lowPrice: candidate.price?.lowPrice || null,
          midPrice: candidate.price?.midPrice || null,
          highPrice: candidate.price?.highPrice || null,
        },
      });
    }

    // Save to scan history. matchMethod "user-selection" is what the learning
    // analyzer counts as a pipeline failure — the AI couldn't finish the job.
    const history = await prisma.scanHistory.create({
      data: {
        userId: session.user.id,
        cardId: localCard.id,
        confidence: USER_SELECTION_CONFIDENCE,
        matchMethod: "user-selection",
        imageUrl: localCard.imageUrl,
      },
    });

    console.log(`[Scanner] User-selected: "${localCard.name}" from "${localCard.setName}"`);

    return NextResponse.json({
      success: true,
      data: {
        id: localCard.id,
        name: localCard.name,
        set: localCard.setName,
        game: localCard.game,
        prices: {
          marketPrice: candidate.price?.marketPrice || 0,
          lowPrice: candidate.price?.lowPrice || 0,
          midPrice: candidate.price?.midPrice || 0,
          highPrice: candidate.price?.highPrice || 0,
        },
        rarity: localCard.rarity,
        confidence: USER_SELECTION_CONFIDENCE,
        imageUrl: localCard.imageUrl,
        thumbnailUrl: localCard.thumbnailUrl,
        historyId: history.id,
      },
    });

  } catch (error: any) {
    console.error("[SaveSelection] Error:", error?.message || error);
    return NextResponse.json({ success: false, message: "Failed to save card selection." }, { status: 500 });
  }
}
