// The single admin-authorization decision, shared by every admin route so the
// rule cannot drift between them. Deliberately dependency-free at runtime —
// the only import is a type (erased at compile time) — so it can be unit-tested
// with a plain mock session, without pulling NextAuth/Prisma into the test.
//
// 401 vs 403 is a real distinction the client branches on:
//   401 — not authenticated at all (no session). "Log in."
//   403 — authenticated, but not permitted. "You're signed in, but this isn't
//         yours to see." Collapsing the two would tell a signed-in non-admin to
//         log in again, which is both wrong and confusing.
import type { Session } from "next-auth";

export type AdminGate =
  | { ok: true; userId: string }
  | { ok: false; status: 401 | 403; message: string };

/**
 * Pure authorization decision for admin-only surfaces.
 *
 * The role lives on the User model (default "USER") and rides the JWT into the
 * session (see the jwt/session callbacks in auth.ts). A missing role is treated
 * as "not admin" — the safe default — never as an admin.
 */
export function checkAdmin(session: Session | null): AdminGate {
  if (!session?.user?.id) {
    return { ok: false, status: 401, message: "Unauthorized" };
  }
  if (session.user.role !== "ADMIN") {
    return { ok: false, status: 403, message: "Forbidden" };
  }
  return { ok: true, userId: session.user.id };
}
