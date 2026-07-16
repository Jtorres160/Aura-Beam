# Critical-Path Latency Investigation — Phase 5.17B

**Question this phase answers:** *"Why does Aura spend time in OCR and candidate
retrieval?"* — not *"how do we make the number smaller?"*

**Constraint:** investigation only. No optimization. No change to `evidence.ts`,
`score.ts`, `rank.ts`, `decision.ts`, `EVIDENCE_WEIGHTS`, matching, ranking,
confidence thresholds, or provider truth semantics. Accuracy is never traded for
speed. The one code change is **read-only OCR-cost observability** (§5), which
touches no decision and changes no output.

Source: read-only pass over production `ScanHistory` (`node` scripts issuing
`findMany` only), same sanctioned window as Phase 5.16 (dev-bypass rows
excluded). n=101 MTG / 15 Pokémon / 10 Yugioh scans carry per-stage `timings`.

---

## 1. OCR investigation (Task 1)

### What the pipeline actually sends

The uploaded image is large by design (`capture.ts`):

- `CAPTURE_MAX_DIM = 2048` — longest edge (raised from 1024 so the bottom
  set/collector strip's sub-mm text survives).
- `CAPTURE_JPEG_QUALITY = 0.92` (raised from 0.85 for the same reason).
- Two vision calls per scan: **full pass** `detail:"auto"`, **strip pass**
  `detail:"high"` (`extract.ts`). `detail:"high"` tiles the image at full
  resolution → many image tokens.

Both passes run in parallel; `ocrMs` measures the **full pass only** (the strip
pass is awaited later, behind the candidate fetch). The `throttleVision` gate
(`VISION_MIN_GAP_MS = 500`) reserves the full pass's start FIRST, so on a
single scan its wait is 0 (the 500 ms lands on the non-critical strip pass by
design). **`ocrMs` is therefore essentially the full-pass vision call
wall-clock — not throttle, not retries** (retries fire only on failure).

### Measured `ocrMs` by game

| game    | median | p95  | max  | n   |
| ------- | -----: | ---: | ---: | --: |
| MTG     | 1839   | 3410 | 8998 | 101 |
| Pokémon | 1519   | 3744 | 3744 | 15  |
| Yugioh  | 1812   | 3435 | 3435 | 10  |

**OCR latency is game-independent (~1500–1840 ms median across all three).**
That is the signature of a cost driven by the *image + model inference*, not by
anything game-specific — the same 2048 px / q0.92 upload and the same
`gpt-4o-mini` vision call run regardless of game. The `max 8998` (MTG) is a
single slow call, still under the 15 s ceiling (not a retry).

### Where OCR time comes from — attribution

- **Not retries.** `OCR_MAX_RETRIES = 2` fire only on a failed call; the happy
  path never retries serially.
- **Not the throttle.** 0 ms added to the full pass on single scans (§ above).
- **Not preprocessing.** Capture (frame sampling, sharpness pick, JPEG encode)
  happens on the *client* before upload — it is not inside `ocrMs`.
- **It is network upload + model inference on a large image.** This is the
  residual, and it is the whole of `ocrMs`. The exact upload-vs-inference split
  is not observable from the OpenAI SDK, but the image *cost* is — see §5.

**Conclusion:** OCR is the dominant *consistent* cost (~46% of the scan, every
scan), and it is structurally a single vision call on a deliberately large
image. The only lever is image size / detail — which is exactly the
accuracy-bearing knob (strip legibility) this phase forbids cutting blind.

---

## 2. Candidate / provider investigation (Task 2)

### Measured `candidatesMs` by game

| game    | median | p95   | max   | n   |
| ------- | -----: | ----: | ----: | --: |
| MTG     | 357    | 1707  | 5266  | 101 |
| **Pokémon** | **8001** | **18098** | **18098** | 14 |
| Yugioh  | 1134   | 2806  | 2806  | 10  |

**The entire candidate tail is Pokémon.** MTG (Scryfall) is fast — median
357 ms, single round-trip, and its set/CN + name lookups run in parallel so the
direct hit hides behind the name search. Yugioh is one call, moderate. The
pooled ~503 ms median from Phase 5.16 is the MTG-majority median; the p95/max
tail is a different population entirely.

### The Pokémon median IS the ceiling

Pokémon median `candidatesMs` is **8001 ms** — the `PROVIDER_TIMEOUT_MS = 8_000`
value itself. In this window, **the median Pokémon candidate fetch times out.**
Per-source telemetry (`candidateSources`, added Day 0, n=3 Pokémon rows so far)
agrees: **pokemon 3/3 = 100% `timeout`** at 8003/8003/16006 ms; scryfall 97 ms,
0 failures. This is **failure behavior, not normal latency** — the Pokémon TCG
API is unwell in this window, exactly as Phase 5.13/5.16 recorded (it 404s and
504s on URLs it later serves 200).

### How 8 s becomes 16–18 s

`fetchPokemonPrintings` fires `searchPokemonBySetAndNumber` ∥
`fetchAllPokemonPrintings` (parallel, one 8 s span if both hang), then a
**sequential** `searchPokemonCards` fallback (another 8 s). Two stacked ceilings
→ ~16 s. The unknown-game path adds the MTG attempt *before* Pokémon. The
observed `18098` max is those stacked ceilings plus overhead; the pathological
`58678 ms` worst case (§4) is this pattern brushing the 60 s `maxDuration`.

**Conclusion:** the candidate tail is a *provider outage surfaced as an 8 s
ceiling*, governed by the Phase 5.13 truth boundary (timeout → `provider_
unavailable`, never a false "not found"). Shortening the timeout or dropping the
fallback trades the truth boundary / recovery path for speed — the trade this
phase rejects. Deferred to a provider-reliability phase with its own before/after.

---

## 3. Latency breakdown (median accepted scan)

| segment | ms | % of scan | notes |
| ------- | --: | --------: | ----- |
| OCR (`ocrMs`, full pass) | ~1763 | ~46% | dominant, consistent, game-independent |
| candidate retrieval | ~357 (MTG) / **8001 (Pokémon timeout)** | 9% / tail | MTG healthy; Pokémon = outage |
| rateLimit DB count (pre-OCR) | ~201 (819 seen) | ~5% | cold-connection spikes |
| score | ~1 (p95 ~1959) | ~0% | bimodal — vision compare only when needed |
| auth + parse | ~9 | <1% | negligible |
| **dark remainder** (persist + gaps) | **~727** | ~19% | Phase 5.17A — *not* dominant, not persistence-bound |

The two levers worth a future phase are the two the phase named: **OCR** (the
consistent 46%) and the **Pokémon provider tail** (the outage). Everything else
is either negligible or already explained (5.17A).

---

## 4. Debugging trace (Task 4) — real scans, end to end

Traced from stored telemetry of real production rows (not synthetic).

### 4a. Healthy MTG accept — `processingTime 4342 ms`
```
timings: auth=7 rateLimit=819 parse=2 ocr=2515 candidates=99 learningRule=329 score=1
sources: scryfall=97ms(completed)   decision: accept set-cn-verified conf=0.97
```
Path: `auth` → `scanHistory.count` (rate gate, **819 ms** — a cold-connection
spike, normally ~201) → `req.json()` → **OCR full pass 2515 ms** (dominant) →
Scryfall set/CN + name in parallel, direct hit verified by name (**99 ms**) →
scorer short-circuits on `set-cn-verified` (`score=1 ms`, no vision compare) →
gate accepts at 0.97 → persist (in the ~899 ms remainder). `learningRule` 329 ms
ran in parallel behind the candidate fetch — off the critical path.
**Where time accumulates: OCR (58%), then the cold rate-limit count.**

### 4b. Pokémon provider timeout — `processingTime 9922 ms`
```
timings: auth=3 rateLimit=95 parse=0 ocr=1395 candidates=8001 score=0
sources: pokemon=8001ms(failed:timeout)   status=found printings=17 → disambiguate
```
**Unexpected behavior worth recording:** this scan *found 17 printings* (the name
search succeeded) yet still paid the **full 8 s**. `fetchPokemonPrintings` does
`await directPromise` (set/number lookup) *before* reading the already-resolved
`allPromise` — so a hung direct call blocks the scan for the whole ceiling even
though the name search had the answer early. The 8 s is pure dead wait here, not
work. (Structural note only — reordering is provider behavior, deferred.)

### 4c. Worst case — `processingTime 58678 ms`
Pokémon, disambiguation-pending, `timings` absent (legacy-shape row). Brushes
the 60 s `maxDuration` — stacked Pokémon timeouts + retries. This single row is
the `max 58678` that inflated the Phase 5.16 total-latency max.

---

## 5. Observability added (Task 3)

Current telemetry answers *"which stage?"* (per-stage `timings`) and, for
candidates, *"which source, how slow, why?"* (`candidateSources`). It could
**not** answer *"why is the OCR stage itself slow?"* — `ocrMs` was one opaque
await with no image-size or model-cost signal, and OCR is the largest cost.

Added in [extract.ts](../../src/lib/scanner/extract.ts) — one console line per
pass, **console-only, never persisted, never returned, never branched on**:
```
[Scanner] ⏱  ocr-cost full  | image=NNNKB detail=auto promptTokens=… completionTokens=…
[Scanner] ⏱  ocr-cost strip | image=NNNKB detail=high promptTokens=… completionTokens=…
```
Both numbers are **measured, not fabricated**: image KB from the data URI we
already upload, tokens from the OpenAI `usage` we already receive. Image tiles
land in `prompt_tokens`, so a future resolution/`detail` experiment sees its
effect on model cost *and* upload size directly — a real before/after for the
one lever OCR has. No decision, output, or scan behavior changes.

**Candidates need no new instrument** — `candidateSources` already carries
per-source duration + reason; it only needs a wider window to accumulate (n=3
Pokémon rows post-Day-0 today).

---

## 6. Recommended optimization targets (for a LATER phase)

Ranked by expected user-visible payoff, each gated on the accuracy/reliability
constraint that defers it now:

1. **OCR image cost.** ~46% of every scan. Lever: image resolution / `detail`
   level (esp. the strip pass's `detail:"high"`). **Gate:** must hold set/CN
   strip legibility — run it as a capture-quality A/B with accuracy as the
   pass/fail, using the §5 `ocr-cost` line + recognition rate as before/after.
   *Do not cut blind.*
2. **Pokémon provider tail.** The 8 s→18 s (→58 s) tail is 100% Pokémon
   timeout. Levers, all reliability-sensitive: (a) don't `await directPromise`
   ahead of an already-resolved `allPromise` (§4b — race them, take the first
   real hit); (b) drop the sequential `searchPokemonCards` third call when the
   parallel wave already answered; (c) revisit the 8 s ceiling. **Gate:** the
   Phase 5.13 truth boundary — a timeout must still surface as
   `provider_unavailable`, never a false "not found". Needs a
   provider-reliability phase weighing recovery-on-retry vs latency.
3. **Cold rate-limit count.** `rateLimitMs` spikes to ~819 ms cold (§4a) for a
   single pre-OCR `COUNT`. Minor and infrastructural (connection warmth), not a
   code-logic target. Watch, don't chase.

---

## 7. Risks identified

- **OCR resolution is load-bearing for accuracy.** `CAPTURE_MAX_DIM`/quality/
  `detail` were raised *specifically* for strip-text recognition. Any OCR speed
  cut risks re-introducing set/CN misreads → more disambiguation, lower
  auto-accept. This is the accuracy-for-speed trade AGENTS.md forbids.
- **The Pokémon tail is a truth-boundary guard, not dead weight.** The 8 s
  ceiling exists so an outage says "I couldn't check", not "not found". Cutting
  it to save p95 would let a provider outage masquerade as a card that doesn't
  exist — a trust regression, not a perf win.
- **`await directPromise` ordering (§4b)** makes a healthy scan wait on an
  unhealthy parallel call. Reordering is safe-looking but touches provider
  behavior and match provenance (`set-cn-verified` depends on that direct hit) —
  must be done inside a reliability phase with matching held constant, not here.
- **Small post-Day-0 per-source sample (n=3–4).** The 100% Pokémon timeout rate
  is real but on a thin window; the by-game `candidatesMs` (n=14 Pokémon)
  corroborates it. Widen the window before acting on provider numbers.

---

## 8. Confirmation — production behavior unchanged

- **Only file changed:** [extract.ts](../../src/lib/scanner/extract.ts) — two
  `console.log` calls + two pure helpers (`approxImageKB`, `logOcrCost`). No
  change to the OCR request, the parsed reading, retries, timeouts, or the
  returned `OcrFields`.
- **Untouched:** `evidence.ts`, `score.ts`, `rank.ts`, `decision.ts`,
  `EVIDENCE_WEIGHTS`, candidate matching, ranking, confidence thresholds,
  provider truth semantics, `candidates.ts`, `capture.ts`, the scan route.
- **Telemetry remains observational** — the new line is logged, never persisted,
  never returned, never read by any decision.
- **Gates green:** `npx tsc --noEmit` exit 0; `npm test` 256/256 pass;
  `npm run build` compiled successfully.

**This phase measured and understood the critical path. It did not optimize it.**
The next change — an OCR image-size A/B, or a Pokémon reliability pass — is now
scoped against real numbers with a before/after signal in place.
