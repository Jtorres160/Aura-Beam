// The admin gate is the one thing standing between a signed-in non-admin and
// every user's email, so its decisions are what get tested — with plain mock
// sessions, never a real login.
//
//   • No session            → 401 (not authenticated).
//   • Signed in, role USER  → 403 (authenticated, not permitted).
//   • Signed in, no role    → 403 (missing role is NOT admin — safe default).
//   • Signed in, role ADMIN → ok, and carries the user id.
//
// 401 and 403 are kept distinct on purpose: the client branches on it, and
// telling a signed-in user to "log in" would be both wrong and confusing.
//
// Run: node --import ./test/register.mjs --test src/lib/admin-auth.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import type { Session } from "next-auth";

import { checkAdmin } from "@/lib/admin-auth";

// A session shaped like the real one (see the session callback in auth.ts),
// built inline so no auth stack is imported. `role` is optional, matching the
// augmented Session type.
function session(role?: string, id: string | null = "user_123"): Session {
  return {
    user: id === null ? ({} as any) : { id, email: "x@example.com", role },
    expires: new Date(Date.now() + 3_600_000).toISOString(),
  } as Session;
}

describe("checkAdmin — the admin authorization gate", () => {
  test("no session at all → 401 (not authenticated)", () => {
    const gate = checkAdmin(null);
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.status, 401);
  });

  test("a session with no user id → 401", () => {
    const gate = checkAdmin(session("ADMIN", null));
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.status, 401);
  });

  test("signed in as a plain USER → 403, NOT 401", () => {
    const gate = checkAdmin(session("USER"));
    assert.equal(gate.ok, false);
    // The whole point of the fix: authenticated but not permitted is 403, and
    // it must never collapse to 401 (which would read as "not logged in").
    assert.equal(gate.ok === false && gate.status, 403);
  });

  test("signed in with no role field → 403 (missing role is not admin)", () => {
    const gate = checkAdmin(session(undefined));
    assert.equal(gate.ok, false);
    assert.equal(gate.ok === false && gate.status, 403);
  });

  test("a non-ADMIN role string is never admin", () => {
    for (const role of ["user", "Admin", "ADMINISTRATOR", "MODERATOR", ""]) {
      const gate = checkAdmin(session(role));
      assert.equal(gate.ok, false, `role "${role}" must not pass the gate`);
      assert.equal(gate.ok === false && gate.status, 403);
    }
  });

  test("signed in as ADMIN → ok, and carries the user id", () => {
    const gate = checkAdmin(session("ADMIN"));
    assert.equal(gate.ok, true);
    assert.equal(gate.ok === true && gate.userId, "user_123");
  });
});
