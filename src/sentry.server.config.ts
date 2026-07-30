// Sentry — Node.js server runtime. Loaded by src/instrumentation.ts.
import { Sentry } from "@/lib/observability/sentry";
import { serverDsn, serverOptions } from "@/lib/observability/sentry-options";

const dsn = serverDsn();
// No DSN configured → the SDK is never initialised. See sentry-options.ts for
// why this is an explicit guard rather than passing an empty DSN.
if (dsn) Sentry.init(serverOptions(dsn));
