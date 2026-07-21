# Scanner V2 · Milestone 3 — Investigation: Local OCR for the Set/Collector Strip

**Branch:** `feature/scanner-v2` (kept on the V2 line — M3 continues the M0→M1→M2
lineage and its doc sits beside `M0`/`M1` here; no separate `scanner-v3` branch was cut).
**Status:** Investigation only. **No scan-path files touched, no wiring, no permanent
dependency added.** `extract.ts`, `scan/route.ts`, `evidence.ts`, and `next.config.ts` are
untouched. Test packages (`tesseract.js`) were installed with `--no-save` and backed out;
the TrOCR model cache was deleted. `package.json` is byte-identical to before this milestone.

**Question this milestone answers:** today [`extractBottomStrip()`](../../src/lib/scanner/extract.ts#L161)
sends the **whole** card image to `gpt-4o-mini` at `detail:"high"` and asks it to read only
the bottom strip (`setCode`, `collectorNumber`, `rarity`, `artist`). There is no crop. Can a
**local** OCR path — classical (Tesseract.js) or a Transformers.js text-recognition model —
read the set-code / collector-number strip well enough to replace or corroborate that call,
cheaply and offline? This measures candidate accuracy against real ground truth and gives a
go/no-go with an honest domain-gap caveat.

---

## 1. Test set — 29 real printings, ground truth from `card_fingerprints`

`card_fingerprints` (20,429 rows) stores `imageUrl` + known `setCode` + `collectorNumber` for
every Pokémon printing. These are **real printed cards with real ground truth**, not synthetic
data. The sample was drawn to span the hardest axis — print era — plus rarity extremes:

- **21 "typical" cards**, one per era from **WOTC Base (1999)** through **Surging Sparks (2024)**
  — base1, gym1, neo1, ecard1, ex1, ex7, dp1, pl1, hgss1, bw1, bw7, xy1, xy5, sm1, sm12, swsh1,
  swsh8, sv1, sv3, sv4pt5, sv8 (all collector number `6`).
- **6 secret / hyper rares** (collector number **above** the set's printed total — full-art,
  textured, holo backgrounds, historically the hardest strip reads): sv1-258, sv3-230, sv8-252,
  swsh8-284, sm12-271, xy5-164.
- **2 alphanumeric collector numbers** (ecard2 `H1`/`H2` — a non-`\d+` format the pipeline sees
  in TG/GG/promo subsets).

Images are the official `*_hires.png` renders (600×825 to 734×1024). **This is their key
weakness as a test set — see §6.** The bottom strip was cropped server-side with `sharp`
(already present): bottom **14 %** band, full width; for classical OCR it was additionally
upscaled 2× + grayscaled + normalized. This is the "rough crop" the prompt calls for, not a
production crop utility.

> **Finding surfaced immediately by looking at the crops:** on pre-Scarlet&Violet cards the
> **set code is not printed at all** — only a collector number `X/Y` and a set *symbol*
> (see base1 below: `6/102 ★`, no letters). The ground-truth `setCode` column holds the PTCGO
> code / set.id (`BS`, `HS`, `sv1`), which is frequently **not the text on the card**
> (`hgss1`'s card prints `HGSS`, truth is `HS`; `bw1` prints `BW`, truth is `BLW`; `sv1` prints
> a `SVI` box, truth is `sv1`). **Collector number is therefore the only field with a fair,
> printed ground truth.** Set-code accuracy is reported but is partly measuring an impossible /
> mismatched task, not model skill.

---

## 2. Candidates tested

| # | Candidate | What it is | How it was run |
| --- | --- | --- | --- |
| 1 | **Tesseract.js 7.0** | Mature classical OCR, WASM, runs in Node. | `createWorker('eng')` on the processed strip crop; collector number pulled from the free text with a `\d+/\d+` regex. |
| 2 | **`Xenova/trocr-small-printed`** | Transformers.js/ONNX port of Microsoft **TrOCR** (VisionEncoderDecoder, printed variant). The specific, concrete Transformers.js-compatible OCR model — same runtime as MobileCLIP-S2 in M1/M2 (`@huggingface/transformers` v4.2.0 → `onnxruntime-node`). | `pipeline("image-to-text", …)` on the raw strip crop, **and** on tight single-line crops of just the number (a fair second chance — see §4). |
| 3 | **GPT-4o-mini** (baseline) | The **existing** `extractBottomStrip` call, replicated byte-for-byte (same system prompt, `detail:"high"`, `temperature:0`, `max_tokens:80`), run on the same 29 whole-card images. | `OPENAI_API_KEY` from `.env`; one-time cost ≈ **$0.07** total. |

**On the Transformers.js model choice (naming a specific model, per the M1 standard).**
TrOCR is the only mature, general printed-text recognizer with a maintained Transformers.js/ONNX
port on the Hub. It is a **recognition-only, single-line** model — it assumes its input is one
already-cropped text line, and has **no text *detection* stage**. That architectural fact, not a
tuning miss, is why it fails here (§4). The natural "full OCR" alternative — a detection +
recognition stack like PaddleOCR — has **no clean Transformers.js port**; it would mean a Python
sidecar or a hand-assembled DBNet+CRTC ONNX pipeline, which is far outside an investigation and
outside this repo's proven Node/ONNX runtime. So TrOCR-small-printed is the honest, in-runtime
representative of "the Transformers.js OCR path," and it is the one measured.

---

## 3. Results — collector number (the field with fair ground truth)

Scoring (see harness `score.js`): **exact** = numerator matches after stripping leading zeros and
the `/total` suffix (`006/198` → `6` ✓); **near** = one-character edit away; **miss** = wrong or
empty. n = 29.

| Candidate | Exact | Near | Miss | Avg time / image | Marginal cost / image | On-disk footprint |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| **GPT-4o-mini** (current baseline) | **18 (62 %)** | 0 | 11 (38 %) | 1,688 ms | ~$0.0025 | 0 (API) |
| **Tesseract.js** | **17 (59 %)** | 3 (10 %) | 9 (31 %) | **227 ms** | **$0** | ~50 MB (44 MB WASM core + 5 MB `eng`) |
| **`trocr-small-printed`** | 0 (0 %) | 0 | 29 (100 %) | 103 ms | $0 | **240 MB** ONNX (84 MB enc + 152 MB dec) |

### Set code (reported for completeness; see §1 caveat — partly an impossible task)

| Candidate | Exact | Near | Miss |
| --- | ---: | ---: | ---: |
| GPT-4o-mini | 2 (7 %) | 3 (10 %) | 24 (83 %) |
| Tesseract.js | 0 (0 %) | 0 | 29 (100 %) |
| trocr-small-printed | 0 (0 %) | 0 | 29 (100 %) |

**No candidate reads the set code.** Tesseract returns garbage (random uppercase tokens grabbed
from the copyright/flavor line — `LE`, `GAME`, `XK`). GPT does best but still 7 % exact, and its
"successes" are mostly reading the *printed* code (`HGSS`, `DP`) which only sometimes matches the
stored PTCGO code. **Set code should not be treated as OCR-recoverable from the strip** by any of
these paths; the pipeline's set/CN evidence has to lean on the collector number and the catalog
join, not on reading a set code off the border.

---

## 4. TrOCR failed completely — and *why* is the useful part

TrOCR returned **0/29**. The outputs are not near-misses; they are hallucinated receipt text:
`"TOTAL"`, `"SEE BACK OF RECEIPT FOR AN OFFER"`, `"RECEIPT FOR AN OFFER"`, rows of `*`. That
vocabulary is the tell: `trocr-small-printed` is fine-tuned on the **SROIE printed-receipt**
dataset. Fed a multi-element card strip with no line-detection front-end, it free-associates back
to its training distribution.

To be fair to it, it was given a **second, easier chance**: tight single-line crops of *only* the
collector number (clean `006 / 198`, `284/264` — verified legible by eye). It still returned
`"TOTAL SALES"`, `"RECEIPT FOR AN OFFER"`, `"ITEM"`, `"9.20"` — **0/6**. So the failure is **not**
the multi-line framing; the stylized *italic* card fonts and set glyphs are simply too far from
its plain-receipt training domain. **Verdict: reject.** No amount of cropping rescues it, and
`trocr-base-printed` (≈4× larger, same training domain) would not fix a domain mismatch this
severe — it would just be a 900 MB way to still read receipts. This is the concrete,
model-specific "neither transformer candidate works" result the prompt asked for.

---

## 5. The real finding: Tesseract and GPT are **complementary**, not competitive

On clean images Tesseract (59 %) and GPT (62 %) are effectively tied on collector number — but
**they succeed on different cards**:

| | Count | Cards |
| --- | ---: | --- |
| Both correct | 13 (45 %) | base1, gym1, neo1, ex7, bw1, bw7, xy1, xy5, sm12, swsh1, swsh8, sv3, xy5-164 |
| **Tesseract only** | 4 | sv1-6, sv4pt5-6, sv8-6, swsh8-284 *(crisp modern digits — GPT oddly returned empty)* |
| **GPT only** | 5 | ecard1-6, ex1-6, dp1-6, hgss1-6, sv8-252 *(older/fainter print — Tesseract missed)* |
| Neither | 7 | pl1, sm1-6, sv1-258, sv3-230, sm12-271, ecard2-H1, ecard2-H2 |

- **Ensemble ceiling (either reads it): 22/29 = 76 %** — meaningfully above either alone.
- The split is structured, not random: **Tesseract is stronger on modern crisp digits, GPT on
  older/lower-contrast print.** GPT quietly returned an all-empty JSON on four clean modern cards
  (fast ~850 ms responses) — the "read only the strip" prompt makes it *conservative*, which is a
  known, un-fixed-here quirk of the current baseline worth logging on its own.
- **What neither can read:** textured full-art secret rares where the number sits over ornate art
  (`sv1-258`'s `258/198` is perfectly legible to the eye — see below — yet **both** returned
  empty) and alphanumeric `H1`/`H2`. These are the genuinely hard reads, and a second local sensor
  does not touch them.

This complementarity — not a raw accuracy win — is the only real reason to consider local OCR
here, and it points at **corroboration, not replacement** (§7), which is exactly the
`AGENTS.md` stance: *"AI is a sensor, not the judge … multiple pieces of evidence should outweigh
one uncertain prediction."* A free, independent second reading of the collector number that
**agrees** with GPT is a confidence boost; when the two **disagree** or one is empty, that is a
signal to fall back to the fingerprint/catalog evidence rather than trust a lone read.

---

## 6. The domain gap — why the numbers above are an **optimistic ceiling**, and the core risk

**Every image tested is a pristine official render.** Flat, dead-on, evenly lit, 600–1024 px,
no glare, no blur, no perspective, no hand. **Production is the opposite:** the scanner faces
live phone photos — angled, motion-blurred, glare across holo foil, uneven lighting, partial
crops, lower effective resolution. **We cannot test that today: no real user scan photos are
stored anywhere** (confirmed — the pipeline persists identifications, never the raw frames).

This gap does not hit the two paths equally:

- **Tesseract degrades hard off-domain.** Classical OCR is notoriously brittle to perspective,
  glare, and low contrast — precisely the holo/foil/angle conditions of a real card scan. Its
  59 % on clean renders is a **best case that will not survive** a phone photo; there is a real
  chance it collapses toward the secret-rare behavior (empty) on exactly the cards collectors most
  want read.
- **GPT-4o-mini vision is far more robust** to glare/blur/angle by construction. Its 62 % is a
  *lower* estimate of its real-world lead, because the clean-render condition is the one where a
  classical engine can most nearly keep up.

**So the measured near-parity is the most favorable case local OCR will ever see, and it still
does not win.** On real photos the gap almost certainly *widens* in GPT's favor. Any decision to
ship local OCR that rests on these numbers would be resting on the wrong distribution.

<sup>Legible-but-unreadable example: `sv1-258` prints `258 / 198` in clear black-on-gold, yet both
Tesseract and GPT returned empty — a preview of how ornate backgrounds defeat OCR even *before*
the phone-photo domain gap is added.</sup>

---

## 7. Recommendation

**1. Reject `trocr-small-printed` and the single-line-transformer OCR path outright.** 0 %
accuracy, 240 MB, wrong training domain, and no detection front-end. A Transformers.js OCR path
would require a PaddleOCR-class detection+recognition stack that has no clean port to this repo's
runtime. Backed out (cache deleted, `package.json` untouched).

**2. Do NOT replace the GPT-4o-mini strip call with local OCR.** On the *friendliest possible*
inputs, Tesseract only ties GPT on collector number, **fails set code entirely**, and its one
measured advantage (cost/latency) is bought against an accuracy that will degrade on the real
phone-photo distribution we can't yet test. Replacement trades a robust sensor for a brittle one
to save ~$0.0025 and ~1.5 s — a bad trade for a product whose entire thesis is *trust over speed*.

**3. Tesseract is the one candidate worth a *gated* second look — as a corroborating collector-
number sensor, never a replacement.** The 76 % ensemble ceiling and the structured
Tesseract-strong-on-modern / GPT-strong-on-older split are real. A free, local, ~230 ms second
read of the collector number, fed into the **evidence layer** (not the decision) as agree/disagree
corroboration, is architecturally clean and genuinely additive **if** it holds up on real photos.

**4. That "if" is the whole ballgame, and it gates everything.** The corroboration value depends
entirely on Tesseract working on phone photos — the exact thing §6 says we cannot test and have
reason to doubt. **Adopt nothing until a real-photo pilot exists.** Concretely, the honest next
step (M3-B) is *not* to wire Tesseract in — it is to **capture and label ~50 real user scans**
(opt-in, stored deliberately) and re-run this exact harness on them. If Tesseract holds anywhere
near 50 % collector-number accuracy on real photos, wire it as a shadow corroborating sensor
behind a flag (the M2 shadow-matcher pattern). If it collapses — the likely outcome — the
investigation has cheaply closed the door on local OCR and the answer is: **improve the GPT strip
read** (a genuine crop before the call to cut the 16.5 k-token `detail:"high"` cost, and address
the conservative-empty quirk from §5), not add a local engine.

**Bottom line:** local OCR does **not** beat GPT's accuracy today, and the one path that isn't
dead (Tesseract-as-corroboration) is unprovable until real scan photos are stored. The single
most valuable thing this milestone surfaced is not a model — it is that **the whole comparison is
running on the wrong images**, and the prerequisite for any further local-OCR work is a labeled
real-photo set, which does not exist yet.

---

## 8. Comparison table (one-glance)

| | GPT-4o-mini (current) | Tesseract.js | trocr-small-printed |
| --- | --- | --- | --- |
| Collector # exact (clean renders) | **62 %** | 59 % | 0 % |
| Collector # exact+near | 62 % | **69 %** | 0 % |
| Set code exact | 7 % | 0 % | 0 % |
| Latency / image | 1,688 ms | **227 ms** | 103 ms |
| Marginal cost / image | ~$0.0025 (16.5 k prompt tok, `detail:"high"`) | **$0** | $0 |
| Footprint | 0 (API) | ~50 MB WASM+data | 240 MB ONNX |
| Robust to real phone photos? | **Yes (by construction)** | **No (classical, off-domain)** | No |
| Reads stylized/holo/full-art? | Partial | Weak | No |
| Verdict | **Keep as primary** | **Gated pilot only, as corroboration** | **Reject** |

---

## Appendix — reproducibility

Harness committed under [`docs/scanner-v2/m3-harness/`](./m3-harness/): the sample selector, the
sharp crop, each candidate runner, the shared scorer, and the raw per-candidate result JSON.
Nothing there is on the scan path or imported by the app. To re-run:

```bash
# from aura/
npm install tesseract.js --no-save          # test-only; do not commit to package.json
node docs/scanner-v2/m3-harness/build_sample.js     # picks 29 cards from card_fingerprints
node docs/scanner-v2/m3-harness/download_crop.js    # downloads + crops strips (sharp)
node docs/scanner-v2/m3-harness/run_tesseract.js
node docs/scanner-v2/m3-harness/run_trocr.mjs       # downloads Xenova/trocr-small-printed (~240 MB)
node docs/scanner-v2/m3-harness/run_gpt.mjs         # spends ~$0.07 on OPENAI_API_KEY
node docs/scanner-v2/m3-harness/aggregate.js        # prints the tables above
node docs/scanner-v2/m3-harness/ensemble.js         # prints the §5 complementarity split
```

### Sources
- Tesseract.js — <https://github.com/naptha/tesseract.js> (v7.0.0, `eng.traineddata` ~5 MB).
- [`Xenova/trocr-small-printed`](https://huggingface.co/Xenova/trocr-small-printed) · Microsoft
  TrOCR (VisionEncoderDecoder, fine-tuned on the SROIE printed-receipt set) · run via
  [Transformers.js](https://huggingface.co/docs/transformers.js/index) `image-to-text` pipeline.
- Baseline prompt/params: [`src/lib/scanner/extract.ts` `extractBottomStrip()`](../../src/lib/scanner/extract.ts#L161).
- gpt-4o-mini pricing: $0.15 / 1M input, $0.60 / 1M output tokens (measured 478 k prompt tokens
  over 29 images ⇒ ~16.5 k tok/image at `detail:"high"`).
- Ground truth: `card_fingerprints` (20,429 rows) — production Supabase, read-only.
