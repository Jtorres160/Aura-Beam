// Sentry — Edge runtime. Loaded by src/instrumentation.ts.
//
// Aura has no Edge routes today (every route handler runs on Node), but
// middleware and any future `runtime = "edge"` export would initialise here.
// Registering it now costs nothing and means an Edge error is never silently
// dropped the day one appears.
import { Sentry } from "@/lib/observability/sentry";
import { serverDsn, serverOptions } from "@/lib/observability/sentry-options";

const dsn = serverDsn();
if (dsn) Sentry.init(serverOptions(dsn));
