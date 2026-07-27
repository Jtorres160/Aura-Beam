// Registers the "@/*" alias resolver hook for the test runner.
import { register } from "node:module";
register("./alias-loader.mjs", import.meta.url);

// Zero out provider-retry backoff so failure-path tests don't sleep through it.
// Only the delays are removed; the retry COUNT is unchanged, so attempt-count
// assertions still exercise the real loop (see src/lib/providers/http.ts).
process.env.PROVIDER_RETRY_BASE_MS ??= "0";
