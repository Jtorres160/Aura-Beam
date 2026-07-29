// Self-serve registration gate.
//
// Registration is off because email delivery cannot reach a tester (see
// src/lib/registration.ts), which means an account created here can never be
// logged into. The invariants worth pinning are the ones that would quietly
// reopen signup:
//
//   • The committed state is OFF. Absent config means no registration.
//   • Only the exact string "1" enables it — no truthy-ish value does.
//   • Every "sign up" CTA resolves to a door that actually opens.
//
// Run: node --import ./test/register.mjs --test src/lib/registration.test.ts

import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  REGISTRATION_ENABLED_ENV,
  isRegistrationEnabled,
  signupHref,
} from "@/lib/registration";

const REAL = { ...process.env };

afterEach(() => {
  process.env = { ...REAL };
});

function setFlag(v: string | undefined) {
  if (v === undefined) delete process.env[REGISTRATION_ENABLED_ENV];
  else (process.env as Record<string, string>)[REGISTRATION_ENABLED_ENV] = v;
}

describe("registration gate", () => {
  test("default (env unset) is OFF — the committed state for the tester window", () => {
    setFlag(undefined);
    assert.equal(isRegistrationEnabled(), false);
  });

  test("only the exact string \"1\" enables it", () => {
    for (const v of ["", "0", "true", "TRUE", "yes", "on", "enabled", " 1", "1 "]) {
      setFlag(v);
      assert.equal(isRegistrationEnabled(), false, `"${v}" must not enable registration`);
    }
    setFlag("1");
    assert.equal(isRegistrationEnabled(), true);
  });

  test("the env var name matches what the docs and call sites use", () => {
    // Guards against a rename drifting away from the NEXT_PUBLIC_ prefix, which
    // is what lets one value serve both the API route and the client CTAs.
    assert.equal(REGISTRATION_ENABLED_ENV, "NEXT_PUBLIC_REGISTRATION_ENABLED");
    assert.ok(REGISTRATION_ENABLED_ENV.startsWith("NEXT_PUBLIC_"));
  });
});

describe("signup call-to-action target", () => {
  test("points at /login while registration is off — never a dead form", () => {
    setFlag(undefined);
    assert.equal(signupHref(), "/login");
  });

  test("returns to /register once registration is re-enabled", () => {
    setFlag("1");
    assert.equal(signupHref(), "/register");
  });

  test("never resolves to /register while the gate is closed", () => {
    for (const v of [undefined, "", "0", "true"]) {
      setFlag(v);
      assert.notEqual(signupHref(), "/register");
    }
  });
});
