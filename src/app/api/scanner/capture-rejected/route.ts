// ─── Capture Rejection Reporting (Phase 5.14.3) ──────────────────────────────
// Records a frame the client-side quality gate declined, so "capture blocked the
// scan" becomes a MEASURED stage rather than an assumed one.
//
// This closes the pipeline's first blind spot. The gate runs entirely in the
// browser, so a rejected frame never reached a server at all: from the backend's
// point of view the scan simply never happened. That made capture the one stage
// whose failures were structurally invisible — not rare, invisible — and left
// "what stage actually failed?" unanswerable whenever the answer was "capture".
//
// It is OBSERVATION ONLY. Nothing here feeds back into a scan: the gate has
// already decided and the client has already moved on by the time this is
// called. The response body is empty by design — there is nothing the client
// should do differently based on it.
//
// Rows go to CaptureRejection, deliberately NOT ScanHistory. A rejected frame is
// not a scan (no OCR call, no provider consulted), and ScanHistory.count() backs
// the admin "Total Scans" tile.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { isCaptureFailureReason, isCaptureMode } from "@/lib/scanner/capture-rejection";
import { checkCaptureReportBurst } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  if (!checkCaptureReportBurst(session.user.id).ok) {
    // Silently dropped, and honestly so: this report is now UNMEASURED. It is
    // never estimated, back-filled or inferred later. 429 (not 204) so the drop
    // is visible in access logs rather than looking like a successful write.
    return NextResponse.json({ success: false, message: "Too many capture reports" }, { status: 429 });
  }

  const body = await req.json().catch(() => null);

  // Validate against the gate's own vocabulary. An unrecognized reason is
  // REJECTED rather than coerced to "unknown" or stored raw: a value we cannot
  // interpret would pollute the reason distribution with a bucket that means
  // nothing, and this endpoint is only worth having if its rows can be trusted.
  if (!isCaptureFailureReason(body?.reason)) {
    return NextResponse.json({ success: false, message: "Unrecognized capture reason" }, { status: 400 });
  }

  try {
    await prisma.captureRejection.create({
      data: {
        userId: session.user.id,
        reason: body.reason,
        // Null when absent/unrecognized — unknown, never guessed.
        mode: isCaptureMode(body?.mode) ? body.mode : null,
        game: typeof body?.game === "string" && body.game ? body.game : null,
      },
    });
  } catch (err: any) {
    // Telemetry must never break the scanner. The client has already retried by
    // now; the only cost of this failure is one lost measurement.
    console.warn("[Scanner] Could not persist capture rejection (non-fatal):", err?.message);
  }

  return new NextResponse(null, { status: 204 });
}
