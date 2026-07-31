import type { NextConfig } from "next";
import { withSentryConfig } from "@sentry/nextjs";

const nextConfig: NextConfig = {
  // Native-binary / large server-only deps pulled in transitively by the
  // fingerprint shadow sensor (src/lib/scanner/fingerprint-match.ts →
  // @huggingface/transformers → onnxruntime-node; sharp is used by the index
  // builder and shares the native-binary concern). Opting them out of Server
  // Component bundling makes Next `require()` them at runtime instead of trying
  // to bundle their native `.node` addons and the 136MB model, which the bundler
  // cannot trace correctly. All three are on Next's built-in auto-external list
  // today, but M1-C's investigation flagged that once server code under src/
  // imports them (which M2-B did) this should be declared explicitly rather than
  // relying on that default.
  serverExternalPackages: ["onnxruntime-node", "@huggingface/transformers", "sharp"],
};

// ─── Sentry build integration ───────────────────────────────────────────────
// The wrapper's job here is limited: register the SDK's webpack/turbopack hooks
// so server and edge code is instrumented, and tunnel browser events through
// our own origin so an ad blocker cannot silently swallow the client reports we
// added this for.
//
// Source-map upload is DISABLED. It requires SENTRY_AUTH_TOKEN plus an org/
// project slug, and with none of those set the plugin would attempt an upload
// on every build and fail it. Server stack traces are readable without it;
// turning it on later is a config change, not a code change.
export default withSentryConfig(nextConfig, {
  silent: !process.env.CI,
  // Route browser events via /monitoring on our own domain. Without this the
  // requests go to ingest.sentry.io, which most blockers drop by default —
  // exactly the client-side errors we have no other way of seeing.
  tunnelRoute: "/monitoring",
  sourcemaps: { disable: true },
  // Strips Sentry's own debug logging from the production browser bundle.
  // (`disableLogger` is the deprecated spelling and is a no-op under Turbopack,
  // which this project builds with.)
  webpack: { treeshake: { removeDebugLogging: true } },
});
