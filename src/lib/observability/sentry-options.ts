// ─── Sentry init options, in one place ───────────────────────────────────────
// Aura had no error monitoring at all: a 500 in the scan pipeline, a Prisma
// outage, or a client-side render crash only became known if a tester emailed
// us about it. Everything below exists to close that gap and nothing more —
// tracing and session replay are deliberately OFF (see `tracesSampleRate`).
//
// The DSN is the on/off switch. When it is absent, `init()` is never called at
// all (see the three config files that consume this), so a developer without a
// DSN runs exactly the app they ran before: no SDK client, no queued events, no
// network attempts, no console noise. This is why every caller checks `dsn`
// rather than relying on Sentry's own "empty DSN disables the SDK" behavior —
// that path still installs integrations and instruments globals.

import type { BrowserOptions, NodeOptions } from "@sentry/nextjs";

/**
 * The DSN for server/edge code. `SENTRY_DSN` is preferred so the server DSN can
 * be rotated without a rebuild; `NEXT_PUBLIC_SENTRY_DSN` is accepted as a
 * fallback so a single-variable deployment works.
 */
export function serverDsn(): string | undefined {
  return process.env.SENTRY_DSN || process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

/**
 * The DSN for browser code. Must be `NEXT_PUBLIC_` — it is inlined at build
 * time, so changing it requires a redeploy.
 */
export function clientDsn(): string | undefined {
  return process.env.NEXT_PUBLIC_SENTRY_DSN || undefined;
}

/**
 * A scan request body carries the captured card image as a base64 data URI —
 * tens to hundreds of KB of a photo taken in someone's home. None of that
 * belongs in an error tracker, and it would blow the event size limit anyway.
 *
 * `sendDefaultPii` is left at its default (false), which already keeps request
 * bodies and headers out of events. This is the second line of defence for the
 * case where a data URI reaches Sentry some other way — inside an error
 * message, a breadcrumb, or a context object we attached by hand. Anything that
 * looks like inline image bytes is replaced with a marker of its size, so the
 * fact that an image was involved survives while the image itself does not.
 */
const DATA_URI = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+/g;

export function redactImageData<T>(value: T, depth = 0): T {
  // Bounded: events are arbitrary user-shaped objects, and a cycle or a very
  // deep structure must not take the process down inside beforeSend.
  if (depth > 6) return value;
  if (typeof value === "string") {
    // `replace` (never `test`) — a /g regex carries lastIndex across `.test()`
    // calls, which would make redaction depend on how many strings preceded it.
    return value.replace(DATA_URI, (m) => `[image redacted: ${m.length} chars]`) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactImageData(v, depth + 1)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) out[k] = redactImageData(v, depth + 1);
    return out as unknown as T;
  }
  return value;
}

/** Options shared by the browser, Node and Edge clients. */
function baseOptions() {
  return {
    // Distinguishes a tester's production error from a developer's local one.
    // VERCEL_ENV is "production" | "preview" | "development" on Vercel.
    environment: process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.VERCEL_ENV || process.env.NODE_ENV,
    // Ties an event to the deploy that produced it. Undefined off Vercel, which
    // Sentry handles as "no release" rather than guessing one.
    release: process.env.NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA || process.env.VERCEL_GIT_COMMIT_SHA,
    // Performance tracing is explicitly out of scope for this pass. 0 means
    // spans are never sampled, so no performance data is collected or billed;
    // this is a deliberate value, not an unset default.
    tracesSampleRate: 0,
    // Errors only. A scan image must never leave the app inside an event.
    sendDefaultPii: false,
    beforeSend: <T,>(event: T) => redactImageData(event),
    beforeBreadcrumb: <T,>(crumb: T) => redactImageData(crumb),
  };
}

export function serverOptions(dsn: string): NodeOptions {
  return { dsn, ...baseOptions() };
}

export function browserOptions(dsn: string): BrowserOptions {
  return {
    dsn,
    ...baseOptions(),
    // No replayIntegration / feedbackIntegration: session replay is out of
    // scope, and scan feedback is collected by Aura's own form (which writes to
    // ScanFeedback) rather than by a second, unqueryable widget.
  };
}
