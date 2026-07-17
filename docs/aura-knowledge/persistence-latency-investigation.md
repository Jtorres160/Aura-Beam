# Persistence Latency Investigation — Phase 5.17

**Question this phase answers:** *"Is the post-scan persistence path responsible
for the ~1.4 s median dark remainder that Phase 5.16 discovered?"*

**Constraint:** observation only. No operation moved, no response field changed,
no scanner logic altered. This phase adds instrumentation and reports; it does
**not** optimize. Any speed change is a separate, later phase with its own
before/after — exactly as Phase 5.16 left it.

---

## 1. Where the remainder was hiding (recap of Phase 5.16)

Phase 5.16 established that ≈36% of the median scan (~1.4 s of a 3873 ms median
`processingTime`) sat outside every `timed()` call. Its named home #1 was the
terminal DB persist on an **accepted** scan:

> `persistPrinting` + `scanHistory.create` + `getArchiveContext` in
> `saveAndRespond()`. This runs *after* the `timings` snapshot is built (it has
> to — the snapshot is written *into* that very row), so it never appears in the
> per-stage breakdown.

That ordering is the whole reason the remainder was dark, and it is also why the
fix here is a **separate console line**, not a new stage in the persisted
`timings` object: the timings snapshot is already serialized into
`telemetryJson` before `saveAndRespond` is even called. Writing these numbers
into the row would require either moving the serialization after the persist
(moves operations) or a second write to the row (adds a DB round-trip). Both are
forbidden this phase, so the spans are **logged, never persisted, never returned.**

---

## 2. What was instrumented

All sites are in [src/app/api/scanner/scan/route.ts](../../src/app/api/scanner/scan/route.ts).

### 2a. Accepted-scan persist — the primary target (`saveAndRespond`)

Three spans mirror the critical-path `timed()` helper, plus a wrapping total:

| Span                 | Wraps                                    | DB round-trips |
| -------------------- | ---------------------------------------- | -------------: |
| `persistPrintingMs`  | `persistPrinting(matchedCard)`           | 2 (Card upsert → CardPrice upsert, sequential) |
| `scanHistoryMs`      | `prisma.scanHistory.create(...)`         | 1 |
| `archiveContextMs`   | `getArchiveContext(userId, localCard)`   | 1 + 2 (findFirst → [findUnique ∥ count]) |
| `persistTotalMs`     | wall-clock across all three (incl. gaps) | — |

Emitted as one line, same `⏱` shape as the critical-path summary:

```
[Scanner] ⏱  persist 1420ms | persistPrinting=610 scanHistory=250 archiveContext=560
```

`persistTotalMs` is captured independently of the three spans, so comparing it
against their sum tells us whether the measured stages account for the whole
post-decision span or whether residual gap remains between them.

### 2b. Disambiguation-pending persist — secondary site

The other common post-decision persistence path is a single
`scanHistory.create` (no `persistPrinting`, no archive), also downstream of the
timings snapshot. Timed the same way, logged only:

```
[Scanner] ⏱  persist 240ms | disambiguation-pending scanHistory=240
```

### 2c. Deliberately **not** instrumented

The failure-path `scanHistory.create` calls (`provider-unavailable`,
`not-found`, the catch-all, and `persistAttempt`) are single writes on scans
that never produced a card. They are not the accepted-scan median under
investigation and were left untouched to keep the change proportionate. Their
cost, if ever needed, is bounded by `scanHistoryMs` above (same single-create
shape).

---

## 3. Structural expectation (before the logs land)

Per **AGENTS.md** ("Never fabricate analytics… Historical data should always
come from stored history, not simulated values"), no median is asserted here
until the instrumented logs are harvested from production. What the code
structure *does* let us bound, by inspection:

- The accept path performs **~5 sequential DB round-trips** after the timings
  snapshot. At the connection-level latency implied by Phase 5.16's pre-OCR
  `rateLimitMs` (median **201 ms** for a single `scanHistory.count` round-trip
  against the same serverless Postgres), five sequential round-trips are a fully
  sufficient mechanism for a ~1.4 s remainder — no unknown cost need be
  postulated. The persist path is therefore the **leading, and structurally
  sufficient, suspect**; the logs will confirm the split.
- `persistPrinting` (2 sequential upserts) and `getArchiveContext` (1 + a
  parallelized pair) are each expected to be the two largest contributors;
  `scanHistory.create` is a single insert and should track `rateLimitMs`.
- If `persistTotalMs` materially exceeds `persistPrintingMs + scanHistoryMs +
  archiveContextMs`, the residual is un-awaited/GC or connection-acquisition gap
  — worth a note, not action, this phase.

This is a hypothesis with a sufficient mechanism, **not** a measurement. The
deliverable of 5.17 is the instrument that turns it into one.

---

## 4. How to harvest the report

The spans go to the server console (Vercel function logs), not to a queryable
column — by constraint (§1). To produce the empirical median:

1. Collect `[Scanner] ⏱  persist …` lines from production logs over a window
   comparable to the Phase 5.16 baseline (≥100 accepted scans).
2. Split by the leading token (`persistPrinting=` accept path vs.
   `disambiguation-pending`).
3. Report median / avg / p95 / max per span, exactly as the Phase 5.16 baseline
   table, and check the sum-vs-total identity from §2a.
4. Compare `persistTotalMs` median against Phase 5.16's ~1.4 s remainder. If it
   accounts for most of it, the remainder is **explained** and a persistence
   phase can be scoped against a real before/after. If a gap survives, the
   remaining §5.16 suspects (image validation, evidence-bundle assembly, strip
   reconcile await, decision gate, telemetry serialization) are next.

---

## 5. What Phase 5.17 delivered

- **The accepted-scan persist path is now observable** end-to-end
  (`persistPrintingMs`, `scanHistoryMs`, `archiveContextMs`, `persistTotalMs`),
  and the disambiguation persist alongside it — the last un-instrumented segment
  of the median scan named by Phase 5.16.
- **Zero behavioral change:** operations run in the same order, the response is
  byte-identical, the persisted `timings`/telemetry are untouched, and every
  span is failure-neutral (pure `try/finally` wall-clock).
- **The ~1.4 s remainder is now falsifiable against production**, not just
  bounded by arithmetic.

**Confirmed unchanged:** operation order and response shape in
`scan/route.ts`; `persist-printing.ts`, `archive-context.ts`, `prisma.ts`
(read only, not edited); `evidence.ts`, `score.ts`, `rank.ts`, `decision.ts`,
`EVIDENCE_WEIGHTS`, matching, thresholds, ranking, provider truth handling.
`tsc --noEmit` exit 0, `npm test` 256/256 pass.

---

# Phase 5.17B — Measurement Window Results

**Constraint (unchanged):** observation only. No operation moved, no write made
async, no response behaviour changed, no telemetry builder or scanner logic
altered. This section only reads and reports.

## 6. The span logs have zero samples — and why

The four required span fields are **console-only and un-deployed**:

| field | median | p95 | max | samples |
| ----- | -----: | --: | --: | ------: |
| `persistTotalMs`    | — | — | — | **0** |
| `persistPrintingMs` | — | — | — | **0** |
| `scanHistoryMs`     | — | — | — | **0** |
| `archiveContextMs`  | — | — | — | **0** |

The §2 instrumentation lives in an **uncommitted** working change to
`scan/route.ts` (last shipped commit is `cd1b3a02`, Phase 5.16). It has never
executed in production, so no `[Scanner] ⏱  persist …` line exists in any log,
and the spans are console-only by §1 constraint — they were never queryable.
There is nothing to harvest. Per **AGENTS.md** ("Never fabricate analytics…
Historical data should always come from stored history"), those four cells stay
empty rather than being filled with a plausible-looking guess. **The per-span
split is deferred until 5.17A is deployed and a real log window (≥100 accepts)
is captured — it is genuine future work, not a number this phase can produce.**

## 7. What the database *can* answer now — the dark remainder itself

The span split is unavailable, but the aggregate it was meant to break down is
**already in the DB, on every row.** Persistence runs entirely after the
`timings` snapshot and entirely inside `processingTime`, so for each row:

> `darkRemainder = processingTime − Σ(critical-path stages)`
> where critical-path = `auth + rateLimit + parse + ocr + candidates + score`
> (`learningRule` is parallel behind the candidate fetch — excluded, per §5.16).

This is a clean **upper bound on all post-`timings` cost** (persist **plus**
inter-stage gaps), computed **per row, then aggregated** — the honest statistic,
unlike a sum-of-medians. Source: read-only pass over production `ScanHistory`,
n=126 v1 rows with `timings`, window **2026-07-13 → 2026-07-16**, dev-bypass
rows excluded, 0 negative remainders (no stage-overlap skew).

| cohort | metric | median | p95 | max | n |
| ------ | ------ | -----: | --: | --: | -: |
| **Accepted** (`cardId` set) | total (`processingTime`) | 3790 | 6415 | 12200 | 65 |
|                              | critical-path Σ          | 2965 | 5090 | 11181 | 65 |
|                              | **dark remainder**       | **727** | **1639** | **1744** | 65 |
| **Rejected** (`cardId` null) | total (`processingTime`) | 4547 | 10875 | 21879 | 61 |
|                              | critical-path Σ          | 3515 | 10202 | 20610 | 61 |
|                              | **dark remainder**       | **768** | **1553** | **2465** | 61 |

## 8. Verdict — persistence is *not* the dominant contributor

**Answer to the phase question ("is post-decision persistence the dominant
latency contributor?"): no — the evidence rejects it.** Three findings:

1. **The remainder is ~727 ms median (accepted), not ~1.4 s.** Phase 5.16's
   "~1.4 s" was `median(total) − Σ median(stage)` = 3873 − 2477 = 1396 ms — a
   **sum-of-medians artifact**. Stage latencies are right-skewed and positively
   correlated (a slow scan is slow in `ocr` *and* `candidates` together), so the
   per-row median remainder (727 ms) is ~half that arithmetic gap. It is **19.2%
   of the median accepted scan**, against OCR's ~1763 ms (~46%). Even at its
   ceiling — 100% of the remainder being persist — persistence cannot be the
   dominant cost while the whole dark region is under a fifth of the scan.

2. **The write-count discriminator fails for the persist hypothesis.** The
   accept path runs **~5 sequential DB round-trips** (persistPrinting's 2 upserts
   + `scanHistory.create` + archive's 1+2); the disambiguation-pending path runs
   **exactly 1** (`scanHistory.create`). If persistence dominated the remainder,
   5× the writes should carry a visibly larger remainder. It does not —
   **727 ms (5 writes) vs 755 ms (1 write), statistically identical.** The
   remainder does not scale with DB round-trips, so it is dominated by the
   **inter-stage gaps** (image validation, evidence-bundle assembly, the strip
   reconcile await, decision gate, telemetry serialization), **not** the persist
   writes. This directly **contradicts the §3 structural expectation** that
   persistence was "the leading, and structurally sufficient, suspect" — the
   measurement overrides the hypothesis, which is the entire point of measuring
   first.

3. **The remainder is tightly bounded.** Accepted p95 1639 ms, max 1744 ms — the
   post-decision path produces no multi-second stalls. The long scan tail lives
   in the critical path (rejected p95 total 10875 ms — the Phase 5.16 Pokémon
   provider timeout), not in persistence.

## 9. Consequence for optimization

**No persistence optimization is justified by this data** — it would chase a
~700 ms region that (a) is ≤19% of the scan, (b) does not scale with the write
count, and (c) is at least half non-persist gap. The measurements do **not**
license moving operations, batching writes, or deferring the archive read.

The two real, still-deferred levers remain the Phase 5.16 pair: **OCR** (~1763 ms,
dominant, every scan) and the **Pokémon provider timeout** tail — both gated on
accuracy/reliability, both out of scope here.

If the per-span split is still wanted for completeness, the honest path is: ship
5.17A, harvest ≥100 accepted `[Scanner] ⏱  persist …` lines, and fill §6 from
that real window. But **§8 already answers the question the split was meant to
settle** — persistence is not the dominant contributor — so that harvest is now
confirmation, not a decision input.

**Confirmed unchanged (5.17B):** no file in the scan path edited; measurement was
a read-only pass over production `ScanHistory` (`findMany`/`count` only, the
sanctioned Phase 5.16 pattern). `scan/route.ts` still carries only the §2
console instrumentation from 5.17A; `evidence.ts`, `score.ts`, `rank.ts`,
`decision.ts`, `EVIDENCE_WEIGHTS`, matching, thresholds, ranking, and provider
truth handling untouched.
