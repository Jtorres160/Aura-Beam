// ─── Reject an auto-accepted match (Scanner V2) ──────────────────────────────
// The negative half of confirmation telemetry. When the review screen shows a
// card the collector says isn't theirs, this records that verdict on the scan
// that produced it.
//
// Why an explicit endpoint rather than inferring rejection from "they never
// added it": silence is not disagreement. A scan with no confirmation may mean
// the collector disagreed, or that they were checking a price, got interrupted,
// or closed the tab. Counting that as a rejection would manufacture a
// disagreement rate out of missing data — the same error the truth boundary
// forbids everywhere else in this codebase.
//
// The write itself is delegated to recordScanRejection(), which owns the
// update-only / owner-scoped / ocrText-only guarantees. This route contributes
// auth and input validation and nothing else.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { recordScanRejection } from "@/lib/scanner/scan-outcome-label";

export async function POST(req: NextRequest) {
  try {
    const session = await auth();
    if (!session?.user?.id) {
      return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
    }

    const body = await req.json().catch(() => null);
    const scanId: string | undefined = typeof body?.scanId === "string" ? body.scanId : undefined;
    if (!scanId) {
      return NextResponse.json({ success: false, message: "scanId is required" }, { status: 400 });
    }
    const rejectedExternalId: string | undefined =
      typeof body?.rejectedExternalId === "string" ? body.rejectedExternalId : undefined;
    const replacedByExternalId: string | undefined =
      typeof body?.replacedByExternalId === "string" ? body.replacedByExternalId : undefined;
    const game: string | undefined = typeof body?.game === "string" ? body.game : undefined;

    const recorded = await recordScanRejection({
      scanId,
      userId: session.user.id,
      rejectedExternalId,
      replacedByExternalId,
      game,
    });

    // A scan that isn't this collector's (or no longer exists) is a 404, not a
    // silent 200: the client asked us to record something and we did not.
    if (!recorded) {
      return NextResponse.json({ success: false, message: "Scan not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true }, { status: 200 });
  } catch (error) {
    console.error("Error recording match rejection:", error);
    return NextResponse.json({ success: false, message: "Failed to record rejection" }, { status: 500 });
  }
}
