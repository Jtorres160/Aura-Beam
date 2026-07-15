import { handlers } from "@/auth";
import { devSession, ensureDevUser, isDevAuthBypassEnabled } from "@/lib/auth-dev-bypass";
import { NextResponse, type NextRequest } from "next/server";

// ─── TEMPORARY: development auth bypass (Phase 5.14.x) ───────────────────────
// The CLIENT half of the bypass. Wrapping the server-side `auth()` is not
// enough: useSession() in the browser reads GET /api/auth/session, which
// NextAuth serves from `handlers` and which never calls our `auth()` wrapper.
// Without this the app lands in a split state — server routes authorized as
// dev-user while the UI still renders "Guest User" — and every client control
// gated on `if (!session)` silently does nothing. That is worse than no bypass,
// because the failure is invisible.
//
// Only the session GET is intercepted; sign-in, callbacks and every other
// NextAuth route are handed through untouched.
//
// To remove: restore `export const { GET, POST } = handlers;`

export async function GET(req: NextRequest) {
  if (isDevAuthBypassEnabled() && new URL(req.url).pathname.endsWith("/session")) {
    await ensureDevUser();
    return NextResponse.json(devSession());
  }
  return handlers.GET(req);
}

export const POST = handlers.POST;
