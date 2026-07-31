// ─── Server instrumentation (Next 16 file convention) ────────────────────────
// `register()` runs once per server instance, before the first request is
// handled. `onRequestError` is Next's hook for every error the server captures —
// route handlers, Server Component renders, and Server Actions — so it covers
// the failures that never reach a try/catch we wrote.
//
// The scan pipeline's own failures are reported separately and more precisely
// (src/lib/observability/scan-report.ts): by the time a scan error reaches here
// it has already been classified, persisted and turned into an honest user
// message, and the stage is the only thing that makes it actionable.

import { Sentry } from "@/lib/observability/sentry";

export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }
  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;
