// Production Telemetry Analysis Layer (Phase 5.14).
//
// PURPOSE: MEASUREMENT, not optimization. This module aggregates the records
// that the scanner already writes (buildScanTelemetry → ScanTelemetryV1, stored
// as JSON in ScanHistory.ocrText) and answers the Phase 5.14 questions: which
// provider is slow, which provider fails, where scan latency goes, and whether
// a failure was a provider problem or a genuine absence.
//
// It is analysis ONLY. It does NOT — and CANNOT — change provider selection,
// evidence weights, confidence thresholds, ranking, caching or retry behavior.
// It reads telemetry; it never writes it and never feeds back into a scan.
// Nothing here runs in a scan's request path.
//
// It is deliberately game-agnostic: MTG, Pokémon and Yu-Gi-Oh records flow
// through the same aggregation. Game only ever appears as a GROUPING KEY in the
// output, never as an `if (game === …)` branch. Adding a game needs no change.
//
// ─── THE TRUTH BOUNDARY APPLIES TO MEASUREMENT TOO ──────────────────────────
//
// Phase 5.13C established that a failed provider must never become a missing
// card. The same asymmetry governs this module, one level up:
//
//   A PROVIDER WE HAVE NO RECORDS FOR MUST NEVER REPORT 0ms.
//
// An absent measurement and a measurement of zero are different claims, and
// collapsing them here would reproduce — in the tooling meant to detect it —
// exactly the error 5.13C deleted from the product. So every statistic in this
// module is nullable, `null` means "we did not measure this", and the formatter
// prints "no data" rather than a number. A report that cannot support a claim
// must decline to make it.
//
// This matters immediately and concretely: at Phase 5.14's start, ZERO stored
// records carried candidateSources or candidateStatus. A mean-of-empty
// implementation would render that state as a confident table of 0ms latencies
// and a 0% failure rate — which reads as "all providers are instant and
// perfect" instead of "we have not measured anything yet". `coverage` exists to
// make that distinction impossible to miss.
//
// The rule extends past the numbers to the PROSE: a warning states an absence,
// it does not explain one (see warningsFrom). Explaining is where a measurement
// tool starts inventing, and the first thing it invented was reassurance.

import {
  CANDIDATE_SOURCE_LABELS,
  type CandidateOutcome,
  type CandidateSourceId,
  type CandidateSourceStatus,
} from "@/lib/scanner/candidates";
import type { ProviderFailureReason } from "@/lib/providers/http";
import type { ScanTelemetryV1 } from "@/lib/scanner/telemetry";

// ─── Input ───────────────────────────────────────────────────────────────────
// The smallest shape carrying what analysis needs: when the scan happened (the
// grouping key for time series, from ScanHistory.createdAt) and the telemetry
// record itself. Deliberately NOT the Prisma row: this module must stay pure
// and testable from fixtures, and must never import a database client.

export interface TelemetrySample {
  /** When the scan happened — ScanHistory.createdAt. */
  at: Date;
  telemetry: ScanTelemetryV1;
}

/** Every field is optional; an omitted field does not constrain the set. */
export interface TelemetryFilter {
  /** Inclusive lower bound on `at`. */
  from?: Date;
  /** Exclusive upper bound on `at`. */
  to?: Date;
  /** Match ScanTelemetryV1.game exactly. */
  game?: string;
  /** Keep only samples that consulted this source. */
  source?: CandidateSourceId;
  /** Keep only samples with this candidate status. */
  status?: CandidateOutcome["status"];
}

export function filterSamples(samples: TelemetrySample[], filter: TelemetryFilter = {}): TelemetrySample[] {
  return samples.filter((s) => {
    if (filter.from && s.at < filter.from) return false;
    if (filter.to && s.at >= filter.to) return false;
    if (filter.game && s.telemetry.game !== filter.game) return false;
    if (filter.status && s.telemetry.candidateStatus !== filter.status) return false;
    if (filter.source && !(s.telemetry.candidateSources ?? []).some((c) => c.source === filter.source)) {
      return false;
    }
    return true;
  });
}

// ─── Distribution ────────────────────────────────────────────────────────────

/**
 * A summary of a set of measurements.
 *
 * Every statistic is nullable and `null` means "not measured" — see the truth
 * boundary note above. `count` is the ONLY field that is meaningfully zero,
 * because "we have zero measurements" is itself a measured fact.
 */
export interface Distribution {
  /** How many measurements this summary rests on. */
  count: number;
  mean: number | null;
  median: number | null;
  /** 95th percentile, nearest-rank. Null below `P95_MIN_SAMPLES`. */
  p95: number | null;
  min: number | null;
  max: number | null;
}

/**
 * Below this many samples a "p95" is not a percentile, it is just the maximum
 * wearing a statistical costume — with n=3 the nearest-rank p95 IS max(). That
 * number would invite exactly the false confidence this phase exists to
 * prevent, so we decline to report it and say so.
 */
export const P95_MIN_SAMPLES = 20;

const EMPTY_DISTRIBUTION: Distribution = { count: 0, mean: null, median: null, p95: null, min: null, max: null };

export function summarize(values: number[]): Distribution {
  const clean = values.filter((v) => Number.isFinite(v));
  if (clean.length === 0) return { ...EMPTY_DISTRIBUTION };

  const sorted = [...clean].sort((a, b) => a - b);
  const n = sorted.length;
  const mid = Math.floor(n / 2);

  return {
    count: n,
    mean: clean.reduce((a, b) => a + b, 0) / n,
    median: n % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid],
    // Nearest-rank: the smallest value at or below which 95% of the data sits.
    p95: n >= P95_MIN_SAMPLES ? sorted[Math.ceil(0.95 * n) - 1] : null,
    min: sorted[0],
    max: sorted[n - 1],
  };
}

// ─── Field coverage ──────────────────────────────────────────────────────────

/**
 * How many samples actually carry each optional telemetry field.
 *
 * This is the report's honesty check and the first thing a reader should look
 * at. Every 5.13C field is optional and additive (older records omit it), so a
 * statistic derived from `candidateSources` describes ONLY the subset that has
 * it. Without these denominators, "Scryfall: 0 failures" is unreadable — it
 * could mean a perfect provider or an empty dataset.
 */
export interface FieldCoverage {
  samples: number;
  withGame: number;
  withCandidateSources: number;
  withCandidateStatus: number;
  withTimings: number;
  withEvidenceSignals: number;
  withEvidenceCoverage: number;
  withSelection: number;
}

function coverageOf(samples: TelemetrySample[]): FieldCoverage {
  const count = (pred: (t: ScanTelemetryV1) => boolean) => samples.filter((s) => pred(s.telemetry)).length;
  return {
    samples: samples.length,
    withGame: count((t) => t.game != null),
    withCandidateSources: count((t) => Array.isArray(t.candidateSources) && t.candidateSources.length > 0),
    withCandidateStatus: count((t) => t.candidateStatus != null),
    withTimings: count((t) => t.timings != null && Object.keys(t.timings).length > 0),
    withEvidenceSignals: count((t) => Array.isArray(t.evidenceSignals) && t.evidenceSignals.length > 0),
    withEvidenceCoverage: count((t) => t.evidenceCoverage != null),
    withSelection: count((t) => t.selection != null),
  };
}

// ─── Provider performance ────────────────────────────────────────────────────

export interface ProviderStats {
  source: CandidateSourceId;
  label: string;
  /** Scans that consulted this source at all. */
  calls: number;
  completed: number;
  failed: number;
  /** Share of calls that failed, or null when never called. */
  failureRate: number | null;
  /** Only the reasons actually seen — an unseen reason is absent, not zero. */
  failureReasons: Partial<Record<ProviderFailureReason, number>>;
  /**
   * Latency across ALL calls, successful or not.
   *
   * Reported separately from `latencyCompleted` because a timeout contributes
   * the ceiling rather than a real service time: blending them describes a
   * provider nobody actually experienced. `latencyCompleted` answers "how fast
   * is it when it works"; `latencyFailed` answers "what do failures cost us".
   */
  latency: Distribution;
  latencyCompleted: Distribution;
  latencyFailed: Distribution;
}

function providerStatsFrom(samples: TelemetrySample[]): ProviderStats[] {
  const bySource = new Map<CandidateSourceId, CandidateSourceStatus[]>();
  for (const s of samples) {
    for (const src of s.telemetry.candidateSources ?? []) {
      const list = bySource.get(src.source) ?? [];
      list.push(src);
      bySource.set(src.source, list);
    }
  }

  // Only report providers we have readings for. Inventing a zero row for an
  // unobserved provider would assert it was never called, which we do not know.
  return [...bySource.entries()]
    .map(([source, readings]) => {
      const completed = readings.filter((r) => r.availability === "completed");
      const failed = readings.filter((r) => r.availability === "failed");

      const failureReasons: Partial<Record<ProviderFailureReason, number>> = {};
      for (const f of failed) {
        if (!f.reason) continue;
        failureReasons[f.reason] = (failureReasons[f.reason] ?? 0) + 1;
      }

      return {
        source,
        label: readings[0]?.label ?? CANDIDATE_SOURCE_LABELS[source],
        calls: readings.length,
        completed: completed.length,
        failed: failed.length,
        failureRate: readings.length > 0 ? failed.length / readings.length : null,
        failureReasons,
        latency: summarize(readings.map((r) => r.durationMs)),
        latencyCompleted: summarize(completed.map((r) => r.durationMs)),
        latencyFailed: summarize(failed.map((r) => r.durationMs)),
      };
    })
    .sort((a, b) => b.calls - a.calls);
}

// ─── Outcomes ────────────────────────────────────────────────────────────────

/**
 * Counts by the CANDIDATE layer's verdict — `candidateStatus`, never
 * `decision.action`. Per the contract on ScanTelemetryV1.candidateStatus the
 * two legitimately disagree, and counting absences off decision.action sweeps
 * in every outage. `no_candidates` is the only value asserting real absence.
 */
export interface OutcomeBreakdown {
  /** Samples carrying a candidateStatus at all. The denominator for the rates. */
  classified: number;
  /** Samples carrying no candidateStatus. Not a zero — unknown. (Why a record
   *  lacks it is not knowable here; do not infer an age or a cause.) */
  unclassified: number;
  found: number;
  no_candidates: number;
  provider_unavailable: number;
}

function outcomesFrom(samples: TelemetrySample[]): OutcomeBreakdown {
  const b: OutcomeBreakdown = {
    classified: 0,
    unclassified: 0,
    found: 0,
    no_candidates: 0,
    provider_unavailable: 0,
  };
  for (const { telemetry } of samples) {
    const status = telemetry.candidateStatus;
    if (!status) {
      b.unclassified++;
      continue;
    }
    b.classified++;
    b[status]++;
  }
  return b;
}

/**
 * found / (found + no_candidates) — deliberately EXCLUDING
 * provider_unavailable from the denominator.
 *
 * This is the truth boundary as arithmetic. A scan we could not verify is not
 * evidence of a miss, so it cannot be allowed to drag the match rate down: that
 * would let a provider outage masquerade as a scanner accuracy regression and
 * send Phase 5.15 chasing a recognition bug that never existed. Null when
 * nothing was verifiable.
 */
export function matchRate(o: OutcomeBreakdown): number | null {
  const decided = o.found + o.no_candidates;
  return decided > 0 ? o.found / decided : null;
}

// ─── Candidate quality ───────────────────────────────────────────────────────

export interface CandidateQuality {
  /** Size of the pool the scorer chose among (printingsCount). */
  poolSize: Distribution;
  /** What actually reached the collector (presentedCount). */
  presented: Distribution;
  /** Pools of exactly 0 / 1 / >1, counted over samples with a known status. */
  zero: number;
  single: number;
  ambiguous: number;
}

function candidateQualityFrom(samples: TelemetrySample[]): CandidateQuality {
  const pools = samples.map((s) => s.telemetry.printingsCount).filter((n) => typeof n === "number");
  return {
    poolSize: summarize(pools),
    presented: summarize(samples.map((s) => s.telemetry.presentedCount).filter((n) => typeof n === "number")),
    zero: pools.filter((n) => n === 0).length,
    single: pools.filter((n) => n === 1).length,
    ambiguous: pools.filter((n) => n > 1).length,
  };
}

// ─── Latency ─────────────────────────────────────────────────────────────────

/**
 * Per-stage wall-clock, keyed by whatever the scanner actually recorded
 * (ocrMs, candidatesMs, scoreMs, …).
 *
 * The keys are NOT hardcoded: `timings` is a Record<string, number> the scan
 * route owns, so this discovers stage names instead of asserting them. A stage
 * renamed or added upstream shows up here with no change to this module — and,
 * critically, a stage that stops being recorded DISAPPEARS rather than
 * silently reporting 0ms.
 */
export interface LatencyBreakdown {
  stages: Record<string, Distribution>;
}

function latencyFrom(samples: TelemetrySample[]): LatencyBreakdown {
  const byStage = new Map<string, number[]>();
  for (const { telemetry } of samples) {
    for (const [stage, ms] of Object.entries(telemetry.timings ?? {})) {
      if (typeof ms !== "number") continue;
      const list = byStage.get(stage) ?? [];
      list.push(ms);
      byStage.set(stage, list);
    }
  }
  const stages: Record<string, Distribution> = {};
  for (const [stage, values] of [...byStage.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    stages[stage] = summarize(values);
  }
  return { stages };
}

// ─── Grouping ────────────────────────────────────────────────────────────────

export interface GameStats {
  /** The recorded game, or null for records that never carried one. */
  game: string | null;
  scans: number;
  outcomes: OutcomeBreakdown;
  matchRate: number | null;
  providers: ProviderStats[];
  latency: LatencyBreakdown;
  candidates: CandidateQuality;
}

export interface DailyStats {
  /** UTC calendar day, YYYY-MM-DD. */
  day: string;
  scans: number;
  outcomes: OutcomeBreakdown;
  matchRate: number | null;
  /** Latency of the whole scan, when recorded. */
  totalScan: Distribution;
}

const TOTAL_STAGE_KEYS = ["totalMs", "total", "scanMs"];

function totalScanValues(samples: TelemetrySample[]): number[] {
  const values: number[] = [];
  for (const { telemetry } of samples) {
    const timings = telemetry.timings ?? {};
    const key = TOTAL_STAGE_KEYS.find((k) => typeof timings[k] === "number");
    if (key) values.push(timings[key]);
  }
  return values;
}

function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ─── Warnings ────────────────────────────────────────────────────────────────
//
// OBSERVATIONS only ("X has no data", "n is too small to conclude"), never
// recommendations ("optimize X"). Phase 5.14 measures; deciding what to do
// belongs to a human reading the numbers.

/** Below this, per-game and per-provider splits are anecdote, not measurement. */
export const MIN_SAMPLES_FOR_CONFIDENCE = 30;

function warningsFrom(a: Omit<TelemetryAnalysis, "warnings">): string[] {
  const w: string[] = [];
  const { coverage, sampleCount } = a;

  if (sampleCount === 0) {
    w.push("No telemetry in this period. Every statistic below is absent, not zero.");
    return w;
  }

  // State the absence; never explain it. These warnings used to append "these
  // records predate Phase 5.13C" — a CAUSE the report cannot observe, only
  // guess. It guessed wrong: rows written half an hour AFTER the 5.13C deploy
  // carried no candidate fields because the dev server had been running since
  // before the code was written, so the instrumented path had never executed.
  // The warning confidently reported "old data, nothing to see" and nearly hid
  // a live runtime bug. An absent field has many causes — stale runtime, a
  // failed write, a filter, a genuinely old row — and picking one is the same
  // error as reporting 0ms for an unmeasured provider: asserting knowledge we
  // do not have. Say what is missing and stop; the human investigates why.
  if (coverage.withCandidateStatus === 0) {
    w.push(
      `No record carries candidateStatus (0/${sampleCount}). Outcome and match-rate analysis ` +
        `is UNAVAILABLE.`,
    );
  }
  if (coverage.withCandidateSources === 0) {
    w.push(
      `No record carries candidateSources (0/${sampleCount}). Provider latency and failure ` +
        `analysis is UNAVAILABLE.`,
    );
  }
  if (coverage.withTimings === 0) {
    w.push(`No record carries timings (0/${sampleCount}). Latency breakdown is UNAVAILABLE.`);
  }

  if (sampleCount > 0 && sampleCount < MIN_SAMPLES_FOR_CONFIDENCE) {
    w.push(
      `Only ${sampleCount} scans in this period (below ${MIN_SAMPLES_FOR_CONFIDENCE}). ` +
        `Treat every figure as anecdote; per-game and per-provider splits divide this further.`,
    );
  }

  for (const p of a.providers) {
    if (p.calls > 0 && p.calls < MIN_SAMPLES_FOR_CONFIDENCE) {
      w.push(`${p.label}: only ${p.calls} calls — too few to rank against other providers.`);
    }
    if (p.latency.count >= P95_MIN_SAMPLES && p.latencyCompleted.count === 0) {
      w.push(`${p.label}: every recorded call failed. Its latency describes failures, not service time.`);
    }
  }

  const unclassified = a.outcomes.unclassified;
  if (unclassified > 0 && a.outcomes.classified > 0) {
    w.push(
      `${unclassified} of ${sampleCount} records have no candidateStatus and are excluded from ` +
        `outcome rates (denominator is ${a.outcomes.classified}).`,
    );
  }

  return w;
}

// ─── Top level ───────────────────────────────────────────────────────────────

export interface TelemetryAnalysis {
  /** Bounds of the data actually present, not the requested filter. Null when empty. */
  period: { from: Date; to: Date } | null;
  sampleCount: number;
  coverage: FieldCoverage;
  outcomes: OutcomeBreakdown;
  matchRate: number | null;
  providers: ProviderStats[];
  candidates: CandidateQuality;
  latency: LatencyBreakdown;
  totalScan: Distribution;
  byGame: GameStats[];
  byDay: DailyStats[];
  /** Observations about the data's limits. Never recommendations. */
  warnings: string[];
}

export function analyzeTelemetry(
  samples: TelemetrySample[],
  filter: TelemetryFilter = {},
): TelemetryAnalysis {
  const scoped = filterSamples(samples, filter);
  const times = scoped.map((s) => s.at.getTime());

  const byGameMap = new Map<string | null, TelemetrySample[]>();
  for (const s of scoped) {
    const key = s.telemetry.game ?? null;
    byGameMap.set(key, [...(byGameMap.get(key) ?? []), s]);
  }

  const byDayMap = new Map<string, TelemetrySample[]>();
  for (const s of scoped) {
    const key = utcDay(s.at);
    byDayMap.set(key, [...(byDayMap.get(key) ?? []), s]);
  }

  const outcomes = outcomesFrom(scoped);

  const base: Omit<TelemetryAnalysis, "warnings"> = {
    period: times.length
      ? { from: new Date(Math.min(...times)), to: new Date(Math.max(...times)) }
      : null,
    sampleCount: scoped.length,
    coverage: coverageOf(scoped),
    outcomes,
    matchRate: matchRate(outcomes),
    providers: providerStatsFrom(scoped),
    candidates: candidateQualityFrom(scoped),
    latency: latencyFrom(scoped),
    totalScan: summarize(totalScanValues(scoped)),
    byGame: [...byGameMap.entries()]
      .map(([game, group]) => {
        const o = outcomesFrom(group);
        return {
          game,
          scans: group.length,
          outcomes: o,
          matchRate: matchRate(o),
          providers: providerStatsFrom(group),
          latency: latencyFrom(group),
          candidates: candidateQualityFrom(group),
        };
      })
      .sort((a, b) => b.scans - a.scans),
    byDay: [...byDayMap.entries()]
      .map(([day, group]) => {
        const o = outcomesFrom(group);
        return {
          day,
          scans: group.length,
          outcomes: o,
          matchRate: matchRate(o),
          totalScan: summarize(totalScanValues(group)),
        };
      })
      .sort((a, b) => a.day.localeCompare(b.day)),
  };

  return { ...base, warnings: warningsFrom(base) };
}
