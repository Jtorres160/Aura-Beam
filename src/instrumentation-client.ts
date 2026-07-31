// ─── Browser instrumentation (Next 16 file convention) ───────────────────────
// Runs after the document loads and before React hydrates, so a crash during
// hydration — the class of bug that renders a blank screen and produces no
// server log at all — is still captured.

import { Sentry } from "@/lib/observability/sentry";
import { browserOptions, clientDsn } from "@/lib/observability/sentry-options";

const dsn = clientDsn();
if (dsn) Sentry.init(browserOptions(dsn));

// Navigation breadcrumbs: which route the collector was on when it broke.
// Safe to export unconditionally — with no DSN there is no client, and the
// call is a no-op.
export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;
