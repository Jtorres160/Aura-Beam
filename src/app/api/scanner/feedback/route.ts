// ─── Scan Feedback Reporting ─────────────────────────────────────────────────
// Records an issue a collector reported from the scanner screen, with the
// technical state of the scan attached automatically by the client.
//
// This exists because the tester window is about to make Aura's failures
// somebody else's problem to notice. Sentry sees the errors Aura throws; it
// cannot see the failure that matters most — a scan that returned a confident,
// well-formed, WRONG card. Nothing in the pipeline is capable of detecting that.
// Only the person holding the card can.
//
// ─── THE WRITE IS NOT BEST-EFFORT ────────────────────────────────────────────
//
// Every other reporting endpoint in this codebase swallows its failures on
// purpose: a dropped capture rejection costs one measurement, and telemetry must
// never break a scan. This one is the opposite. A dropped feedback row costs a
// person's report, and answering with "thanks, we got it" when the insert threw
// is a lie told directly to the one tester who took the time to tell us
// something. So the failure is returned as a failure and the UI says so.
//
// Nothing here feeds back into identification. See the ScanFeedback model
// comment in prisma/schema.prisma for why a human claim is stored beside the
// scan record rather than on it.

import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/auth";
import { prisma } from "@/lib/prisma";
import { parseScanFeedback } from "@/lib/scanner/scan-feedback";
import { checkFeedbackBurst } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return NextResponse.json({ success: false, message: "Unauthorized" }, { status: 401 });
  }

  // Free text behind a session, but still rate limited: this is the one
  // endpoint that stores arbitrary user-supplied strings.
  const burst = checkFeedbackBurst(session.user.id);
  if (!burst.ok) {
    return NextResponse.json(
      { success: false, message: `Too many reports — try again in ${burst.retryAfterSeconds}s.` },
      { status: 429, headers: { "Retry-After": String(burst.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = parseScanFeedback(body);
  if (!parsed.ok) {
    return NextResponse.json({ success: false, message: parsed.message }, { status: 400 });
  }

  try {
    const row = await prisma.scanFeedback.create({
      data: { userId: session.user.id, ...parsed.value },
      select: { id: true },
    });
    return NextResponse.json({ success: true, id: row.id }, { status: 201 });
  } catch (err: unknown) {
    // Logged AND returned as a failure. The client must not render a
    // confirmation for a report that does not exist.
    console.error("[ScanFeedback] Could not persist report:", (err as Error)?.message);
    return NextResponse.json(
      { success: false, message: "We couldn't save your report — it wasn't received. Try again in a moment." },
      { status: 500 }
    );
  }
}
