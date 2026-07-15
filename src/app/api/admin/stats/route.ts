import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { auth } from "@/auth";

export async function GET() {
  try {
    const session = await auth();
    // In a real app, verify if session.user.role === "ADMIN"
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const [totalUsers, totalScans, cardsInDb] = await Promise.all([
      prisma.user.count(),
      prisma.scanHistory.count(),
      prisma.card.count(),
    ]);

    return NextResponse.json({
      success: true,
      data: {
        totalUsers,
        totalScans,
        cardsInDb,
        // Null, not a number: we do not log external API calls, so we cannot
        // report them. This used to be `totalScans * 1.5 + 342` — a fabricated
        // figure that looked like a measurement and would have been read as one.
        // An absent metric must render as absent (see telemetry-analysis.ts:
        // "a provider we have no records for must never report 0ms"). When a
        // request log exists, this becomes a count; until then it stays null.
        apiRequests: null,
      },
    });
  } catch (error) {
    console.error("Admin stats error:", error);
    return NextResponse.json(
      { success: false, message: "Failed to fetch admin stats" },
      { status: 500 }
    );
  }
}
