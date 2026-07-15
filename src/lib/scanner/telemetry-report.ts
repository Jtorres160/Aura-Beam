// Production telemetry report (Phase 5.14).
//
// PURPOSE: render a TelemetryAnalysis as a developer-readable report. This
// module is OBSERVATION TOOLING only — it formats numbers, it does not compute
// them (analyzeTelemetry does) and it cannot change scanner behavior.
//
// It is game-agnostic: whatever games appear in the data get a section.
//
// ─── FORMATTING IS PART OF THE TRUTH BOUNDARY ───────────────────────────────
//
// The rule from telemetry-analysis.ts — an unmeasured thing must never render
// as 0 — lives or dies HERE, because this is where a number becomes a sentence
// a human believes. `null` prints as "no data", never "0ms" and never "0%".
//
// The failure this prevents is concrete. Phase 5.14 opens with zero records
// carrying candidateSources. A formatter that printed `${p.latency.mean ?? 0}ms`
// would render that as a clean table of 0ms latencies and 0% failure rates —
// and someone would reasonably read it as "providers are fast and healthy" and
// close Phase 5.15 as unnecessary. The dataset was empty. Printing "no data" is
// the whole job.

import {
  MIN_SAMPLES_FOR_CONFIDENCE,
  P95_MIN_SAMPLES,
  type Distribution,
  type GameStats,
  type ProviderStats,
  type TelemetryAnalysis,
} from "@/lib/scanner/telemetry-analysis";

// ─── Primitives ──────────────────────────────────────────────────────────────

/** The single chokepoint for "we did not measure this". */
const NO_DATA = "no data";

function pct(v: number | null): string {
  return v === null ? NO_DATA : `${(v * 100).toFixed(1)}%`;
}

/** A share of a known denominator. Null denominator ⇒ no data, never 0%. */
function share(n: number, of: number): string {
  return of > 0 ? `${((n / of) * 100).toFixed(1)}%` : NO_DATA;
}

/**
 * How to render a Distribution's values.
 *
 * Distribution is unit-agnostic — it summarizes latencies AND candidate counts.
 * The unit must therefore be supplied at the call site, because a count printed
 * as "avg 7ms" is not a typo, it is a false statement about what was measured,
 * and it is the same species of error as printing an absent value as zero.
 */
type Unit = "ms" | "count";

function value(v: number | null, unit: Unit): string {
  if (v === null) return NO_DATA;
  return unit === "ms" ? `${Math.round(v)}ms` : `${Math.round(v * 10) / 10}`;
}

function distLine(d: Distribution, unit: Unit = "ms"): string {
  if (d.count === 0) return NO_DATA;
  const p95 = d.p95 === null ? `p95 ${NO_DATA} (n<${P95_MIN_SAMPLES})` : `p95 ${value(d.p95, unit)}`;
  return (
    `n=${d.count}  avg ${value(d.mean, unit)}  median ${value(d.median, unit)}  ` +
    `${p95}  min ${value(d.min, unit)}  max ${value(d.max, unit)}`
  );
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function section(title: string): string {
  return `\n${title}\n${"─".repeat(title.length)}`;
}

// ─── Providers ───────────────────────────────────────────────────────────────

function formatProviders(providers: ProviderStats[], indent = ""): string {
  if (providers.length === 0) {
    return `${indent}${NO_DATA} — no record in this period carries candidateSources.`;
  }

  const lines: string[] = [];
  for (const p of providers) {
    lines.push(`${indent}${p.label}`);
    lines.push(`${indent}  calls        ${p.calls}   completed ${p.completed}   failed ${p.failed}`);
    lines.push(`${indent}  failure rate ${pct(p.failureRate)}`);

    const reasons = Object.entries(p.failureReasons);
    if (reasons.length > 0) {
      const rendered = reasons
        .sort(([, a], [, b]) => b - a)
        .map(([reason, n]) => `${reason}=${n}`)
        .join("  ");
      lines.push(`${indent}  reasons      ${rendered}`);
    }

    lines.push(`${indent}  latency, all      ${distLine(p.latency)}`);
    // Split out because a timeout contributes the ceiling, not a service time.
    lines.push(`${indent}  latency, worked   ${distLine(p.latencyCompleted)}`);
    if (p.latencyFailed.count > 0) {
      lines.push(`${indent}  latency, failed   ${distLine(p.latencyFailed)}`);
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

// ─── Games ───────────────────────────────────────────────────────────────────

function formatGame(g: GameStats): string {
  const lines: string[] = [];
  lines.push(`${g.game ?? "(game not recorded)"} — ${g.scans} scans`);

  if (g.scans < MIN_SAMPLES_FOR_CONFIDENCE) {
    lines.push(`  ⚠ n=${g.scans}, below ${MIN_SAMPLES_FOR_CONFIDENCE} — anecdote, not measurement.`);
  }

  const o = g.outcomes;
  lines.push(`  outcomes     found ${o.found}  no_matches ${o.no_candidates}  provider_unavailable ${o.provider_unavailable}`);
  lines.push(`  match rate   ${pct(g.matchRate)}   (found / verifiable; unavailable excluded)`);
  lines.push(`  pool size    ${distLine(g.candidates.poolSize, "count")}`);

  const stages = Object.entries(g.latency.stages);
  if (stages.length > 0) {
    lines.push("  latency");
    for (const [stage, d] of stages) {
      lines.push(`    ${pad(stage, 16)} ${distLine(d)}`);
    }
  }

  lines.push("  providers");
  lines.push(formatProviders(g.providers, "    "));
  return lines.join("\n");
}

// ─── Report ──────────────────────────────────────────────────────────────────

export function formatTelemetryReport(a: TelemetryAnalysis): string {
  const out: string[] = [];

  out.push("Aura Telemetry Report");
  out.push("═════════════════════");

  const period = a.period
    ? `${a.period.from.toISOString()} → ${a.period.to.toISOString()}`
    : "(empty)";
  out.push(`Period: ${period}`);
  out.push(`Scans:  ${a.sampleCount}`);

  // Warnings come FIRST. They govern how every number below should be read, and
  // a caveat printed after the table is a caveat nobody reads.
  if (a.warnings.length > 0) {
    out.push(section("Read this first"));
    for (const w of a.warnings) out.push(`  ⚠ ${w}`);
  }

  // Coverage is the denominator for everything else.
  out.push(section("Telemetry coverage"));
  const c = a.coverage;
  const cov = (label: string, n: number) =>
    `  ${pad(label, 20)} ${pad(String(n), 6)} of ${c.samples}   ${share(n, c.samples)}`;
  out.push(cov("game", c.withGame));
  out.push(cov("candidateStatus", c.withCandidateStatus));
  out.push(cov("candidateSources", c.withCandidateSources));
  out.push(cov("timings", c.withTimings));
  out.push(cov("evidenceSignals", c.withEvidenceSignals));
  out.push(cov("evidenceCoverage", c.withEvidenceCoverage));
  out.push(cov("selection (label)", c.withSelection));

  // "Scan outcomes", not "Search outcomes": this section reads candidateStatus,
  // which is the SCAN path's verdict (vision → candidates → decision gate).
  // Search has its own provider layer and no telemetry at all yet; once it does,
  // the old heading would have put two unrelated datasets under one name.
  out.push(section("Scan outcomes"));
  const o = a.outcomes;
  if (o.classified === 0) {
    out.push(`  ${NO_DATA} — no record carries candidateStatus.`);
  } else {
    out.push(`  classified            ${o.classified} of ${a.sampleCount}`);
    out.push(`  results (found)       ${pad(String(o.found), 6)} ${share(o.found, o.classified)}`);
    out.push(`  no_matches            ${pad(String(o.no_candidates), 6)} ${share(o.no_candidates, o.classified)}`);
    out.push(`  provider_unavailable  ${pad(String(o.provider_unavailable), 6)} ${share(o.provider_unavailable, o.classified)}`);
    out.push("");
    out.push(`  match rate            ${pct(a.matchRate)}  (found / verifiable)`);
    out.push(`    provider_unavailable is excluded from this denominator: an unverifiable`);
    out.push(`    scan is not evidence of a miss.`);
  }
  if (o.unclassified > 0) {
    out.push(`  unclassified          ${o.unclassified}  (no candidateStatus — excluded)`);
  }

  out.push(section("Provider performance"));
  out.push(formatProviders(a.providers, "  "));

  out.push(section("Candidate quality"));
  const q = a.candidates;
  out.push(`  pool size      ${distLine(q.poolSize, "count")}`);
  out.push(`  presented      ${distLine(q.presented, "count")}`);
  if (q.poolSize.count === 0) {
    out.push(`  distribution   ${NO_DATA}`);
  } else {
    const n = q.poolSize.count;
    out.push(`  zero pool      ${pad(String(q.zero), 6)} ${share(q.zero, n)}`);
    out.push(`  single         ${pad(String(q.single), 6)} ${share(q.single, n)}`);
    out.push(`  ambiguous (>1) ${pad(String(q.ambiguous), 6)} ${share(q.ambiguous, n)}`);
  }

  out.push(section("Latency breakdown"));
  const stages = Object.entries(a.latency.stages);
  if (stages.length === 0) {
    out.push(`  ${NO_DATA} — no record carries timings.`);
  } else {
    for (const [stage, d] of stages) {
      out.push(`  ${pad(stage, 18)} ${distLine(d)}`);
    }
    out.push("");
    out.push(`  total scan         ${distLine(a.totalScan)}`);
  }

  out.push(section("By game"));
  if (a.byGame.length === 0) {
    out.push(`  ${NO_DATA}`);
  } else {
    for (const g of a.byGame) {
      out.push(formatGame(g));
      out.push("");
    }
  }

  out.push(section("By day (UTC)"));
  if (a.byDay.length === 0) {
    out.push(`  ${NO_DATA}`);
  } else {
    out.push(`  ${pad("day", 12)} ${pad("scans", 7)} ${pad("match", 8)} total scan`);
    for (const d of a.byDay) {
      out.push(`  ${pad(d.day, 12)} ${pad(String(d.scans), 7)} ${pad(pct(d.matchRate), 8)} ${distLine(d.totalScan)}`);
    }
  }

  return out.join("\n") + "\n";
}
