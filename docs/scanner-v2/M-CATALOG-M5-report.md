# M-CATALOG · M5 — catalog freshness cron

Keep `catalog_cards` fresh without a human re-running `build-catalog.mjs`: new
sets + price updates on a schedule, same failure-tolerant shape as the existing
price cron. **Catalog freshness only** — `CATALOG_LOCAL_ENABLED`, candidate
generation, and the selection re-fetch are untouched.

## 1. Investigation: reuse `update-prices`, or a sibling job?

`update-prices` ([route](../../src/app/api/cron/update-prices/route.ts)) refreshes
`Card`/`CardPrice`/`PriceHistory` for cards a user **owns or watches** — collection
value + price alerts. It never reads or writes `catalog_cards` (a separate
reference table keyed on `externalId`; see §4 of the investigation). So there is
nothing on `Card` to extend for the catalog — it needs a **sibling job**. The
finding matches the investigation's own §7 note ("M5 extends it" = mirror the
*pattern*, not the same rows).

What IS reused is the pattern, verbatim: mandatory `CRON_SECRET` guard, a bounded
per-run batch ordered stalest-first, and per-item failure isolation.

## 2. What was built

**`src/lib/services/catalog-sync.ts`** — the enumerate → list → normalize →
upsert core, factored **out of** `build-catalog.mjs` so the CLI and the cron run
the *same* code path (no reimplementation — the M-CATALOG ground rule). Exports
`fetchAllSets`, `fetchSetCards`, `upsertCatalogCard`, `syncSet`,
`findSetSyncState`, `setNeedsSync`, `classifyFailure`. Still a thin wrapper over
`fetchProviderJson` (classified 8 s timeout) + `formatPokemonCard` (the scan
path's own formatter), so the catalog can't drift from what candidate generation
expects.

**`scripts/build-catalog.mjs`** — refactored to a pure driver (flag parsing,
resume policy, run report) that imports the shared core. Behavior unchanged;
`--help` and the import graph verified.

**`src/app/api/cron/refresh-catalog/route.ts`** — the M5 cron, two self-contained
phases:

1. **New-set sync.** `fetchAllSets` → per-set `findSetSyncState` → `setNeedsSync`
   flags sets missing from the catalog **or** whose upstream `set.updatedAt` is
   newer than the stored `sourceUpdatedAt`. Needy sets (newest release first,
   capped `NEW_SET_MAX_PER_RUN = 3`) are imported via `syncSet(resume:false)` —
   the same import path as `build-catalog.mjs`.
2. **Price refresh.** Stalest `catalog_cards` first (`priceUpdatedAt asc nulls
   first`, capped `PRICE_MAX_CARDS_PER_RUN = 300`, `PRICE_DELAY_MS` between calls),
   re-fetched via `getPokemonCardById` + `formatPokemonCard().price` and updated
   in place.

## 3. Staleness / failure handling (the truth boundary)

- **Failed price fetch → stored price left ALONE.** `getPokemonCardById` returns
  `null` on any upstream failure; a null card or an absent `marketPrice` is
  `skipped`, never written. The stale price is never nulled and never zeroed by a
  non-answer. A stale/missing price degrades a scan to the live path — it never
  fails one.
- **One bad card never fails the batch/set.** `syncSet` classifies + skips a
  failing card (`failures[]`); a failing price `update` is caught per-row. One bad
  card never nulls a good one.
- **One bad set never fails the run.** A set that can't be *listed* throws out of
  `syncSet`; the cron records it as a failed set and continues.
- **One phase never kills the other.** Each phase has its own try/catch; a phase
  error is reported, the other still runs. The top-level 500 is only for the truly
  unexpected.
- **Wall-clock budget.** `TOTAL_BUDGET_MS = 55 s` (route `maxDuration = 60`): the
  cron stops *launching* new work past the deadline; the rest is picked up next
  run (stalest-first ⇒ resumable, steady progress across the whole catalog).
- **No churn on unknown.** `setNeedsSync` treats an unreadable/missing upstream
  timestamp as "not a change" — an existing set is only re-synced on real evidence
  it changed.
- **Change detection cost.** ~174 indexed `findFirst` per run (one per set); a
  normal run finds zero new sets and does no import work.

## 4. Verification (no production writes)

- `tsc --noEmit` clean.
- Full suite green — **360 pass / 0 fail**, incl. new
  `src/lib/services/catalog-sync.test.ts` (12 tests: failure isolation, resume,
  change detection, `findSetSyncState`, `classifyFailure`) — all with injected
  fakes + a stubbed `fetch`; no live DB, no network.
- `next build` succeeds; `/api/cron/refresh-catalog` registered as a dynamic
  function route.
- `eslint` clean on the new files; `build-catalog.mjs --help` runs (import graph
  through the shared module resolves).

**Dry-run approach (flagged):** the route accepts `?dry=1`, which performs the
reads + upstream fetches but **skips every catalog write**, reporting what *would*
change. It was **not executed against production** — even a dry run reads the
production DB + hits `api.pokemontcg.io`, and per M5 discipline the route is held
for sign-off. It exists so the pipeline can be exercised safely once someone
chooses to. All verification above is local and touches neither.

## 5. Not done (held for explicit sign-off)

- **`vercel.json` NOT modified** — the schedule is not live. To enable after
  sign-off, add:
  ```json
  { "path": "/api/cron/refresh-catalog", "schedule": "0 7 * * *" }
  ```
  (07:00 UTC — after `update-prices` 06:00 and `analyze-scans` 06:30, so the three
  crons don't overlap.) `CRON_SECRET` is already set in prod (used by the other
  two crons), so no new env is required.
- `CATALOG_LOCAL_ENABLED` stays OFF (M6). M5 makes the catalog *maintainable*; the
  flag flip that puts it on the scan path is still a separate, reviewed decision.
