# Aura Scanner Telemetry — State Dictionary & Ambiguity Report

> Phase 5.15 — the **Telemetry Interpretation Layer**.
>
> Perspective: **Aura Core Engineer**. This is an *interpretation* document. No
> scanner behavior, scoring, evidence weight, ranking, or decision threshold was
> changed to produce it. It exists so a future contributor can understand what
> every telemetry state means **without reading scanner code**.
>
> Governing rule, inherited unchanged from Phase 5.13C / 5.14:
> **an absent measurement must never be read as a zero.** This document extends
> that rule from numbers to *meaning*: an absent *stage* must never be read as a
> failed one, and a stage that ran-but-wasn't-recorded must never be read as a
> stage that never ran.

---

## 1. Where telemetry lives

Every scan attempt writes one JSON record into `ScanHistory.ocrText` (a column
whose original raw-OCR purpose predates telemetry — see §5). All records are
tagged `v: 1`. There are **three structurally different shapes**, and they were
never given an explicit discriminant tag:

| Shape | Written by | Emitted when | Signature field |
|---|---|---|---|
| `ScanTelemetryV1` | `buildScanTelemetry` | the scorer ran (accept / disambiguate / not-found / provider-unavailable) | `decision` object |
| `ScanFailureTelemetryV1` | `buildFailureTelemetry` | the attempt died **before** the scorer (parse, ocr, no-card) | `failureStage` |
| catch-all error row | `scan/route.ts` catch block | an unattributed throw | `error.stage`, no `decision` |

`recordKind()` in [telemetry-interpretation.ts](../../src/lib/scanner/telemetry-interpretation.ts)
decides which shape a parsed record is, structurally.

> **The reader trap this creates:** `telemetry-analysis.ts` understands only the
> first shape. Fed the other two — which the dev report script historically did —
> it counts them as samples with no `candidateStatus` and drops them into
> `outcomes.unclassified`, the *same* bucket as a genuine pre-5.13C scored row.
> Those two are opposite facts (see §3, `candidateStatus`). Phase 5.15 splits
> them: the analysis layer now reads **scored records only**, and the new
> interpretation layer accounts for **every** shape.

---

## 2. Field audit (Task 1)

For each telemetry field: what it measures, whether it is always present, and how
it can be misread.

### `ScanTelemetryV1` (scored records)

| Field | Measures | Always present? | Misreading to avoid |
|---|---|---|---|
| `evidence` | Everything the sensors read, with confidence + provenance | Yes on scored records | — |
| `decision.action` | The **scorer's** verdict (accept/disambiguate/not-found) | Yes | **Not** the route's final verdict. `action: "not-found"` means only "the scorer was handed zero printings" — it does **not** distinguish a true absence from an outage. Use `candidateStatus`. |
| `decision.confidence` / `margin` / `evidenceMass` | The score that produced the verdict | Yes | A confidence of `0` on a not-found/unavailable row is a default, not a measured 0% certainty. |
| `evidenceSignals` | Per-signal identity breakdown, verbatim from the scorer | **No** — absent when no printing was assessed (disambiguate/not-found) | Absence ≠ "no signals fired"; it means "no printing to assess". |
| `evidenceCoverage` | How many expected sensors fired vs. failed vs. unavailable | **No** — only when signals were assessed | See §4: `unavailable` (source can't provide it) ≠ `failed` (sensor should have, didn't). |
| `candidateStatus` | The **candidate layer's** truth claim | **No** — absent on pre-5.13C rows | The single most misread field. See §3. |
| `candidateSources[]` | Per-source availability, reason, latency | **No** — absent on pre-5.13C rows | Empty/absent ≠ "no providers failed"; it means "not measured". `availability: "completed"` is what makes a zero from that source a *real* zero. |
| `printingsCount` | Size of the pool the scorer chose among (`printings.length`) | Yes on scored records | **`0` is ambiguous** — see §3. A `found` row can have `printingsCount: 0` when the match came from a fallback card. |
| `presentedCount` | What reached the collector (grid size, or 1 for an accept) | Yes on scored records | `0` means "nothing shown" (not-found/unavailable), which is a *decision outcome*, not an error and not an absence of measurement. |
| `timings{}` | Per-stage wall-clock, keyed by whatever the route recorded | **No** | A **missing key** = stage not recorded (drops out of the breakdown). A value of `0` = stage ran in <1ms. Never conflate. |
| `selection` | Ground-truth pick from the disambiguation grid | **No** — only after the user picked | Absence means "no pick yet", not "wrong". |
| `selectionAttempts[]` | Save attempts a source wouldn't confirm | **No** | Appended, never overwritten; several entries = a flapping provider, not several scans. |
| `game` / `isAutoScan` / `ocr` | Grouping/context | `game` often absent (an "All" scan) | Absent `game` groups under `null`; it is not a game named "null". |

### `ScanFailureTelemetryV1` (failure records)

| Field | Measures | Always present? | Misreading to avoid |
|---|---|---|---|
| `failureStage` | Which stage the attempt died at | Yes | This is a real, measured fact about a real attempt — not "no data". |
| `extractionStatus` | `"no_card"` (reader saw no card) vs `"failed"` (reader broke) | Only when extraction ended the attempt | Collapsing these **blames the collector's photo for our outage**. |
| `error` | Present only for genuine errors; absent for verdicts like `no_card` | Conditional | Its absence on a `no_card` row is correct — a verdict is not an error. |
| `timings{}` | Timings for stages that DID run | Partial | Fewer keys than a scored row, by design. |

There is **no** `decision`, `candidateStatus`, `printingsCount`, or `evidence` on
these records — and that absence is deliberate. Inventing a `printingsCount: 0`
for a scorer that never ran would be a fabricated zero standing in for an absent
measurement, the exact error the truth boundary forbids.

---

## 3. The ambiguous zeros & absences (Task 2)

The fields where `0` / `null` / `undefined` / `[]` carry more than one meaning:

### `candidateStatus` (and its absence)

| Value | Means |
|---|---|
| `"found"` | A printing (or accepted fallback) was identified. |
| `"no_candidates"` | Every source answered and **none** had the card. The **only** value that asserts a genuine absence. |
| `"provider_unavailable"` | A source went quiet; the empty pool is **uninterpretable**. |
| *absent* | A pre-5.13C scored row. The candidate stage **ran** — the verdict just wasn't stored. **Not** a miss, **not** a skipped stage. |

> Never count "true no matches" off `decision.action`. `decision.action: "not-found"`
> sweeps in every outage; `candidateStatus === "no_candidates"` does not.

### `printingsCount === 0`

Three different situations produce a zero pool, distinguishable only by cross-
referencing `candidateStatus`:

| `printingsCount` | `candidateStatus` | Actually means |
|---|---|---|
| `0` | `found` | A card **was** identified — via a fallback card, not the printings list. |
| `0` | `no_candidates` | A genuine absence: the card is in no database. |
| `0` | `provider_unavailable` | We never finished counting — a source failed. |
| `0` | *absent* | Unknown; the row predates the candidate truth layer. |

The analysis layer's "zero pool" tally (`CandidateQuality.zero`) counts all of
these together; read it **alongside** the outcome breakdown, never alone.

### `timings` — missing key vs `0`

A stage absent from `timings` was **not recorded** and disappears from the
latency breakdown (correct — it must not average in a phantom `0`). A stage
present with value `0` **ran in under a millisecond**. `latencyFrom()` preserves
this by discovering keys instead of asserting them.

### `candidateSources` — `[]` vs absent

Both render as "no provider data". Neither means "no provider failed". Provider
statistics describe **only** the subset of records that carry the field — which
is why `FieldCoverage.withCandidateSources` is the report's first honesty check.

---

## 4. Two orthogonal axes that look like one

`evidenceCoverage` and `candidateSources` each separate a "did it work" axis from
a "was it even possible" axis. They are not the same question and must not be
merged:

- **Evidence signal** (`SignalAvailability`): `supported` (source provides it and
  a reading was produced) / `unavailable` (source cannot provide it for this game
  — e.g. Pokémon artwork identity) / `failed` (source provides it, but no reading
  this scan). Only `failed` is a coverage gap worth flagging; `unavailable` is
  structural and blameless.
- **Candidate source** (`availability`): `completed` (it answered — a zero from
  it is a real zero) / `failed` (it did not answer — a zero from it means
  nothing).

---

## 5. Records that are NOT collector scans

The dev report script ([scripts/telemetry-report.mjs](../../scripts/telemetry-report.mjs))
separates and counts these rather than folding them into denominators:

- **Legacy raw OCR text** — pre-telemetry rows holding the column's original
  content. Not corrupt telemetry; a different thing that predates it.
- **Unrecognized shape** — `v !== 1` or non-object JSON.
- **Development rows** — `DEV_AUTH_BYPASS` writes real rows under a fixed dev
  userId. Genuine records of *something*, but not a collector scanning a card,
  so they are excluded from the analyzed set and reported separately.

---

## 6. Attempt categories (Task 5)

The interpretation layer names every attempt with one descriptive
`AttemptCategory`, spanning all three record shapes. **These are observational
only. None ranks an attempt good or bad, and none may ever be read back into
production logic.**

| Category | Meaning |
|---|---|
| `found` | The scorer ran and identified a printing (or an accepted fallback). |
| `no_match` | Every source answered and none had the card — a genuine absence. |
| `provider_unavailable` | A source went quiet, so the empty pool proves nothing. |
| `unclassified` | Scored record carrying no `candidateStatus` (pre-5.13C) — outcome unknown. |
| `no_card` | OCR ran and truthfully reported no trading card in the frame. |
| `ocr_failed` | The OCR call itself errored or timed out — nothing was read. |
| `parse_failed` | The upload didn't arrive intact, or carried no image. |
| `candidate_search_failed` | Candidate generation threw before producing a pool. |
| `scoring_failed` | The scorer threw before reaching a decision. |
| `database_failed` | A database operation threw; its pipeline position is not recorded. |
| `rate_limited` | The attempt was refused before any work began (rarely persisted). |
| `error_other` | A throw the pipeline could not attribute to a stage. |
| `unrecognized` | A stored shape this layer cannot interpret. |

---

## 7. Stage execution states (Tasks 3 & 4)

For the ordered pipeline `parse → ocr → candidates → scoring → decision`, each
attempt yields a per-stage `StageState`. This is the model that finally lets a
reader tell "never ran" from "ran, unrecorded":

| State | Meaning |
|---|---|
| `not_executed` | The attempt ended before this stage. An **absence**, not a fault. |
| `ran_empty` | The stage ran and truthfully produced nothing (no card; no candidates). A **measured zero**, not a failure. |
| `ran_failed` | The stage ran and errored/timed out. |
| `ran_ok` | The stage ran and produced a usable result. |
| `unknown` | The stage ran but the record does not record its result (pre-5.13C candidate verdict; a position-ambiguous database throw). We decline to guess. |

Worked examples:

| Record | parse | ocr | candidates | scoring | decision |
|---|---|---|---|---|---|
| accept (`found`) | ran_ok | ran_ok | ran_ok | ran_ok | ran_ok |
| not-found (`no_candidates`) | ran_ok | ran_ok | ran_empty | ran_ok | ran_ok |
| outage (`provider_unavailable`) | ran_ok | ran_ok | ran_failed | ran_ok | ran_ok |
| pre-5.13C scored row | ran_ok | ran_ok | **unknown** | ran_ok | ran_ok |
| no-card failure | ran_ok | ran_empty | not_executed | not_executed | not_executed |
| ocr failure | ran_ok | ran_failed | not_executed | not_executed | not_executed |
| candidates throw | ran_ok | ran_ok | ran_failed | not_executed | not_executed |
| database throw | unknown | unknown | unknown | unknown | unknown |

> The `not_executed` vs `unknown` split is the whole reason the state type
> exists. The first says "this never happened"; the second says "this happened
> but the record can't tell us how". Merging them re-introduces absent-as-zero.

---

## 8. Reconciling the two report views

The Phase 5.15 report prints an **Attempt interpretation** section (every record)
above the existing **Telemetry Report** (scored records only). They reconcile by:

```
interpretation.byKind.scored  ==  analysis Scans (sampleCount)
```

Everything the analysis section calls `unclassified` is a *scored* row missing
`candidateStatus`. Everything else that didn't reach the scorer — no-card, ocr
errors, parse failures — appears **only** in the interpretation section, which is
precisely where it was invisible before.

---

## 9. What was NOT changed

- No `evidence.ts`, `score.ts`, `rank.ts`, `decision.ts`, or `EVIDENCE_WEIGHTS`.
- No OCR, capture, provider ordering, search, confidence scoring, ranking, or
  decision thresholds.
- No change to what the scanner **writes** — `buildScanTelemetry` and
  `buildFailureTelemetry` are byte-for-byte unchanged. This phase only adds a
  read-side layer that **interprets** the records they already produce.
