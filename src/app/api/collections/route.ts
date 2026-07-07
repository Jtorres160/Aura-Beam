import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

export async function GET() {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }
    const userId = session.user.id;

    let collection = await prisma.collection.findFirst({
      where: { userId },
      include: {
        cards: {
          include: {
            card: {
              include: {
                prices: true,
              },
            },
          },
          orderBy: {
            addedAt: 'desc',
          },
        },
      },
    });

    // If user has no collection, create a default one
    if (!collection) {
      collection = await prisma.collection.create({
        data: {
          userId,
          name: "My Core Collection",
        },
        include: {
          cards: {
            include: {
              card: {
                include: { prices: true },
              },
            },
          },
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: collection,
    });
  } catch (error) {
    console.error("Error fetching collection:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch collection" },
      { status: 500 }
    );
  }
}
