// ─── Contact form submission ─────────────────────────────────────────────────
// Delivers a contact-form message to the support inbox and reports honestly
// whether it went.
//
// What this replaces: the page's submit handler was a 1500ms setTimeout that
// always rendered "Message Sent!" and cleared the form. Nothing was sent,
// nothing was stored, and the visitor was told the opposite — so every message
// anyone ever wrote through that form was lost silently, with a confirmation.
// That is the exact failure mode the rest of this codebase is built to refuse
// (see the ScanHistory / CaptureRejection comments in prisma/schema.prisma).
//
// This is the ONLY unauthenticated write endpoint in the app, which drives two
// decisions: input is validated server-side by the same parser the client uses
// (client validation is a courtesy, never a control), and submissions are rate
// limited by client address — a weaker key than the userId every other limiter
// uses, and honestly labelled as such in rate-limit.ts.
//
// Messages are not persisted. There is no ScanFeedback-style table here and no
// admin surface; delivery to the inbox IS the storage. If a message needs to
// survive a mail failure, that is a table and a triage UI, and both are out of
// scope for this pass.

import { NextRequest, NextResponse } from "next/server";
import { parseContactMessage } from "@/lib/contact";
import { sendContactMessage } from "@/lib/email";
import { checkContactBurst, clientKeyFromHeaders } from "@/lib/rate-limit";

export async function POST(req: NextRequest) {
  const burst = checkContactBurst(clientKeyFromHeaders(req.headers));
  if (!burst.ok) {
    return NextResponse.json(
      {
        success: false,
        message: `That's a lot of messages at once — try again in ${burst.retryAfterSeconds}s.`,
      },
      { status: 429, headers: { "Retry-After": String(burst.retryAfterSeconds) } }
    );
  }

  const body = await req.json().catch(() => null);
  const parsed = parseContactMessage(body);
  if (!parsed.ok) {
    // The offending field travels with the message so the form can point at it
    // instead of leaving the visitor to guess which input we objected to.
    return NextResponse.json(
      { success: false, field: parsed.field, message: parsed.message },
      { status: 400 }
    );
  }

  const result = await sendContactMessage(parsed.value);

  if (!result.success) {
    // The send failed and the visitor is told so. The alternative — a 200 with
    // a cheerful confirmation — is the bug this endpoint exists to fix, and it
    // would be worse here than anywhere else in the app: the person is writing
    // to us precisely because something already isn't working.
    //
    // The underlying Resend error is logged (in sendContactMessage) but not
    // returned: it can carry provider detail that is no use to a visitor.
    return NextResponse.json(
      {
        success: false,
        message: "We couldn't send your message — it wasn't received. Try again in a moment, or email us directly.",
      },
      { status: 502 }
    );
  }

  return NextResponse.json({ success: true }, { status: 200 });
}
