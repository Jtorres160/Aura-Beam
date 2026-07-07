import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const watchlist = await prisma.watchlist.findMany({
      where: { userId },
      include: {
        card: {
          include: { prices: true }
        }
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    return NextResponse.json({
      success: true,
      data: watchlist,
    });
  } catch (error) {
    console.error("Error fetching watchlist:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch watchlist" },
      { status: 500 }
    );
  }
}

export async function DELETE(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { cardId } = body;

    if (!cardId) {
      return NextResponse.json({ success: false, message: "Card ID is required" }, { status: 400 });
    }

    const card = await prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      return NextResponse.json({ success: false, message: "Card not found" }, { status: 404 });
    }

    await prisma.watchlist.delete({
      where: {
        userId_cardId: {
          userId,
          cardId: card.id,
        },
      },
    });

    return NextResponse.json({ success: true, message: "Card removed from watchlist" });
  } catch (error) {
    console.error("Error removing from watchlist:", error);
    return NextResponse.json(
      { success: false, message: "Failed to remove from watchlist" },
      { status: 500 }
    );
  }
}

export async function PATCH(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    const body = await req.json();
    const { cardId, alertAbove, alertBelow, alertEnabled } = body;

    if (!cardId) {
      return NextResponse.json({ success: false, message: "Card ID is required" }, { status: 400 });
    }

    const card = await prisma.card.findFirst({
      where: {
        OR: [{ id: cardId }, { externalId: cardId }],
      },
    });

    if (!card) {
      return NextResponse.json({ success: false, message: "Card not found" }, { status: 404 });
    }

    const updatedWatchlist = await prisma.watchlist.update({
      where: {
        userId_cardId: {
          userId,
          cardId: card.id,
        },
      },
      data: {
        alertAbove: alertAbove !== undefined ? alertAbove : undefined,
        alertBelow: alertBelow !== undefined ? alertBelow : undefined,
        alertEnabled: alertEnabled !== undefined ? alertEnabled : undefined,
      },
      include: {
        card: {
          include: { prices: true }
        }
      }
    });

    return NextResponse.json({ success: true, data: updatedWatchlist });
  } catch (error) {
    console.error("Error updating watchlist alerts:", error);
    return NextResponse.json(
      { success: false, message: "Failed to update price alerts" },
      { status: 500 }
    );
  }
}
