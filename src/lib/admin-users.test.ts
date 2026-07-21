// The admin user list must expose ONLY safe fields. These tests pin the two
// rules that keep it that way:
//
//   • emailVerified leaves as a boolean, never the raw timestamp.
//   • the serializer constructs its output field by field, so a raw row that
//     carries an extra sensitive column (e.g. a future passwordHash) cannot
//     pass through by default.
//
// Run: node --import ./test/register.mjs --test src/lib/admin-users.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parsePage, toAdminUserRow, type RawAdminUser } from "@/lib/admin-users";

function raw(over: Partial<RawAdminUser> = {}): RawAdminUser {
  return {
    id: "u1",
    email: "collector@example.com",
    name: "A Collector",
    username: "collector",
    role: "USER",
    plan: "FREE",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    emailVerified: null,
    _count: { scanHistory: 7 },
    ...over,
  };
}

describe("toAdminUserRow — safe projection", () => {
  test("emailVerified becomes a boolean, not the raw timestamp", () => {
    const verified = toAdminUserRow(raw({ emailVerified: new Date() }));
    assert.equal(verified.emailVerified, true);
    assert.equal(typeof verified.emailVerified, "boolean");

    const unverified = toAdminUserRow(raw({ emailVerified: null }));
    assert.equal(unverified.emailVerified, false);
  });

  test("scan count comes from _count and maps to scanCount", () => {
    assert.equal(toAdminUserRow(raw({ _count: { scanHistory: 42 } })).scanCount, 42);
  });

  test("createdAt is serialized to an ISO string", () => {
    assert.equal(toAdminUserRow(raw()).createdAt, "2026-01-02T03:04:05.000Z");
  });

  test("exposes exactly the allow-listed keys — no extra fields leak", () => {
    const row = toAdminUserRow(raw());
    assert.deepEqual(
      Object.keys(row).sort(),
      ["createdAt", "email", "emailVerified", "id", "name", "plan", "role", "scanCount", "username"]
    );
  });

  test("a sensitive column on the raw row does NOT pass through", () => {
    // Simulate a future User field arriving on the row. The serializer must not
    // spread it into the output.
    const withSecret = { ...raw(), passwordHash: "$argon2id$leaked", image: "avatar.png" } as RawAdminUser;
    const row = toAdminUserRow(withSecret) as unknown as Record<string, unknown>;
    assert.equal("passwordHash" in row, false);
    assert.equal("image" in row, false);
  });
});

describe("parsePage — pagination input", () => {
  test("valid positive integers pass through", () => {
    assert.equal(parsePage("1"), 1);
    assert.equal(parsePage("25"), 25);
  });

  test("missing or malformed input falls back to page 1", () => {
    for (const v of [null, "", "0", "-3", "abc", "1.5", "NaN", "  "]) {
      assert.equal(parsePage(v), 1, `"${v}" should fall back to page 1`);
    }
  });
});
