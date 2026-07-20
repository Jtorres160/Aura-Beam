// Email-verification token validity/expiry rules.
//
// Run: node --import ./test/register.mjs --test src/lib/verification.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { evaluateVerificationToken } from "@/lib/verification";

describe("evaluateVerificationToken", () => {
  const now = new Date("2026-07-20T12:00:00.000Z");

  test("missing token (no matching row) => 'missing'", () => {
    assert.equal(evaluateVerificationToken(null, now), "missing");
    assert.equal(evaluateVerificationToken(undefined, now), "missing");
  });

  test("token expiring in the future => 'valid'", () => {
    const token = { expires: new Date(now.getTime() + 60_000) };
    assert.equal(evaluateVerificationToken(token, now), "valid");
  });

  test("token expiring in the past => 'expired'", () => {
    const token = { expires: new Date(now.getTime() - 1) };
    assert.equal(evaluateVerificationToken(token, now), "expired");
  });

  test("exact expiry tie is still valid (not yet past)", () => {
    const token = { expires: new Date(now.getTime()) };
    assert.equal(evaluateVerificationToken(token, now), "valid");
  });

  test("defaults 'now' to current time — a far-future token is valid", () => {
    const token = { expires: new Date(Date.now() + 24 * 60 * 60 * 1000) };
    assert.equal(evaluateVerificationToken(token), "valid");
  });

  test("defaults 'now' to current time — a long-past token is expired", () => {
    const token = { expires: new Date(Date.now() - 24 * 60 * 60 * 1000) };
    assert.equal(evaluateVerificationToken(token), "expired");
  });
});
