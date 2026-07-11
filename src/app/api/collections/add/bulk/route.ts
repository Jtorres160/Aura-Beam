import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { cardIds } = body;

    if (!cardIds || !Array.isArray(cardIds) || cardIds.length === 0) {
      return NextResponse.json({ success: false, message: "Valid card IDs array is required" }, { status: 400 });
    }

    // 1. Get or create primary collection
    let collection = await prisma.collection.findFirst({
      where: { userId },
    });

    if (!collection) {
      collection = await prisma.collection.create({
        data: {
          userId,
          name: "My Core Collection",
        },
      });
    }

    // Since these cards were just scanned, they should already exist in the database 
    // (inserted by the scanner API). We just need to add them to the collection.
    
    // Group identical cardIds to handle duplicates in the bulk array
    const idCounts: Record<string, number> = {};
    for (const id of cardIds) {
      idCounts[id] = (idCounts[id] || 0) + 1;
    }

    const results = [];

    // Process each unique card
    for (const [cardId, count] of Object.entries(idCounts)) {
      const existingEntry = await prisma.collectionCard.findUnique({
        where: {
          collectionId_cardId: {
            collectionId: collection.id,
            cardId: cardId,
          },
        },
      });

      if (existingEntry) {
        const updated = await prisma.collectionCard.update({
          where: { id: existingEntry.id },
          data: { quantity: existingEntry.quantity + count },
        });
        results.push(updated);
      } else {
        const added = await prisma.collectionCard.create({
          data: {
            collectionId: collection.id,
            cardId: cardId,
            quantity: count,
          },
        });
        results.push(added);
      }
    }

    // Archive delta (Phase 5 · Batch 2): new archive totals after the bulk
    // add. Failure-safe — never fails the add itself.
    let archive = null;
    try {
      const agg = await prisma.collectionCard.aggregate({
        where: { collectionId: collection.id },
        _sum: { quantity: true },
      });
      archive = { totalCards: agg._sum.quantity ?? 0, added: cardIds.length };
    } catch {
      /* non-fatal */
    }

    return NextResponse.json({ success: true, data: results, archive, message: `Successfully added ${cardIds.length} cards` }, { status: 201 });
  } catch (error) {
    console.error("Error adding bulk cards to collection:", error);
    return NextResponse.json(
      { success: false, message: "Failed to add bulk cards to collection" },
      { status: 500 }
    );
  }
}
