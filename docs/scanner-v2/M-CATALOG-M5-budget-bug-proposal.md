# M5 refresh-catalog — budget bug: diagnosis and fix proposal

**Status:** IMPLEMENTED, superseding PR #7's approach. The Vercel plan question came back **Hobby, 2-cron cap**, so rather than adding a third entry the catalog work was consolidated into `/api/cron/update-prices` as two sequential phases. PR #7's `vercel.json` entry has been reverted; the crons array is back to two.

**Date:** 2026-07-28

> **Sections 1–2 (diagnosis) stand as written.** Section 3's design was implemented
> with the changes recorded in §8, which also lists what consolidation surfaced that
> the original numbers did not account for — including two live production bugs
> found while auditing `update-prices` as a neighbour.

---

## 1. What is actually broken

`/api/cron/refresh-catalog` cannot honour its own wall-clock budget, because **`TOTAL_BUDGET_MS` is only checked between units of work, never inside a network call.** Every deadline check in the route sits at the top of a loop body:

```ts
for (const meta of sets)  { if (Date.now() > deadline) break; ... }   // phase 1
for (const row of rows)   { if (Date.now() > deadline) break; ... }   // phase 2
```

A call that is already in flight when the deadline passes runs to its own completion. Since PR #2 merged (2026-07-27 — **after** M5 was built and tested), those calls got dramatically longer.

### The compounding

Two independently-reasonable retry layers now stack in `catalog-sync.ts`:

| Layer | Where | Config | Worst case |
|---|---|---|---|
| Transport | `fetchProviderJson` (`providers/http.ts`) | 8 attempts, `RETRY_BUDGET_MS` 16s, `PROVIDER_TIMEOUT_MS` 8s/attempt | ~16s, +8s if the last attempt starts just under budget |
| Orchestration | `withRetry` (`catalog-sync.ts`) | `tries: 3`, `baseMs: 1500` → backoff 1.5s, 3s | ×3 |

**One logical `fetchAllSets()` call ≈ 3 × 16s + 4.5s ≈ 52s** — the entire 55s budget, spent before phase 1's loop runs a single iteration.

This is the only place in the codebase where the two layers compose. `withRetry` wraps `fetchProviderJson` at exactly two sites (`catalog-sync.ts:108` in `fetchAllSets`, `:135` in `fetchSetCards`). The scan path (`pokemon.ts`, `scryfall.ts`, `yugioh.ts`) calls `fetchProviderJson` directly — single layer, as PR #2 intended.

### Evidence (Vercel production runtime logs, not inference)

```
[CRON] refresh-catalog starting (dry run)...
[Provider] timeout on attempt 1/8 — retrying in 341ms: .../v2/sets?pageSize=250...
…list sets attempt 1 failed (No response within 8000ms); retrying in 1500ms
[Provider] http_error on attempt 1/8 ... 2/8 ... 3/8 ... 4/8 ... 5/8
…list sets attempt 2 failed (No response within 8000ms); retrying in 3000ms
[CRON] refresh-catalog done — new-set imported 0, prices refreshed 0.
```

Three distinct outcomes observed across ~8 real invocations:

- **200, `examined: 0`** — `fetchAllSets` succeeds at ~52s; phase 2 breaks on its first deadline check.
- **200, `[CRON] new-set sync phase error: No response within 8000ms`** — all 3 `withRetry` attempts failed.
- **504 `Vercel Runtime Timeout Error: Task timed out after 60 seconds`** — phase 2 *was* reached, visibly fetching `base1-1` … `base1-7`, each burning up to 16s, function hard-killed.

### Phase 2's query is healthy — ruled out directly against production

```
POKEMON rows: 20479,  priceUpdatedAt null: 0
phase-2 query returned: 300 rows
first 8 (stalest): base1-1, base1-2, base1-3, base1-4, base1-5, base1-6, base1-7, base1-8
oldest priceUpdatedAt: 2026-07-21T23:13:48.997Z
```

Not a staleness bug, not a zero-match bug. `batchSize: 300` in the response always proved the query returned rows, and the stalest IDs match exactly the cards the 504 logs show phase 2 fetching. The query works; the loop is starved.

---

## 2. The defect list

### Bug A — price refresh never runs
Phase 1 consumes the budget; phase 2 breaks immediately. `examined: 0`. **Impact:** the cron's primary purpose never executes.

### Bug B — `detected: []` is a false negative *(trust violation)*
When the budget dies in or just after `fetchAllSets`, the per-set loop breaks on iteration 1 and the response reports:

```json
"newSets": { "detected": [], "wouldSync": [], "imported": 0 }
```

That is **indistinguishable from a genuinely current catalog.** A new Pokémon set could go undetected indefinitely while the cron reports `success: true`. This is a non-answer presented as a negative answer — the same class as the "failed provider ≠ missing card" rule in AGENTS.md, and not visible from the response at all. **This is the most serious defect here**, and it is the reason this is a design pass rather than a tuning change.

### Bug C — function hard-timeout (504)
`maxDuration = 60` against a 55s internal budget leaves 5s of headroom, but the budget can't interrupt an in-flight call. A fetch starting at 54s runs up to 16s more. **In a real (non-dry) run this kills the function mid-write, with no report of what was written.**

### Bug D — the non-dry new-set path can never complete *(newly found, previously untested)*
`syncSet` accepts no deadline. It lists a set, then upserts every card with `delayMs` between them:

```
NEW_SET_MAX_PER_RUN 3 × ~250 cards × NEW_SET_DELAY_MS 250ms ≈ 187s of sleeps alone
```

against a 60s `maxDuration`. **Whenever a new set actually exists, the real sync path is guaranteed to 504.** M5's `?dry=1` verification skips `syncSet` entirely (`if (dryRun) return …` before the loop), so this path has never run in production. The M5 report's "built and verified" covers the dry path only.

---

## 3. Proposal

Three parts. Parts 1 and 2 are required to merge PR #7; part 3 is the judgment call I want your read on.

### Part 1 — Make the budget interruptible: one clock, threaded down

**Principle: there should be exactly one deadline for a run, and every layer should respect it. Today each layer has its own independent budget and none of them know about the run.**

Add an **optional** deadline to the transport layer:

```ts
export async function fetchProviderJson<T = any>(
  url: string,
  opts: {
    headers?: Record<string, string>;
    emptyStatuses?: number[];
    deadline?: number;   // epoch ms — the RUN's clock, not this call's
    signal?: AbortSignal;
  } = {},
): Promise<T | null>
```

Behaviour when `deadline` is supplied:
- **Per-attempt timeout** becomes `min(PROVIDER_TIMEOUT_MS, deadline - now)` — so a hung request can't overrun the run. Implemented by combining `AbortSignal.timeout(...)` with the caller's signal via `AbortSignal.any([...])`, so an in-flight `fetch` is genuinely cancelled rather than merely abandoned.
- **Before each retry**, stop if `deadline - now <= 0` (no more attempts) or if the remaining time can't fit a backoff plus a minimum attempt.
- The error thrown on giving up carries a distinguishable reason (`deadline_exceeded`) so callers can tell "the source didn't answer" from "we ran out of time to ask" — those are different facts and Bug B is what happens when they're conflated.

**When `deadline` is absent, behaviour is byte-identical to today.** The scan path passes no deadline, so PR #2's tuning and its measured ~0.2% residual failure rate are untouched. This keeps the blast radius at the two `catalog-sync` call sites.

Then, in `catalog-sync.ts`:

- **Delete the `withRetry` wrapper around `fetchProviderJson`.** It is redundant duplication now — `fetchProviderJson` already retries 8×. One retry layer, one clock. (`withRetry` itself can stay for non-transport uses if any remain; if not, it goes.)
- Thread `deadline` through `fetchAllSets`, `fetchSetCards`, `syncSet`, and `existingIdsForSet`.
- `syncSet` checks the deadline in its per-card loop and returns `{ ..., incomplete: true }` when it stops early. It is already resumable via `existingIdsForSet` + `resume: true`, so a partial import is a correct, resumable state — this is the fix for Bug D. The cron's changed-set path currently passes `resume: false`; that needs revisiting so a partial run resumes rather than restarting.

**Per-phase sub-budgets.** Rebalancing alone doesn't fix anything (it just moves where it breaks), but once the deadline is actually enforceable, phase 1 must not be *able* to eat the whole run:

```ts
const PHASE1_DEADLINE = start + 0.35 * TOTAL_BUDGET_MS;   // new-set detection
const PHASE2_DEADLINE = start + TOTAL_BUDGET_MS;          // price refresh
```

Phase 1 is cheap in the healthy case (~2.5s: 174 sequential probes at iad1↔us-east-2 latency) and its work is rare. Phase 2 is the recurring workload and should own most of the budget.

**Widen the platform headroom.** `maxDuration = 60` with a 55s budget is too tight once we accept that cancellation isn't instantaneous. Either raise `maxDuration` or drop `TOTAL_BUDGET_MS` to ~45s. I lean toward dropping the internal budget — it keeps us inside the platform default and the job is resumable by design.

**Optional, worth considering separately:** phase 1 currently issues **174 sequential round trips just to discover nothing needs doing**, every single day. A single `groupBy`/`findMany` over the stored `sourceUpdatedAt` values collapses it to one query and makes the phase-1 budget question mostly moot. I flagged this earlier as out of scope; it's now cheap enough relative to the rest of this change that it may be worth folding in. Your call — it is a genuine behaviour change to detection, not a pure refactor.

### Part 2 — Bug B: a phase must report its own completeness

The response needs a third state. Today it has "N sets synced" and "no sets need syncing"; it needs "**I did not finish looking, do not trust this**".

```ts
type PhaseStatus =
  | "complete"           // the full candidate set was examined
  | "incomplete_budget"  // ran out of clock — results are a PREFIX, not an answer
  | "failed";            // the phase errored out
```

Applied to both phases:

```jsonc
{
  "success": true,
  "complete": false,               // ← false if ANY phase is not "complete"
  "dryRun": true,
  "newSets": {
    "status": "incomplete_budget",
    "setsChecked": 3,              // ← the number that makes `detected` interpretable
    "setsTotal": 174,
    "detected": [],
    "imported": 0
  },
  "prices": {
    "status": "incomplete_budget",
    "batchSize": 300,
    "examined": 0,
    "refreshed": 0, "skipped": 0, "failed": 0
  }
}
```

Rules this enforces:
- **`detected: []` is only meaningful when `status === "complete"`.** With `setsChecked: 3 / setsTotal: 174` in the payload, "we found nothing" can no longer be read as "there is nothing".
- **`success` stops being the health signal**; `complete` is. `success` continues to mean "the handler didn't throw" — that's what it has always actually meant, and conflating the two is how this hid.
- An incomplete run logs at **`warn`**, not `info`, with the counts — so it's greppable in Vercel logs without a dry run.

**Before implementing, I want to check what currently consumes this cron's success signal** — if the admin surface reads it, it inherits the same lie and needs the same three-state treatment. (Per the analytics truth boundary: never invent a number, a cause, *or* infrastructure.)

### Part 3 — Were PR #2's retry parameters ever meant for a batch job?

**My read: no, and they shouldn't be treated as sacred here.**

PR #2's tuning is documented in `providers/http.ts` and is well-argued *for the scan path*:

> 8 attempts against ~45% per-request failure leaves ~0.45^8 ≈ 0.17% residual … 8 attempts takes that demo-session risk from ~33% to ~3%.

That optimises for **"never fail this one request"** — a collector is standing there holding a card, and a failure is a visible product failure. Paying 16s to rescue one request is obviously correct.

A budgeted batch job has the **opposite** objective: **"make steady progress across many items."** Nobody is waiting. The job is explicitly resumable — rows are processed stalest-first, so anything skipped is simply picked up tomorrow. Spending 16s rescuing `base1-1` costs ~80 other cards their refresh. The correct batch behaviour is to **fail fast and move on**.

So I propose a distinct batch profile, passed explicitly rather than inherited:

| | Scan path (unchanged) | Batch path (proposed) |
|---|---|---|
| Attempts | 8 | 2–3 |
| Per-attempt timeout | 8s | 3–4s |
| Call budget | 16s | ~6s, and clamped by the run deadline |
| On give-up | surface `provider_unavailable` | skip the item, count it, continue |

Two caveats I want to be explicit about:

1. **`fetchAllSets` is not like the others.** It is a single point of failure for all of phase 1 — if it fails, nothing gets checked. It may deserve a more generous profile than the per-card fetches. But it must still be bounded by the phase-1 sub-budget, and its failure must produce `status: "failed"`, never `detected: []`.
2. **Lower retry counts mean more skipped cards per run** while the upstream is degraded. That is acceptable *only because* the job is resumable and reports honestly — which is exactly what Part 2 delivers. The two parts depend on each other.

---

## 4. Separate ticket (not fixed here)

`api.pokemontcg.io` answers **locally in ~1.2s** but **constantly 8s-timeouts from Vercel iad1**, despite `POKEMON_TCG_API_KEY` being set in Production. That asymmetry smells like egress-IP throttling of Vercel's shared ranges rather than a general outage.

This is what *triggers* the retry explosion, and it plausibly also affects the live scan path whenever the local catalog misses. **It deserves its own investigation** — but the fix proposed here is required regardless: an unenforceable budget turns any upstream degradation into a silent no-op or a 504.

---

## 5. Test plan

Existing coverage is 12 tests in `catalog-sync.test.ts`, all with stubbed fetch — none exercise the budget, which is why this shipped.

New tests (all offline, injected clock + stubbed fetch — the DB is production, so no test touches it):

1. `fetchProviderJson` with a deadline already passed → throws `deadline_exceeded` **without issuing a fetch**.
2. `fetchProviderJson` with a deadline mid-retry → stops retrying at the deadline, doesn't run all 8 attempts.
3. **Regression:** `fetchProviderJson` with **no** deadline → attempt count and backoff identical to today (locks PR #2's scan-path behaviour).
4. Phase 1 with a budget that expires during `fetchAllSets` → `status: "incomplete_budget"`, `setsChecked < setsTotal`, and **`complete: false`** — asserting specifically that an empty `detected` is never reported as `"complete"`.
5. Phase 1 where `fetchAllSets` throws → `status: "failed"`, not an empty `detected`.
6. Phase 2 gets a non-zero sub-budget even when phase 1 exhausts its own.
7. `syncSet` stopping at a deadline → `incomplete: true`, partial `upserted`, and a follow-up `resume: true` run continues rather than restarting.

---

## 6. Verification (no local-environment proxying)

Local timing gave a misleading answer once already. Verification is on Vercel only:

1. Deploy the fix, run `?dry=1` against production.
2. **Accept only:** `complete: true`, `newSets.setsChecked === newSets.setsTotal`, and `prices.examined > 0`.
3. Cross-check with `vercel logs <deployment>` — no `Vercel Runtime Timeout Error`, and function duration comfortably under `maxDuration`.
4. Repeat during a degraded-upstream window; confirm the response reports `incomplete_budget` **honestly** rather than an empty `detected`.
5. Only then wire `vercel.json` (PR #7) — plus the still-open question of whether the Vercel plan permits a 3rd cron.

`vercel logs <deployment>` works without `CRON_SECRET`; the production secret is a Vercel **Sensitive** env var and is unreadable by the CLI, the dashboard, or the account owner, so authenticated calls to prod have to be run by you.

---

## 7. Open questions

1. **Fold in the phase-1 N+1 fix** (174 probes → 1 query), or keep this change tightly scoped to the budget bug?
2. **`maxDuration` up, or `TOTAL_BUDGET_MS` down?** I lean budget down to 45s.
3. **Batch retry profile:** are 2–3 attempts / 3–4s acceptable, given skipped cards are retried tomorrow?
4. **Does anything besides Vercel's scheduler consume this cron's `success` field?** If the admin surface does, it needs the three-state treatment too.
5. **Bug D scope:** fixing the new-set path properly means multi-run resumable imports. In scope here, or its own milestone? It is currently 100% broken in the non-dry path, so it can't just be left.

---

## 8. What consolidation changed (implementation record)

### Two live production bugs found auditing `update-prices` as a neighbour

Both are in the "the job claimed more than it did" family, same as bug B.

**Bug E — `card.game === "Pokemon"` never matched.** Production stores `"POKEMON"`
(verified: 36 POKEMON / 84 MTG / 11 YUGIOH). Every Pokémon card fell through all
three branches, contributed nothing, and the run still reported `success: true`.
**Every Pokémon card in every collection has gone un-repriced for the life of this
cron.** Fixed via `normalizeGame()` (case-insensitive, unknown game → null → counted
as skipped, never guessed).

**Bug F — `update-prices` had no `maxDuration` and no deadline of any kind.** It
ran under the platform default while processing up to 250 cards, each of which
could take 16s of transport retries after PR #2. It is now a budgeted phase like
the others, and the route exports `maxDuration = 60`.

### Numbers that changed from §3

| | §3 (catalog cron alone) | Implemented (3 phases) |
|---|---|---|
| `TOTAL_BUDGET_MS` | ~45s lean | **45s**, unchanged |
| Allocation | fixed phase shares | **reservation-based** — later phases hold a floor, slack flows forward |
| `maxDuration` | open question | **60s explicit** on both routes |

Allocation by reservation rather than fixed share was the one design change: with
three phases, fixed shares would idle the window whenever an early phase finished
fast. Each phase now may use everything except what later phases are owed
(`RESERVE_NEW_SETS_MS` 9s, `RESERVE_CATALOG_PRICES_MS` 18s), so a fast phase hands
its slack forward and a slow one still cannot starve anyone.

Real workload measured against production: **51 owned/watched cards** (not the 250
cap), so phase A's reservation is generous today.

### Open question 4 answered

Nothing consumes the cron's `success` field. `admin/stats` reads only `vercel.json`
and already reports `lastExecution: null` deliberately. No inherited lie. Its label
was updated, since "Price History Update" no longer describes the job.

### ⚠️ Structural finding this surfaced — catalog sweep rate

Not a bug, and **not fixed here**, but it changes what the catalog phase is worth:

```
20,479 catalog rows ÷ ~50-150 cards per nightly window ≈ 4-12 MONTHS per full sweep
```

`PRICE_DELAY_MS` (150ms) plus fetch time means one serverless window can never
approach the 300-row cap. The old 55s budget couldn't either — this is pre-existing,
not a regression from the 45s budget. But since `CATALOG_LOCAL_ENABLED=1` makes
catalog prices **user-visible on Pokémon scans**, a months-long sweep is a real
freshness problem.

Deliberately left alone rather than silently redesigned inside a consolidation
ticket. Options, cheapest first: bounded concurrency (5–8 parallel fetches) for
~1,000 cards/window; drop `PRICE_DELAY_MS` now that an API key is configured; or
prioritise cards that matter (recently scanned or owned) over a uniform sweep.
Worth its own ticket.

### Still open

- The **egress-throttling** question from §4 (local 1.2s vs Vercel 8s timeouts) is
  untouched and still deserves its own investigation.
- Verification per §6 has NOT been run — it needs a deploy and a prod `?dry=1`,
  and the production `CRON_SECRET` is a Vercel Sensitive variable that only you
  can use.
