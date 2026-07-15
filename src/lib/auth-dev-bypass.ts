// ─── TEMPORARY: Development-Only Auth Bypass (Phase 5.14.x) ──────────────────
//
// Lets local development and AI-assisted inspection reach protected routes
// without a login. It is NOT a production auth change: no middleware, no user
// model, no session handling and no authorization check was removed. Delete this
// file and the three call sites listed below and the app is exactly as it was.
//
// ─── HOW TO DISABLE ──────────────────────────────────────────────────────────
//   Remove DEV_AUTH_BYPASS from .env (or set it to anything but "true").
//   That is the whole switch. To remove it permanently, see REMOVAL below.
//
// ─── THE THREE GATES ─────────────────────────────────────────────────────────
// All must hold. Any one of them false and the real auth stack runs untouched:
//
//   1. NODE_ENV === "development"   — `next build`/Vercel set this to
//                                     "production", so the deployed app can
//                                     never take this path.
//   2. DEV_AUTH_BYPASS === "true"   — explicit opt-in, never a default.
//   3. A LOCAL database, or an explicit acknowledgement — see below.
//
// ─── WHY GATE 3 EXISTS (the one that isn't obvious) ──────────────────────────
//
// NODE_ENV describes the CODE, not the DATA. In this repo `.env` DATABASE_URL
// points at the live production Supabase, so "development" and "production"
// share one database. Without gate 3, a local bypass would:
//
//   • create the dev user as a REAL ROW in the production users table,
//   • hand unauthenticated admin access to production collector data, and
//   • write dev scans into the production telemetry that Phase 5.15's
//     200-scan gate is measured from — synthetic rows indistinguishable from
//     real collector scans.
//
// That is a faked production session wearing a development label, which is the
// one thing this bypass must not become. So when the database is not local the
// bypass REFUSES until the operator says, in writing, that they mean it.
//
// ─── REMOVAL ─────────────────────────────────────────────────────────────────
//   1. Delete this file.
//   2. src/auth.ts — drop the devSession() branch in the `auth` wrapper.
//   3. src/proxy.ts — drop `|| isDevAuthBypassEnabled()`.
//   4. Remove DEV_AUTH_BYPASS (and any ACK var) from .env.
//   5. Delete the dev row: DELETE FROM users WHERE id = 'dev-user';
//      (scan_history/capture_rejections cascade with it.)

/** Deterministic. Never random, never a real collector account. The fixed id is
 *  what makes this user's rows findable and deletable later — and excludable
 *  from any telemetry denominator. */
export const DEV_USER = {
  id: "dev-user",
  email: "dev@localhost",
  name: "Development User",
  // Admin routes currently gate on a session existing at all; the role is set
  // so they behave correctly if that check tightens.
  role: "ADMIN",
} as const;

/** Env var names, in one place so the docs above and the code cannot drift. */
export const DEV_BYPASS_ENV = "DEV_AUTH_BYPASS";
export const DEV_BYPASS_REMOTE_DB_ACK_ENV = "DEV_AUTH_BYPASS_ALLOW_REMOTE_DB";

/** Hostnames we treat as a developer's own database. */
const LOCAL_DB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "postgres", "db", "host.docker.internal"]);

/** The DATABASE_URL host, or null when unset/unparseable. Env-only — safe to
 *  call from the proxy/edge path, which must not touch Prisma. */
function databaseHost(): string | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}

export function isLocalDatabase(): boolean {
  const host = databaseHost();
  return host !== null && LOCAL_DB_HOSTS.has(host);
}

let warnedActive = false;
let warnedRefused = false;

/**
 * Whether the bypass is live for this process. Reads env only — no database, no
 * Prisma — so both the Node route path and the proxy path can call it.
 */
export function isDevAuthBypassEnabled(): boolean {
  if (process.env.NODE_ENV !== "development") return false;
  if (process.env[DEV_BYPASS_ENV] !== "true") return false;

  // Gate 3. Refusing loudly beats silently authenticating against production.
  if (!isLocalDatabase() && process.env[DEV_BYPASS_REMOTE_DB_ACK_ENV] !== "true") {
    if (!warnedRefused) {
      warnedRefused = true;
      console.error(
        `\n[auth] ${DEV_BYPASS_ENV}=true was REFUSED — DATABASE_URL points at a remote database ` +
          `(${databaseHost() ?? "unknown host"}), not a local one.\n` +
          `[auth] Bypassing login here would create "${DEV_USER.id}" in that database, expose its real ` +
          `data, and write development scans into production telemetry.\n` +
          `[auth] Point DATABASE_URL at a local database, or set ${DEV_BYPASS_REMOTE_DB_ACK_ENV}=true ` +
          `to proceed anyway with full knowledge of the above.\n`
      );
    }
    return false;
  }

  if (!warnedActive) {
    warnedActive = true;
    console.warn(
      `\n[auth] DEV_AUTH_BYPASS active — using development user "${DEV_USER.id}" (${DEV_USER.email}).\n` +
        `[auth] Authentication is DISABLED for every protected route in this process.\n` +
        (isLocalDatabase()
          ? `[auth] Database: local.\n`
          : `[auth] Database: REMOTE (${databaseHost()}) — acknowledged via ${DEV_BYPASS_REMOTE_DB_ACK_ENV}. ` +
            `Rows written here are real, and "${DEV_USER.id}" scans will land in real telemetry.\n`)
    );
  }
  return true;
}

/**
 * The synthetic session handed to protected routes while the bypass is on.
 * Shaped exactly like the real one (see the session callback in auth.ts) so no
 * route needs to know the difference.
 */
export function devSession() {
  return {
    user: { id: DEV_USER.id, email: DEV_USER.email, name: DEV_USER.name, role: DEV_USER.role },
    expires: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Make sure the dev user exists, since scan_history.userId and
 * capture_rejections.userId are real foreign keys into users.
 *
 * Runs AT MOST ONCE per process: the promise is cached, so concurrent requests
 * share one upsert rather than racing (requirement: no duplicates per request).
 * Prisma is imported lazily so this module stays importable from the proxy path,
 * which must not pull a database client in.
 */
let devUserReady: Promise<void> | null = null;

export function ensureDevUser(): Promise<void> {
  devUserReady ??= (async () => {
    const { prisma } = await import("./prisma");
    await prisma.user.upsert({
      where: { id: DEV_USER.id },
      // Never overwrite an existing row — if something else already owns this
      // id, leave it exactly as it is and let the FK resolve to it.
      update: {},
      create: {
        id: DEV_USER.id,
        email: DEV_USER.email,
        name: DEV_USER.name,
        role: DEV_USER.role,
        // No passwordHash and no OAuth account, so this row cannot be logged
        // into through either provider. It is reachable ONLY via this bypass.
      },
    });
    console.warn(`[auth] DEV_AUTH_BYPASS — development user "${DEV_USER.id}" is present in the database.`);
  })().catch((err) => {
    // Reset so a transient DB error retries on the next request instead of
    // poisoning the process with a permanently rejected promise.
    devUserReady = null;
    throw err;
  });
  return devUserReady;
}
