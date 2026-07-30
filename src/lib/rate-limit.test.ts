import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTACT_BURST_LIMIT, checkContactBurst, clientKeyFromHeaders } from "@/lib/rate-limit";

// Scoped to the contact limiter added with the contact form. The shared
// sliding-window helper is exercised through it.

test("the first entry of x-forwarded-for is the client", () => {
  const h = new Headers({ "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178" });
  assert.equal(clientKeyFromHeaders(h), "203.0.113.7");
});

test("x-real-ip is the fallback when x-forwarded-for is absent", () => {
  assert.equal(clientKeyFromHeaders(new Headers({ "x-real-ip": "198.51.100.4" })), "198.51.100.4");
});

test("no address header falls back to one shared bucket, not a bypass", () => {
  // An unidentifiable client must get the STRICTEST treatment, never a free
  // pass earned by being unidentifiable.
  assert.equal(clientKeyFromHeaders(new Headers()), "unknown");
  assert.equal(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "   " })), "unknown");
  assert.equal(clientKeyFromHeaders(new Headers({ "x-forwarded-for": "" })), "unknown");
});

test("submissions are allowed up to the limit, then refused", () => {
  const key = `test-${Math.random()}`;
  for (let i = 0; i < CONTACT_BURST_LIMIT; i++) {
    assert.equal(checkContactBurst(key).ok, true, `submission ${i + 1} should be allowed`);
  }
  const denied = checkContactBurst(key);
  assert.equal(denied.ok, false);
  if (!denied.ok) {
    // The visitor is told how long to wait, so a refusal is actionable.
    assert.ok(denied.retryAfterSeconds > 0 && denied.retryAfterSeconds <= 60);
  }
});

test("clients are limited independently", () => {
  const a = `test-a-${Math.random()}`;
  const b = `test-b-${Math.random()}`;
  for (let i = 0; i < CONTACT_BURST_LIMIT; i++) checkContactBurst(a);
  assert.equal(checkContactBurst(a).ok, false, "a is exhausted");
  assert.equal(checkContactBurst(b).ok, true, "b must be unaffected by a");
});

test("a denied attempt is not recorded against the window", () => {
  // Otherwise a client that keeps retrying would extend its own lockout
  // indefinitely and never recover.
  const key = `test-${Math.random()}`;
  for (let i = 0; i < CONTACT_BURST_LIMIT; i++) checkContactBurst(key);
  const first = checkContactBurst(key);
  const second = checkContactBurst(key);
  assert.equal(first.ok, false);
  assert.equal(second.ok, false);
  if (!first.ok && !second.ok) {
    assert.ok(
      second.retryAfterSeconds <= first.retryAfterSeconds,
      "retry window must drain, not grow, while a client keeps trying",
    );
  }
});
