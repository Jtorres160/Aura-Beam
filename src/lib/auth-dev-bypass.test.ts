// Development auth bypass gates (Phase 5.14.x).
//
// The whole value of a bypass is that it CANNOT fire where it shouldn't, so the
// gates are what get tested — not the happy path. The invariants:
//
//   • Production can never bypass, no matter what the env says.
//   • It is opt-in. Absent config means normal auth.
//   • It refuses a REMOTE database unless explicitly acknowledged, because
//     NODE_ENV describes the code and not the data — and in this repo the
//     "development" database is the production one.
//   • The dev user is deterministic and is not a real collector account.
//
// Run: node --import ./test/register.mjs --test src/lib/auth-dev-bypass.test.ts

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";

import {
  DEV_USER,
  devSession,
  isDevAuthBypassEnabled,
  isLocalDatabase,
} from "@/lib/auth-dev-bypass";

const REAL = { ...process.env };

// Silence the module's intentional console noise during assertions.
const quiet = { warn: console.warn, error: console.error };

beforeEach(() => {
  console.warn = () => {};
  console.error = () => {};
});

afterEach(() => {
  process.env = { ...REAL };
  console.warn = quiet.warn;
  console.error = quiet.error;
});

function env(over: Record<string, string | undefined>) {
  for (const [k, v] of Object.entries(over)) {
    if (v === undefined) delete process.env[k];
    else (process.env as Record<string, string>)[k] = v;
  }
}

const LOCAL_DB = "postgresql://u:p@localhost:5432/aura";
const REMOTE_DB = "postgresql://u:p@aws-1-us-east-2.pooler.supabase.com:5432/postgres";

describe("dev auth bypass — gate 1: environment", () => {
  test("production NEVER bypasses, even when every other flag is set", () => {
    env({
      NODE_ENV: "production",
      DEV_AUTH_BYPASS: "true",
      DEV_AUTH_BYPASS_ALLOW_REMOTE_DB: "true",
      DATABASE_URL: LOCAL_DB,
    });
    assert.equal(isDevAuthBypassEnabled(), false);
  });

  test("test environment does not bypass either", () => {
    env({ NODE_ENV: "test", DEV_AUTH_BYPASS: "true", DATABASE_URL: LOCAL_DB });
    assert.equal(isDevAuthBypassEnabled(), false);
  });
});

describe("dev auth bypass — gate 2: explicit opt-in", () => {
  test("development alone does not bypass; it must be asked for", () => {
    env({ NODE_ENV: "development", DEV_AUTH_BYPASS: undefined, DATABASE_URL: LOCAL_DB });
    assert.equal(isDevAuthBypassEnabled(), false);
  });

  test("only the exact string \"true\" enables it", () => {
    for (const v of ["1", "yes", "TRUE", "on", ""]) {
      env({ NODE_ENV: "development", DEV_AUTH_BYPASS: v, DATABASE_URL: LOCAL_DB });
      assert.equal(isDevAuthBypassEnabled(), false, `"${v}" must not enable the bypass`);
    }
    env({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true", DATABASE_URL: LOCAL_DB });
    assert.equal(isDevAuthBypassEnabled(), true);
  });
});

describe("dev auth bypass — gate 3: the database, not the code", () => {
  test("refuses a remote database even in development with the flag on", () => {
    // The gate the spec did not ask for and the one that matters here: this
    // repo's "development" DATABASE_URL is the production Supabase. Bypassing
    // against it would be a faked PRODUCTION session wearing a dev label.
    env({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true", DATABASE_URL: REMOTE_DB });
    assert.equal(isDevAuthBypassEnabled(), false);
  });

  test("proceeds against a remote database only on explicit acknowledgement", () => {
    env({
      NODE_ENV: "development",
      DEV_AUTH_BYPASS: "true",
      DATABASE_URL: REMOTE_DB,
      DEV_AUTH_BYPASS_ALLOW_REMOTE_DB: "true",
    });
    assert.equal(isDevAuthBypassEnabled(), true);
  });

  test("a local database needs no acknowledgement", () => {
    env({ NODE_ENV: "development", DEV_AUTH_BYPASS: "true", DATABASE_URL: LOCAL_DB });
    assert.equal(isDevAuthBypassEnabled(), true);
  });

  test("recognizes local hosts, and treats an unset/unparseable URL as NOT local", () => {
    for (const url of [LOCAL_DB, "postgresql://u:p@127.0.0.1:5432/aura", "postgresql://u:p@postgres:5432/aura"]) {
      env({ DATABASE_URL: url });
      assert.equal(isLocalDatabase(), true, `${url} should be local`);
    }
    // Unknown is not local: an unreadable URL must fail toward the SAFE side,
    // which is "assume it could be production".
    for (const url of [undefined, "not a url", REMOTE_DB]) {
      env({ DATABASE_URL: url });
      assert.equal(isLocalDatabase(), false, `${url} should not be local`);
    }
  });
});

describe("the development user", () => {
  test("is deterministic and obviously not a real collector account", () => {
    assert.equal(DEV_USER.id, "dev-user");
    assert.equal(DEV_USER.email, "dev@localhost");
    // A fixed id is what makes these rows findable, deletable, and excludable
    // from any telemetry denominator later.
    assert.equal(devSession().user.id, "dev-user");
  });

  test("the session is shaped like a real one, so no route can tell the difference", () => {
    const s = devSession();
    assert.ok(s.user.id && s.user.email && s.user.role);
    assert.ok(Date.parse(s.expires) > Date.now(), "expires must be a future ISO timestamp");
  });
});
