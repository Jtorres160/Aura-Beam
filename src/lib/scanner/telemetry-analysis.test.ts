// Production Telemetry Analysis tests (Phase 5.14).
//
// These lock the MEASUREMENT contract of the analysis layer. The bulk of them
// defend one rule, because it is the rule the whole phase rests on:
//
//   AN ABSENT MEASUREMENT MUST NEVER RENDER AS ZERO.
//
// Phase 5.14 opens with zero stored records carrying candidateSources or
// candidateStatus. If summarize()/formatTelemetryReport() collapse "unmeasured"
// into 0, the first report reads as "every provider is instant and never fails"
// — reproducing, inside the tooling built to detect it, exactly the failure
// Phase 5.13C deleted from the product. So `null` is load-bearing here and these
// tests treat any leaked 0 as a defect.
//
// Run: node --import ./test/register.mjs --test src/lib/scanner/telemetry-analysis.test.ts

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import {
  analyzeTelemetry,
  filterSamples,
  matchRate,
  summarize,
  MIN_SAMPLES_FOR_CONFIDENCE,
  P95_MIN_SAMPLES,
  type TelemetrySample,
} from "@/lib/scanner/telemetry-analysis";
import { formatTelemetryReport } from "@/lib/scanner/telemetry-report";
import type { ScanTelemetryV1 } from "@/lib/scanner/telemetry";
import type { CandidateSourceStatus } from "@/lib/scanner/candidates";

// ─── Fixtures ────────────────────────────────────────────────────────────────
// Hand-built rather than driven through a scan: this module's input is a STORED
// record, and stored records include shapes the current scanner can no longer
// produce (pre-5.13C rows with no candidateStatus). Those legacy shapes are
// precisely what must not be misread, so the fixtures must be able to express
// them.

function source(over: Partial<CandidateSourceStatus> = {}): CandidateSourceStatus {
  return {
    source: "scryfall",
    label: "Scryfall (MTG)",
    availability: "completed",
    durationMs: 100,
    ...over,
  };
}

function sample(over: Partial<ScanTelemetryV1> = {}, at = new Date("2026-07-16T12:00:00Z")): TelemetrySample {
  return {
    at,
    telemetry: {
      v: 1,
      evidence: {} as ScanTelemetryV1["evidence"],
      decision: { action: "accept", confidence: 0.9, margin: 0.3, evidenceMass: 2 },
      printingsCount: 1,
      presentedCount: 1,
      ...over,
    },
  };
}

// ─── summarize ───────────────────────────────────────────────────────────────

describe("summarize — absent is not zero", () => {
  test("an empty set reports count 0 and NULL statistics, never 0ms", () => {
    const d = summarize([]);
    assert.equal(d.count, 0);
    // The whole phase rests on these being null rather than 0.
    assert.equal(d.mean, null);
    assert.equal(d.median, null);
    assert.equal(d.p95, null);
    assert.equal(d.min, null);
    assert.equal(d.max, null);
  });

  test("mean and median are computed correctly", () => {
    const d = summarize([10, 20, 30]);
    assert.equal(d.mean, 20);
    assert.equal(d.median, 20);
    assert.equal(d.min, 10);
    assert.equal(d.max, 30);
  });

  test("median of an even count averages the two middle values", () => {
    assert.equal(summarize([10, 20, 30, 40]).median, 25);
  });

  test("p95 is withheld below the sample floor — it would just be max() in disguise", () => {
    const few = summarize([1, 2, 3]);
    assert.equal(few.count, 3);
    assert.equal(few.p95, null, "n=3 p95 is max(); reporting it invites false confidence");
    assert.equal(few.max, 3, "max is still honestly reported");
  });

  test("p95 appears once there are enough samples", () => {
    const values = Array.from({ length: P95_MIN_SAMPLES }, (_, i) => i + 1);
    const d = summarize(values);
    assert.equal(d.count, P95_MIN_SAMPLES);
    // Nearest-rank over 1..20: index ceil(0.95*20)-1 = 18 → 19. Not max().
    assert.equal(d.p95, 19);
    assert.equal(d.max, 20, "p95 and max are distinct once n is large enough to tell them apart");
  });

  test("non-finite values are discarded, not counted as zero", () => {
    const d = summarize([10, NaN, 20, Infinity]);
    assert.equal(d.count, 2);
    assert.equal(d.mean, 15);
  });
});

// ─── Provider stats ──────────────────────────────────────────────────────────

describe("provider performance", () => {
  test("a provider with no records is ABSENT from the report, not a zero row", () => {
    const a = analyzeTelemetry([sample({ candidateSources: [source({ source: "scryfall" })] })]);
    assert.deepEqual(
      a.providers.map((p) => p.source),
      ["scryfall"],
      "pokemon/ygoprodeck were never consulted; inventing 0-call rows would assert that",
    );
  });

  test("completed and failed latency are reported separately", () => {
    const a = analyzeTelemetry([
      sample({ candidateSources: [source({ availability: "completed", durationMs: 50 })] }),
      sample({ candidateSources: [source({ availability: "failed", reason: "timeout", durationMs: 8000 })] }),
    ]);
    const p = a.providers[0];
    assert.equal(p.calls, 2);
    assert.equal(p.completed, 1);
    assert.equal(p.failed, 1);
    assert.equal(p.failureRate, 0.5);
    // A timeout contributes the ceiling, not a service time. Blending them
    // describes a provider nobody experienced.
    assert.equal(p.latencyCompleted.mean, 50);
    assert.equal(p.latencyFailed.mean, 8000);
    assert.equal(p.latency.mean, 4025);
  });

  test("failure reasons are counted; unseen reasons are absent rather than zero", () => {
    const a = analyzeTelemetry([
      sample({ candidateSources: [source({ availability: "failed", reason: "timeout", durationMs: 8000 })] }),
      sample({ candidateSources: [source({ availability: "failed", reason: "timeout", durationMs: 8000 })] }),
      sample({ candidateSources: [source({ availability: "failed", reason: "rate_limited", durationMs: 30 })] }),
    ]);
    const p = a.providers[0];
    assert.equal(p.failureReasons.timeout, 2);
    assert.equal(p.failureReasons.rate_limited, 1);
    assert.equal(p.failureReasons.network, undefined, "a reason never seen is absent, not 0");
  });

  test("a provider that was never called has a NULL failure rate, not 0%", () => {
    const a = analyzeTelemetry([sample({})]);
    assert.equal(a.providers.length, 0);
    // Rendering must not claim a 0% failure rate for something never measured.
    assert.match(formatTelemetryReport(a), /no data/);
  });
});

// ─── Outcomes and the truth boundary ─────────────────────────────────────────

describe("outcomes — the truth boundary as arithmetic", () => {
  test("provider_unavailable is EXCLUDED from the match-rate denominator", () => {
    const a = analyzeTelemetry([
      sample({ candidateStatus: "found" }),
      sample({ candidateStatus: "no_candidates" }),
      sample({ candidateStatus: "provider_unavailable" }),
      sample({ candidateStatus: "provider_unavailable" }),
    ]);
    // found=1, no_candidates=1 → 1/2. The two outages are NOT misses: counting
    // them would let an outage masquerade as a recognition regression.
    assert.equal(a.matchRate, 0.5);
    assert.equal(a.outcomes.provider_unavailable, 2);
  });

  test("an all-unavailable period has a NULL match rate — nothing was verifiable", () => {
    const a = analyzeTelemetry([
      sample({ candidateStatus: "provider_unavailable" }),
      sample({ candidateStatus: "provider_unavailable" }),
    ]);
    assert.equal(a.matchRate, null, "0% would assert the scanner missed; it never got to try");
  });

  test("records with no candidateStatus are unclassified, not counted as misses", () => {
    const a = analyzeTelemetry([
      sample({ candidateStatus: "found" }),
      sample({}), // pre-5.13C row
      sample({}),
    ]);
    assert.equal(a.outcomes.classified, 1);
    assert.equal(a.outcomes.unclassified, 2);
    assert.equal(a.matchRate, 1, "the two legacy rows must not drag the rate to 33%");
  });

  test("matchRate is null when nothing is classified at all", () => {
    assert.equal(matchRate({ classified: 0, unclassified: 5, found: 0, no_candidates: 0, provider_unavailable: 0 }), null);
  });
});

// ─── Filtering ───────────────────────────────────────────────────────────────

describe("filters", () => {
  const samples = [
    sample({ game: "MTG", candidateStatus: "found", candidateSources: [source({ source: "scryfall" })] }, new Date("2026-07-16T00:00:00Z")),
    sample({ game: "POKEMON", candidateStatus: "no_candidates", candidateSources: [source({ source: "pokemon", label: "Pokémon TCG API" })] }, new Date("2026-07-17T00:00:00Z")),
    sample({ game: "YUGIOH", candidateStatus: "provider_unavailable" }, new Date("2026-07-18T00:00:00Z")),
  ];

  test("date range is inclusive of from and exclusive of to", () => {
    const got = filterSamples(samples, { from: new Date("2026-07-17T00:00:00Z"), to: new Date("2026-07-18T00:00:00Z") });
    assert.equal(got.length, 1);
    assert.equal(got[0].telemetry.game, "POKEMON");
  });

  test("game, status and source filters each narrow the set", () => {
    assert.equal(filterSamples(samples, { game: "MTG" }).length, 1);
    assert.equal(filterSamples(samples, { status: "provider_unavailable" }).length, 1);
    assert.equal(filterSamples(samples, { source: "pokemon" }).length, 1);
    assert.equal(filterSamples(samples, { source: "ygoprodeck" }).length, 0);
  });

  test("filters compose, and an empty filter constrains nothing", () => {
    assert.equal(filterSamples(samples, {}).length, 3);
    assert.equal(filterSamples(samples, { game: "MTG", status: "no_candidates" }).length, 0);
  });
});

// ─── Grouping ────────────────────────────────────────────────────────────────

describe("grouping", () => {
  test("game is a grouping key only — an unrecorded game groups under null", () => {
    const a = analyzeTelemetry([sample({ game: "MTG" }), sample({})]);
    const games = a.byGame.map((g) => g.game);
    assert.equal(games.length, 2);
    assert.ok(games.includes("MTG"));
    assert.ok(games.includes(null), "a record with no game must group under null, not be dropped");
  });

  test("days bucket by UTC calendar day and are ordered", () => {
    const a = analyzeTelemetry([
      sample({}, new Date("2026-07-17T23:59:00Z")),
      sample({}, new Date("2026-07-16T00:01:00Z")),
      sample({}, new Date("2026-07-16T12:00:00Z")),
    ]);
    assert.deepEqual(a.byDay.map((d) => d.day), ["2026-07-16", "2026-07-17"]);
    assert.equal(a.byDay[0].scans, 2);
  });

  test("period reflects the data present, not the filter requested", () => {
    const a = analyzeTelemetry(
      [sample({}, new Date("2026-07-16T12:00:00Z"))],
      { from: new Date("2020-01-01T00:00:00Z"), to: new Date("2030-01-01T00:00:00Z") },
    );
    assert.equal(a.period?.from.toISOString(), "2026-07-16T12:00:00.000Z");
  });
});

// ─── Latency ─────────────────────────────────────────────────────────────────

describe("latency", () => {
  test("stage names are discovered from the data, not hardcoded", () => {
    const a = analyzeTelemetry([
      sample({ timings: { ocrMs: 100, candidatesMs: 500 } }),
      sample({ timings: { ocrMs: 200, brandNewStageMs: 5 } }),
    ]);
    assert.deepEqual(Object.keys(a.latency.stages).sort(), ["brandNewStageMs", "candidatesMs", "ocrMs"]);
    assert.equal(a.latency.stages.ocrMs.mean, 150);
    // Only ONE sample recorded candidatesMs — it must not average in a phantom 0.
    assert.equal(a.latency.stages.candidatesMs.count, 1);
    assert.equal(a.latency.stages.candidatesMs.mean, 500);
  });

  test("a stage nobody recorded is absent from the breakdown", () => {
    const a = analyzeTelemetry([sample({ timings: { ocrMs: 100 } })]);
    assert.equal(a.latency.stages.scoreMs, undefined);
  });
});

// ─── The empty-dataset contract ──────────────────────────────────────────────

describe("the empty dataset — Phase 5.14's actual starting state", () => {
  test("zero samples produce a report that claims nothing", () => {
    const a = analyzeTelemetry([]);
    assert.equal(a.sampleCount, 0);
    assert.equal(a.period, null);
    assert.equal(a.matchRate, null);
    assert.deepEqual(a.providers, []);
    assert.equal(a.totalScan.mean, null);
    assert.ok(a.warnings.some((w) => /absent, not zero/.test(w)));
  });

  test("records without candidate fields warn that provider analysis is UNAVAILABLE, not healthy", () => {
    // Rows with timings but no candidate fields.
    const legacy = Array.from({ length: 164 }, () => sample({ timings: { ocrMs: 100 } }));
    const a = analyzeTelemetry(legacy);

    assert.equal(a.coverage.samples, 164);
    assert.equal(a.coverage.withCandidateSources, 0);
    assert.equal(a.coverage.withCandidateStatus, 0);
    assert.ok(a.warnings.some((w) => /candidateSources/.test(w) && /UNAVAILABLE/.test(w)));
    assert.ok(a.warnings.some((w) => /candidateStatus/.test(w) && /UNAVAILABLE/.test(w)));

    const report = formatTelemetryReport(a);
    // The exact misreading this phase must not enable.
    assert.doesNotMatch(report, /failure rate\s+0\.0%/, "must never claim a 0% failure rate from an empty set");
    assert.match(report, /Provider performance/);
  });

  test("an absent field is reported without explaining WHY it is absent", () => {
    // The regression this pins actually happened. These warnings used to read
    // "…is UNAVAILABLE — these records predate Phase 5.13C", and that guess was
    // wrong: the rows were NEWER than the deploy, written by a dev server that
    // had been running since before the instrumented code existed. The report
    // asserted a cause it cannot observe, and the false reassurance nearly hid
    // a live runtime bug. Same class of error as printing 0ms for a provider we
    // never measured — inventing knowledge — so it is pinned the same way.
    const a = analyzeTelemetry(Array.from({ length: 6 }, () => sample({ timings: { ocrMs: 100 } })));
    const text = [...a.warnings, formatTelemetryReport(a)].join("\n");

    for (const claim of [/predate/i, /pre-5\.13C/i, /these records are old/i, /stale/i]) {
      assert.doesNotMatch(text, claim, "a warning must state the absence, never diagnose its cause");
    }
    // …while still naming exactly what is missing, and how much of it.
    assert.ok(a.warnings.some((w) => /No record carries candidateSources \(0\/6\)/.test(w)));
  });

  test("small samples are flagged as anecdote", () => {
    const a = analyzeTelemetry([sample({ candidateStatus: "found" })]);
    assert.ok(
      a.warnings.some((w) => w.includes(String(MIN_SAMPLES_FOR_CONFIDENCE))),
      "a 1-scan dataset must not be presented as a measurement",
    );
  });
});

// ─── Report rendering ────────────────────────────────────────────────────────

describe("formatTelemetryReport", () => {
  test("renders nulls as 'no data' and never as 0ms", () => {
    const report = formatTelemetryReport(analyzeTelemetry([]));
    assert.match(report, /no data/);
    assert.doesNotMatch(report, /0ms/, "an unmeasured latency must never print as 0ms");
  });

  test("warnings are printed before the numbers they qualify", () => {
    const report = formatTelemetryReport(analyzeTelemetry([sample({ timings: { ocrMs: 1 } })]));
    assert.ok(
      report.indexOf("Read this first") < report.indexOf("Provider performance"),
      "a caveat printed after the table is a caveat nobody reads",
    );
  });

  test("uses production status names", () => {
    const a = analyzeTelemetry([sample({ candidateStatus: "no_candidates" }), sample({ candidateStatus: "found" })]);
    const report = formatTelemetryReport(a);
    assert.match(report, /no_matches/, "the collector-facing name is no_matches");
    assert.match(report, /provider_unavailable/);
    assert.doesNotMatch(report, /no_candidates(?!")/, "no_candidates is the internal name; the report speaks production");
  });

  test("candidate counts render as counts, never as milliseconds", () => {
    // Regression: distLine defaulted every Distribution to ms, so a pool of 7
    // printings printed as "avg 7ms" — a false statement about what was
    // measured, and the same species of error as printing absent as zero.
    const a = analyzeTelemetry([
      sample({ printingsCount: 7, presentedCount: 7 }),
      sample({ printingsCount: 3, presentedCount: 3 }),
    ]);
    const report = formatTelemetryReport(a);
    const poolLine = report.split("\n").find((l) => l.includes("pool size"));
    assert.ok(poolLine, "report must have a pool size line");
    assert.doesNotMatch(poolLine, /ms/, `pool size is a card count, got: ${poolLine}`);
    assert.match(poolLine, /avg 5\b/, "avg of 7 and 3 printings is 5 cards");
  });

  test("a populated report renders real statistics", () => {
    const samples = Array.from({ length: 40 }, (_, i) =>
      sample({
        game: "MTG",
        candidateStatus: "found",
        timings: { ocrMs: 100 + i, totalMs: 1000 + i },
        candidateSources: [source({ durationMs: 50 + i })],
      }),
    );
    const report = formatTelemetryReport(analyzeTelemetry(samples));
    assert.match(report, /Scans:\s+40/);
    assert.match(report, /Scryfall/);
    assert.match(report, /p95/);
    assert.doesNotMatch(report, /⚠ Only 40 scans/);
  });
});
