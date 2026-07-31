// Registers the "@/*" alias resolver hook for the test runner.
import { register } from "node:module";
register("./alias-loader.mjs", import.meta.url);

// Zero out provider-retry backoff so failure-path tests don't sleep through it.
// Only the delays are removed; the retry COUNT is unchanged, so attempt-count
// assertions still exercise the real loop (see src/lib/providers/http.ts).
process.env.PROVIDER_RETRY_BASE_MS ??= "0";

// Force off the local-catalog fast path so provider tests observe the fetch
// calls they stub. @prisma/client auto-loads .env on import, and this repo's
// .env sets CATALOG_LOCAL_ENABLED=1 (a prod-only flag) — without this override
// the catalog answers lookups from prod Supabase and issues zero fetches.
process.env.CATALOG_LOCAL_ENABLED = "0";
