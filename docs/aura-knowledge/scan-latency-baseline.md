# Scan Latency Baseline & Findings — Phase 5.16

**Question this phase answers:** *"Where can Aura become faster without becoming less reliable?"* — not *"how do we make the number smaller?"*

**Method:** measure from real production telemetry first. Do not change `evidence.ts`,
`score.ts`, `rank.ts`, `decision.ts`, `EVIDENCE_WEIGHTS`, matching, thresholds, ranking,
or provider truth handling. Every optimization must be measurable before/after.

Source: `node scripts/telemetry-report.mjs` against production `ScanHistory`
(172 scored collector scans, 2026-07-09 → 2026-07-16; dev-bypass rows excluded).

---

## 1. Baseline (per-stage wall-clock, n=125 with `timings`)

| Stage            | median | avg    | p95    | max     | critical path? |
| ---------------- | -----: | -----: | -----: | ------: | -------------- |
| **ocrMs**        | 1763   | 2041   | 3435   | 8998    | yes — every scan, dominant |
| **candidatesMs** | 503    | 1319   | 8001   | 18098   | yes — tail is provider timeout |
| **scoreMs**      | 1      | 507    | 1959   | 3151    | yes — bimodal (see below) |
| rateLimitMs      | 201    | 327    | —      | 819     | yes — DB count, pre-OCR gate |
| learningRuleMs   | 76     | 138    | —      | 329     | no — deferred behind candidate fetch |
| authMs           | 7      | 15     | —      | 45      | yes |
| parseMs          | 2      | 1      | —      | 2       | yes |
| **total scan**   | **3873** | **5129** | **10875** | **58678** | **end-to-end (`processingTime`)** |

`total scan` is the row's authoritative `ScanHistory.processingTime` — the whole
server request, auth → response. It covers **all 172 scored rows** (better coverage
than the per-stage `timings`, which only 125 carry).

---

## 2. The headline finding: ~36% of the median scan was un-measured

Summing the **median** stages gives ≈ 1763 + 503 + 1 + 201 + 7 + 2 ≈ **2477 ms**,
against a **median total of 3873 ms**. A comparable gap holds on the average
(stage-sum ≈ 4348 ms vs. total avg 5129 ms).

**The largest single component of scan latency was invisible.** That dark ~1.4 s
(median) is real user-facing time with two known homes, neither captured by
`timings`:

1. **The terminal DB persist on an accepted scan** — `persistPrinting` +
   `scanHistory.create` + `getArchiveContext` in `saveAndRespond()`. This runs
   *after* the `timings` snapshot is built (it has to — the snapshot is written
   *into* that very row), so it never appears in the per-stage breakdown.
2. **Un-instrumented gaps** between stages (image validation, evidence-bundle
   assembly, the strip-OCR reconcile await, the decision gate, telemetry
   serialization).

This is why the disciplined action for this phase is measurement, not a speed
change: **you could not do Task 4's required before/after on the biggest cost,
because it wasn't on the graph.**

### Why it was dark, and what changed

`analyzeTelemetry` was *built* to report total scan — it reads `timings.totalMs` —
but **nothing has ever emitted `totalMs`**. Every "total scan" cell rendered
"no data". Meanwhile the authoritative end-to-end number, `processingTime`, was
already recorded on every row and simply never read.

The fix (Phase 5.16) teaches the **observation layer only** to read that column:

- `TelemetrySample.processingTimeMs` (new, optional) carries the row's `processingTime`.
- `totalScanValues()` prefers it; falls back to the in-JSON `totalMs` key (still
  none today); contributes nothing when absent — so total stays "no data" rather
  than a fabricated stage-sum. Same *absent-is-not-zero* rule as the rest of the module.
- `scripts/telemetry-report.mjs` selects `processingTime` and passes it through.
- The report labels the line end-to-end and notes the stages do not sum to it.

No scan-path code, no protected file, no decision changed. It is pure observability,
and it is the prerequisite for any measured optimization.

---

## 3. The two real latency levers — and why each is deferred

### OCR (`ocrMs`): the dominant *consistent* cost
Median 1763 ms, on **every** scan, ~71% of the summed median critical path. The
full-pass and strip-pass OCR calls already run in parallel (the strip round-trip
hides behind the full pass), so the structure is already optimal. Reducing it
further means touching **image resolution / capture / the vision call** — i.e.
recognition accuracy, the one thing this phase forbids trading. `AGENTS.md`:
*"Never begin by changing prompts… Optimize where users notice… Measure before
optimizing."* Deferred: needs a capture-quality experiment with accuracy held as
the gate, not a blind latency cut.

### `candidatesMs` tail: provider timeout, not a knob
Median is healthy (503 ms). The tail is brutal — p95 8001 ms, **max 18098 ms** —
and it is entirely the **Pokémon TCG API timing out**. In this window every
Pokémon provider call recorded (3/3) failed with `timeout`, at 8001/8003/**16006** ms;
the 16 s case is two 8 s ceilings stacked (the parallel first wave, then a
sequential fallback query against the same down API). This is **reliability**
behaviour governed by the Phase 5.13 truth boundary: an 8 s ceiling that surfaces
as `provider_unavailable` rather than a false "not found". Shortening the timeout
or dropping the fallback would trade the truth boundary and the recovery path for
speed — exactly the trade this phase rejects. Deferred to a provider-reliability
phase that can weigh recovery-on-retry against latency with its own before/after.

### `scoreMs`: bimodal, and inside a protected file
Median 1 ms, p95 1959 ms, max 3151 ms. The ~2 s cases are the visual/artwork
comparison vision call inside the scorer. `score.ts` is on the do-not-touch list.
Deferred by constraint.

---

## 4. What Phase 5.16 delivered

- **Baseline established** from real telemetry (this document).
- **Measurement gap closed:** total scan latency is now observable end-to-end,
  from the authoritative `processingTime`, for every scored row — with zero change
  to the scan request path or any protected file.
- **Next target made visible:** the ~1.4 s median dark remainder (persist + gaps)
  is now bounded. The natural follow-up is to instrument the persist stage
  (`persistMs` / `archiveMs`) so that remainder is itself broken down — a safe,
  additive telemetry step, now that we know it is worth doing.

**Confirmed unchanged:** `evidence.ts`, `score.ts`, `rank.ts`, `decision.ts`,
`EVIDENCE_WEIGHTS`, card matching, confidence thresholds, candidate ranking,
provider truth handling. `npm test` (256 pass), `tsc --noEmit` (exit 0),
`npm run build` all green.
