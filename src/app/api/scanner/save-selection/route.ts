import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { METHOD_CONFIDENCE } from "@/lib/scanner/decision";
import { fetchPrintingById } from "@/lib/scanner/candidates";
import { withSelection } from "@/lib/scanner/telemetry";

// The user looked at the physical card and picked — that's ground truth.
const USER_SELECTION_CONFIDENCE = Math.round(METHOD_CONFIDENCE["user-selection"] * 100);

// ─── POST /api/scanner/save-selection ─────────────────────────────────────
// Called by the frontend when the user manually selects their card variant
// from the disambiguation grid.
//
// TRUST BOUNDARY: the request names a card by IDENTIFIERS only (externalId +
// game). Card and CardPrice are GLOBAL tables shared by every user, so nothing
// written to them may come from the request body — the card is re-fetched from
// its source database server-side and that authoritative copy is what gets
// persisted. A tampered request can, at worst, save a card that exists.
export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    // body.candidate is the legacy shape (kept so a cached client keeps
    // working across the deploy); only its identifiers are read.
    const externalId: string | undefined = body.externalId ?? body.candidate?.externalId;
    const game: string | undefined = body.game ?? body.candidate?.game;
    // Links the pick back to the originating scan attempt's telemetry row.
    const scanId: string | undefined = typeof body.scanId === "string" ? body.scanId : undefined;

    if (!externalId || !game) {
      return NextResponse.json({ success: false, message: "No card selection provided." }, { status: 400 });
    }

    // Authoritative re-fetch — the ONLY source of persisted card data.
    const card = await fetchPrintingById(game, externalId);
    if (!card) {
      return NextResponse.json(
        { success: false, message: "Could not verify the selected card. Please scan again." },
        { status: 404 }
      );
    }

    // Atomic upsert on the unique externalId (no findFirst→create race); the
    // update branch refreshes metadata from the card database.
    const cardData = {
      name: card.name,
      setName: card.setName,
      setCode: card.setCode || null,
      collectorNumber: card.collectorNumber || null,
      rarity: card.rarity,
      imageUrl: card.imageUrl,
      thumbnailUrl: card.thumbnailUrl,
    };
    const localCard = await prisma.card.upsert({
      where: { externalId: card.externalId },
      update: cardData,
      create: { externalId: card.externalId, game: card.game, ...cardData },
    });

    // Always refresh the stored price with what the card database returned
    // just now — a card first saved months ago must not keep its stale price.
    await prisma.cardPrice.upsert({
      where: { cardId: localCard.id },
      update: {
        marketPrice: card.price?.marketPrice || 0,
        lowPrice: card.price?.lowPrice || null,
        midPrice: card.price?.midPrice || null,
        highPrice: card.price?.highPrice || null,
        lastUpdated: new Date(),
      },
      create: {
        cardId: localCard.id,
        marketPrice: card.price?.marketPrice || 0,
        lowPrice: card.price?.lowPrice || null,
        midPrice: card.price?.midPrice || null,
        highPrice: card.price?.highPrice || null,
      },
    });

    // Save to scan history. matchMethod "user-selection" is what the learning
    // analyzer counts as a pipeline failure — the AI couldn't finish the job.
    // When the client echoed the scanId, UPDATE the originating attempt's row
    // instead of creating a new one: the pick becomes the ground-truth label
    // attached to that scan's evidence (Phase 6 eval dataset). The ownership
    // check keeps one user from labeling another user's scan.
    let history = null;
    if (scanId) {
      const origin = await prisma.scanHistory.findFirst({
        where: { id: scanId, userId: session.user.id },
      });
      if (origin) {
        history = await prisma.scanHistory.update({
          where: { id: origin.id },
          data: {
            cardId: localCard.id,
            confidence: USER_SELECTION_CONFIDENCE,
            matchMethod: "user-selection",
            imageUrl: localCard.imageUrl,
            ocrText: withSelection(origin.ocrText, { externalId: card.externalId, game: card.game }),
          },
        });
      }
    }
    if (!history) {
      history = await prisma.scanHistory.create({
        data: {
          userId: session.user.id,
          cardId: localCard.id,
          confidence: USER_SELECTION_CONFIDENCE,
          matchMethod: "user-selection",
          imageUrl: localCard.imageUrl,
          ocrText: withSelection(null, { externalId: card.externalId, game: card.game }),
        },
      });
    }

    console.log(`[Scanner] User-selected: "${localCard.name}" from "${localCard.setName}"`);

    return NextResponse.json({
      success: true,
      data: {
        id: localCard.id,
        name: localCard.name,
        set: localCard.setName,
        game: localCard.game,
        prices: {
          marketPrice: card.price?.marketPrice || 0,
          lowPrice: card.price?.lowPrice || 0,
          midPrice: card.price?.midPrice || 0,
          highPrice: card.price?.highPrice || 0,
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
