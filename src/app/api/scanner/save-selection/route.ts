import { NextRequest, NextResponse } from "next/server";
import { dbRetry, prisma } from "@/lib/prisma";
import { auth } from "@/auth";
import { METHOD_CONFIDENCE } from "@/lib/scanner/decision";
import { fetchPrintingById } from "@/lib/scanner/candidates";
import { withSelection } from "@/lib/scanner/telemetry";
import { getArchiveContext } from "@/lib/scanner/archive-context";
import { messageForStage, runStage, stageOfError } from "@/lib/scanner/failure";

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
  // Hoisted for the catch-all's structured log — a failure should name the
  // card it was trying to save, not just "an error".
  let externalId: string | undefined;
  let game: string | undefined;
  let cardName: string | undefined;
  let localCardId: string | undefined;
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json();
    // body.candidate is the legacy shape (kept so a cached client keeps
    // working across the deploy); only its identifiers are read.
    externalId = body.externalId ?? body.candidate?.externalId;
    game = body.game ?? body.candidate?.game;
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
    cardName = card.name;

    // ─── Persist (Phase 5.2.5 parity) ──────────────────────────────────
    // Same reliability contract as the scan route's saveAndRespond: every
    // write is dbRetry-wrapped so a transient serverless connection drop is
    // recovered instead of surfacing as a 500, and the whole block is tagged
    // "database" so a hard failure is stage-classified (not a generic error).
    const { localCard, history } = await runStage("database", async () => {
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
      const localCard = await dbRetry(() => prisma.card.upsert({
        where: { externalId: card.externalId },
        update: cardData,
        create: { externalId: card.externalId, game: card.game, ...cardData },
      }));

      // Always refresh the stored price with what the card database returned
      // just now — a card first saved months ago must not keep its stale price.
      await dbRetry(() => prisma.cardPrice.upsert({
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
      }));

      // Save to scan history. matchMethod "user-selection" is what the learning
      // analyzer counts as a pipeline failure — the AI couldn't finish the job.
      // When the client echoed the scanId, UPDATE the originating attempt's row
      // instead of creating a new one: the pick becomes the ground-truth label
      // attached to that scan's evidence (Phase 6 eval dataset). The ownership
      // check keeps one user from labeling another user's scan.
      let history = null;
      if (scanId) {
        const origin = await dbRetry(() => prisma.scanHistory.findFirst({
          where: { id: scanId, userId: session.user.id },
        }));
        if (origin) {
          history = await dbRetry(() => prisma.scanHistory.update({
            where: { id: origin.id },
            data: {
              cardId: localCard.id,
              confidence: USER_SELECTION_CONFIDENCE,
              matchMethod: "user-selection",
              imageUrl: localCard.imageUrl,
              ocrText: withSelection(origin.ocrText, { externalId: card.externalId, game: card.game }),
            },
          }));
        }
      }
      if (!history) {
        history = await dbRetry(() => prisma.scanHistory.create({
          data: {
            userId: session.user.id,
            cardId: localCard.id,
            confidence: USER_SELECTION_CONFIDENCE,
            matchMethod: "user-selection",
            imageUrl: localCard.imageUrl,
            ocrText: withSelection(null, { externalId: card.externalId, game: card.game }),
          },
        }));
      }

      return { localCard, history };
    });
    localCardId = localCard.id;

    console.log(`[Scanner] User-selected: "${localCard.name}" from "${localCard.setName}"`);

    // Archive context (Phase 5 · Batch 2) — same additive, failure-safe field
    // the auto-accept path returns, so both save paths feel identical.
    const archive = await getArchiveContext(session.user.id, localCard);

    return NextResponse.json({
      success: true,
      data: {
        id: localCard.id,
        name: localCard.name,
        set: localCard.setName,
        game: localCard.game,
        archive,
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
    // ─── Stage-classified failure (Phase 5.2.5 parity) ──────────────────
    // Same taxonomy the scan route uses: name WHERE the save failed and never
    // blame the image. Persistence throws surface here tagged "database".
    const stage = stageOfError(error);
    const causeMessage: string = error?.cause_?.message || error?.message || String(error);
    console.error(
      `[SaveSelection] Failed at stage "${stage}" — game=${game ?? "?"} card="${cardName ?? "?"}" externalId=${externalId ?? "?"} localId=${localCardId ?? "?"}:`,
      causeMessage
    );
    return NextResponse.json({ success: false, stage, message: messageForStage(stage) }, { status: 500 });
  }
}
