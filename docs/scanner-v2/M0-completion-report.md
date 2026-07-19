# Scanner V2 · Milestone 0 — Completion Report

**Branch:** `feature/scanner-v2`
**Scope delivered:** measurement + regression harness. **No production recognition
behavior was changed** (no scan-path file was modified — verified below).
**Data window:** all v1 telemetry in production `ScanHistory` (198 collector records,
dev rows excluded), read-only.

---

## 1. Validation gate — all green

| Check | Result |
| --- | --- |
| Existing test suite | **280 pass / 0 fail** (256 prior + 24 new) |
| New unit tests | **24 pass / 0 fail** |
| TypeScript (`tsc --noEmit`) | **0 errors** |
| Production build (`next build`) | **succeeds** |
| Production recognition behavior | **unchanged** — no scan-path file touched |
| Baseline script vs. production | **ran read-only**, numbers below |

---

## 2. The headline finding

> **Two-thirds of scans (66.7%) currently force the user to disambiguate.**
> Only **26.5%** auto-accept.

This reframes the whole V2 value case. V2 is not primarily a speed/cost play — it is
about removing the **manual pick** that two of every three scans demand today. A local
visual-fingerprint sensor that can resolve art-group ambiguity automatically attacks
exactly this number. This is the strongest quantitative justification for the V2
direction we now have.

## 3. Recognition baseline (n = 198 records, 189 scored)

**Outcome distribution**

| Outcome | Count | Share of scored |
| --- | ---: | ---: |
| Accept (auto-save) | 50 | 26.5% |
| Disambiguate (user picks) | 126 | 66.7% |
| Scorer not-found | 13 | 6.9% |

**Accepts by method** — where confident identifications actually come from:

| Method | Count | Share of accepts |
| --- | ---: | ---: |
| `set-cn-verified` | 39 | 78% |
| `single-printing` | 6 | 12% |
| `art-group-vision` | 5 | 10% |

> **This validates the Rev. B correction directly.** 78% of all auto-accepts come from
> reading the **set + collector number** — not from the vision art-pick, which produced
> only 5. Any V2 design that removed the set/CN read (and leaned on visual match alone)
> would forfeit the large majority of confident identifications. The planned **local
> set/CN OCR sensor (M3) is not optional** — it is where confidence is actually earned.

**Recognition cost (the latency V2 targets)**

| Metric | Value |
| --- | ---: |
| OCR median | **1811 ms** |
| OCR p95 | 3435 ms |

Consistent with the Phase 5.16 baseline (~1763 ms). Recognition remains the dominant,
per-scan cost — and it is a remote paid call on every scan.

**Failure modes** (across all 198 records)

| Mode | Count |
| --- | ---: |
| OCR call failed (incl. rate-limit episodes) | 5 |
| Provider unavailable | 3 |
| No card in frame | 3 |
| Database failed | 1 |
| Verified "no such card" | 0 |
| Rate limited (classified) | 0 |

Failure volume is low and healthy. Note "no card exists" is **0** — the truth boundary
is holding (no scan falsely told a collector their real card doesn't exist).

## 4. Recognition-Memory serve — safety audit

The question M0 was asked to answer: *is it safe to enable `RECOGNITION_MEMORY_SERVE`?*

| Signal | Value |
| --- | ---: |
| Records carrying a memory shadow block | 17 |
| Hits / misses | 6 / 11 |
| Matched by set-cn / name | 4 / 2 |
| **Disagreements (must be 0 to serve)** | **0** |
| Agreements | 3 |
| **Memory-only resilience wins** (memory held the card while the live pipeline failed) | **3** |
| Provider calls avoidable on hits | 6 |
| **Serve-safety verdict** | **CLEAN** |

**Interpretation — and the honest caveat.** The verdict is *clean*: memory never once
disagreed with the live pipeline on a card both resolved. The 3 memory-only wins are the
value proof — real scans where memory would have carried the identity through a provider
failure. **But the sample is small** (17 observations, 6 hits). "Zero disagreements out of
6 hits" is encouraging, not yet conclusive.

**Recommendation (decision deferred to you — enabling is out of M0 scope by design):**

- The data *supports* enabling serve, and doing so would immediately buy provider-
  independence for repeat scans.
- Given the small sample, the conservative path is **enable with monitoring** (the shadow
  telemetry keeps recording, so a first disagreement is caught), rather than enable-and-
  forget. Alternatively, let shadow accrue to ~30–50 hits first.
- Either way this is a **one-line env flag flip** (`RECOGNITION_MEMORY_SERVE=1`) with an
  instant rollback, and it is genuinely independent of the fingerprint work.

## 5. Ground truth already in hand

**62 user disambiguation picks** are sitting in production telemetry as hard,
printing-level labels — plus the pipeline's evidence for each. This is a meaningful seed
for both the benchmark dataset and (later) embedding fine-tuning, and it grows every day
the current pipeline runs. Aura is accumulating its own proprietary training/eval set as
a side effect of normal use.

## 6. What shipped

All new files; no existing file modified.

- `docs/scanner-v2/M0-implementation-contract.md` — the pre-work contract.
- `docs/scanner-v2/M0-completion-report.md` — this report.
- `src/lib/scanner/recognition-baseline.ts` (+ `.test.ts`) — pure, tested analysis of
  outcomes, memory-shadow audit, repeat scans, ground truth, failure modes, OCR cost.
- `scripts/recognition-baseline.mjs` — read-only DB runner (same pattern as
  `telemetry-report.mjs`).
- `src/lib/scanner/benchmark/` — the Recognition Benchmark Dataset: `types.ts` (12
  difficulty categories, identity- and printing-level truth), `loader.ts` (strict
  validator), `loader.test.ts`, `manifest.json` (empty by design), `images/README.md`.

## 7. Findings that shape M1

1. **Disambiguation rate (66.7%) is the primary V2 target metric.** M1+ should report
   its effect on this number first.
2. **Local set/CN OCR (M3) is load-bearing** — 78% of accepts depend on set/CN today.
3. **Telemetry gap:** `bestMatchExternalId` (vision's art pick) is not persisted, so
   "did vision agree with the user's final pick?" is not yet computable from history.
   Recording it is a purely additive, behavior-neutral change — recommended as the first
   M1 step so the benchmark can grade the *current* art-pick accuracy retroactively.
4. **Benchmark is empty and must be seeded** before recognizer scoring in M1+. The 62
   existing labels are the natural first source.

## 8. Rollback

`git revert` of the M0 commit removes every file above. No scan-path code changed, so
runtime behavior is identical with or without M0 — rollback risk is zero.
