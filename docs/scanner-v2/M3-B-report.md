# Scanner V2 · Milestone 3-B — Crop the bottom strip before the GPT strip-read

**Branch:** `feature/scanner-v2` · **Status:** built + measured, **NOT merged**. This touches
[`extractBottomStrip()`](../../src/lib/scanner/extract.ts#L169), which is **live in production**
(feature/scanner-v2 was merged to main and deployed this session). Per instruction the change is
built and verified here only; **the merge is a separate decision after these numbers are
reviewed.** Scope is the strip-read pass only — `scan/route.ts`, `evidence.ts`, and
`extractCardFields()` (the full-card pass) are untouched.

## What changed

M3-A found that `extractBottomStrip()` sends the **whole** card image at `detail:"high"` and just
tells the model to ignore everything but the bottom edge — wasteful, and (as the data below shows)
actively *hurting* accuracy on the hardest cards. M3-B crops to the strip first.

- **New:** [`src/lib/scanner/crop-strip.ts`](../../src/lib/scanner/crop-strip.ts) —
  `cropBottomStrip(imageDataUri)`. Decodes the data URI with `sharp`, extracts the **bottom 14 %
  full-width band** (`top = height*0.86` — the ratio M3-A validated against 29 real cards), and
  re-encodes as a raw-color JPEG data URI. **No grayscale/normalize** — that harness preprocessing
  was for classical OCR; a vision model wants the real pixels.
- **Fallback contract:** on *any* problem — non-data-URI input, missing comma, empty payload,
  undecodable bytes, degenerate dimensions, any `sharp` throw — it returns the **original input
  unchanged**. The strip-read then sends the full image exactly as it does today. A crop failure
  can only ever fail *open*; it can never break the call. Unit-tested
  ([`crop-strip.test.ts`](../../src/lib/scanner/crop-strip.test.ts), 7 cases).
- **Wiring:** `extractBottomStrip()` now crops first and sends the crop; the cost log distinguishes
  `strip-crop` vs `strip-full` (fallback) so production telemetry shows the crop's real hit rate.
- **`sharp` is now a declared dependency.** It was only transitive (via `next` and
  `@huggingface/transformers`) and already in `serverExternalPackages`; M3-B is the first *direct*
  runtime import of it from `src/`, so it's pinned explicitly (`^0.34.5`, the already-deduped
  version — lockfile unchanged otherwise). `next.config.ts` was **not** touched.

## Measurement — same 29 cards, same ground truth as M3-A

Re-ran M3-A's exact harness (`docs/scanner-v2/m3-harness/`, same `sample.json`) through the **real**
`cropBottomStrip()` helper, then the identical strip-read prompt. Collector number is the field
with fair printed ground truth (M3-A §1); exact = numerator matches after stripping leading zeros
and `/total`.

| Variant | CN exact | CN near | CN miss | Set exact | Avg latency | Avg prompt tokens/img | ~Cost/img |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| **Baseline** — full image, `detail:"high"` (M3-A) | 18 (62 %) | 0 | 11 | 2 | 1,688 ms | 16,484 | $0.00247 |
| **Crop + `detail:"high"`** ✅ | **23 (79 %)** | 1 | 5 | 3 | **1,315 ms** | **12,736** | **$0.00191** |
| Crop + `detail:"auto"` ✗ | 7 (24 %) | 0 | 22 | 1 | 1,051 ms | 3,979 | $0.00060 |

**Crop + `high` wins on every axis at once: +17 pp accuracy, −22 % latency, −23 % cost.**
`detail:"auto"` was measured, not assumed — it collapses accuracy to 24 % because the model
down-samples the already-small crop until the tiny strip text is gone. So `high` stays; the
`STRIP_DETAIL` constant records that decision with the numbers.

### Why accuracy went *up*, not down (the M3-A worry, inverted)

The prompt's stated risk was that a crop might cut context GPT was using. The data shows the
opposite — **8 cards fixed, 2 regressed**:

| Fixed by the crop (baseline empty → now correct) | Regressed |
| --- | --- |
| sm1-6, sv1-6, sv4pt5-6, sv8-6 *(clean modern — GPT bailed to empty on the full card)* | neo1-6 (`6/111` → `#214`) |
| **sv1-258, sv3-230, swsh8-284** *(full-art secret rares — the exact cards BOTH engines failed in M3-A)* | xy5-164 (`164/160` → empty) |

The big result: on the full card the model kept returning an **all-empty** JSON (the "conservative
empty" quirk noted in M3-A §5) — especially on ornate full-art secret rares where the number sits
over busy art. Handed only the strip, it stops bailing and reads them. **The crop specifically
rescued the hardest cards in the set.** Net collector-number reads: 18 → 23.

The 2 regressions are real and worth naming: `neo1-6` (an old card where the tighter band led the
model to grab a `#214` Pokédex-style number instead of `6/111`) and `xy5-164` (a secret rare that
now returns empty). Both are minority cases against 8 clear fixes; the net is decisively positive,
and the fallback path means neither is a *new failure mode* — just a different wrong read on 2 of 29.

**Set code:** essentially unchanged (2 → 3 exact) and still near-zero, exactly as M3-A predicted —
set code is frequently not printed / stored as a non-printed PTCGO code, so no crop recovers it.
Not a goal here.

## Verification

- `npx tsc --noEmit` → clean.
- Full suite → **317/317 pass** (7 new in `crop-strip.test.ts`, incl. the corrupt-input →
  returns-original fallback).
- `npx next build` → compiles; `/api/scanner/scan` present. The native-binary `sharp` import into
  the serverless bundle does **not** break the build (it's externalized — M2-E's groundwork).
- One-time measurement spend: ~$0.10 (58 GPT-4o-mini calls across both detail settings).

## Recommendation

**Adopt crop + `detail:"high"`.** It improves accuracy on the cards that matter most (full-art
secret rares), lowers latency and cost, and is fail-safe by construction. Built and committed on
`feature/scanner-v2`, **not merged** — pending review of these numbers.

**Caveat carried over from M3-A §6 (unchanged and still the real risk):** all 29 images are pristine
official renders. The crop ratio was validated on renders, and the accuracy lift is measured on
renders. Real phone photos are angled/blurred and the client's ROI crop (`ROI_CAPTURE_PAD`) is
padded, so the true bottom edge may sit slightly above the 14 % band on a misframed capture — in
which case the crop simply catches less and the fallback/model still sees a card-shaped image. The
`strip-crop` vs `strip-full` cost-log split was added precisely so production can confirm the crop
is landing on real user captures. **No real user scan photos are stored, so this still can't be
tested pre-merge** — the honest reason the merge is a separate, reviewed decision rather than
automatic.

### Reproduce

```bash
# from aura/  — spends ~$0.10 on OPENAI_API_KEY
node docs/scanner-v2/m3-harness/run_gpt_crop.mjs both   # runs the real cropBottomStrip() + both detail settings
node docs/scanner-v2/m3-harness/compare_m3b.js          # prints the table + per-card fix/regress list
```
