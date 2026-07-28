// ═══════════════════════════════════════════════════════════════════════════
// Shared cron budget + phase-honesty primitives
// ═══════════════════════════════════════════════════════════════════════════
// Born from the M5 budget bug (docs/scanner-v2/M-CATALOG-M5-budget-bug-proposal.md):
// three batch jobs now share ONE serverless invocation because the Vercel Hobby
// plan caps us at two cron entries. Sharing a window means sharing a clock, and a
// clock nobody can be starved by.
//
// Two ideas live here, and they depend on each other:
//
//   1. A deadline that is actually enforceable. The old code checked its budget
//      only BETWEEN units of work, so one call that ran long (a retry sequence
//      against a flaky upstream) consumed the whole run while the budget looked
//      on. Deadlines here are absolute epoch-ms timestamps threaded all the way
//      down into the transport layer, where they clamp per-attempt timeouts and
//      stop retry loops.
//
//   2. A phase that reports whether it actually FINISHED. Without this, #1 is a
//      liability: a phase that stops early still returns its partial findings,
//      and "I found no new sets" reads identically to "there are no new sets".
//      A budget you can enforce but not report on just moves the lie.

/** Whether a phase examined everything it set out to examine. */
export type PhaseStatus =
  /** The full candidate set was examined. Findings are authoritative. */
  | "complete"
  /** Ran out of clock. Findings are a PREFIX of the truth, never a conclusion. */
  | "incomplete_budget"
  /** The phase errored out. Findings (if any) mean nothing. */
  | "failed";

/** Fields every phase reports, whatever else it adds.
 *
 *  `examined`/`total` are what make a phase's findings interpretable: an empty
 *  result set with examined 3 of 174 is not the same claim as an empty result set
 *  with examined 174 of 174, and no consumer should have to guess which it got. */
export interface PhaseReport {
  status: PhaseStatus;
  examined: number;
  total: number;
  /** Present only when status is "failed". */
  error?: string;
}

/** True when the run's clock has run out. The single place this comparison is
 *  spelled out, so no loop invents its own slightly-different version. */
export function outOfTime(deadline: number): boolean {
  return Date.now() >= deadline;
}

/** Milliseconds left, floored at zero. */
export function timeLeft(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/**
 * Classify a phase that ran to the end of its loop without throwing.
 *
 * The rule the whole honesty fix rests on: a phase is "complete" ONLY if it
 * examined everything. Anything less is "incomplete_budget", regardless of how
 * healthy the partial results look.
 */
export function phaseStatus(examined: number, total: number): PhaseStatus {
  return examined >= total ? "complete" : "incomplete_budget";
}

// ─── Provider fetch profiles ────────────────────────────────────────────────
// The scan path and a batch job want OPPOSITE things from a retry, so they get
// different profiles rather than sharing one and hoping.
//
//   Scan path (providers/http.ts defaults — 8 attempts / 8s / 16s): a collector
//   is standing there holding a card. Failing that one request IS the product
//   failure, so paying 16s to rescue it is correct.
//
//   Batch path (below): nobody is waiting, and every item is resumable — rows are
//   processed stalest-first, so anything skipped is simply picked up on the next
//   run. Spending 16s rescuing one card costs ~40 other cards their refresh. The
//   correct behaviour is to fail fast and move on.
//
// These are also always passed WITH a deadline, so the run's clock can cut them
// shorter still.

/** Per-item fetches in a batch sweep. Cheap to give up on; retried tomorrow. */
export const BATCH_FETCH = {
  timeoutMs: 4_000,
  maxAttempts: 3,
  budgetMs: 6_000,
} as const;

/** The set LIST call is not like a per-item fetch: if it fails, the entire
 *  new-set phase learns nothing, so it earns a little more patience. Still
 *  bounded, and still clamped by the phase deadline. */
export const SET_LIST_FETCH = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  budgetMs: 9_000,
} as const;

// ─── Run budget allocation ──────────────────────────────────────────────────

/**
 * Total wall-clock budget for one combined cron invocation.
 *
 * `maxDuration` is 60s (the Vercel Hobby ceiling). 45s leaves 15s of genuine
 * headroom rather than the 5s the standalone catalog cron had — which mattered,
 * because that job's 55s budget could not interrupt an in-flight call and so
 * routinely became a hard 504 at 60s.
 */
export const TOTAL_BUDGET_MS = 45_000;

/**
 * Time RESERVED for each phase that runs after the current one.
 *
 * Allocation is by reservation, not by fixed share, so unused time flows
 * FORWARD: each phase may use everything except what later phases are owed. A
 * fast phase A hands its slack to B and C automatically, while a slow phase A can
 * never starve them — which is precisely the failure the standalone catalog cron
 * shipped with.
 */
const RESERVE_NEW_SETS_MS = 9_000;
const RESERVE_CATALOG_PRICES_MS = 18_000;

export interface RunDeadlines {
  /** Owned/watched card prices — user-visible collection value and alerts. */
  ownedPrices: number;
  /** Catalog new-set detection and import. */
  newSets: number;
  /** Catalog price refresh sweep. */
  catalogPrices: number;
  /** The hard end of the run. */
  total: number;
}

/**
 * Absolute deadlines for the three phases, in the order they run.
 *
 * Phase order is by user impact, because the earlier phase gets the slack:
 * owned/watched prices drive what a collector sees in their archive today, new-set
 * detection keeps the scanner able to recognise a card at all, and the catalog
 * price sweep is pure background maintenance that is resumable by design.
 */
export function allocateRunDeadlines(startedAt: number = Date.now()): RunDeadlines {
  const total = startedAt + TOTAL_BUDGET_MS;
  return {
    ownedPrices: total - RESERVE_NEW_SETS_MS - RESERVE_CATALOG_PRICES_MS,
    newSets: total - RESERVE_CATALOG_PRICES_MS,
    catalogPrices: total,
    total,
  };
}
