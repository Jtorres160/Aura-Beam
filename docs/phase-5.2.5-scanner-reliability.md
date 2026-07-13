# Phase 5.2.5 — Scanner Reliability Deep Dive

Production reliability investigation. No redesign; diagnose first, then fix.
Primary device: iPhone 13 Pro Max, mobile Safari, Vercel deployment.

> **Implementation status (2026-07-13):** Batches 1–4 implemented.
> 1. Dedup hash commits only on successful identification (`settle(now, hash, identified)`), hash computed on the guide-box ROI, `DUP_HAMMING_MAX` 6 → 10, Hamming distance exposed for diag.
> 2. Failure-stage taxonomy (`src/lib/scanner/failure.ts`), every scan error response carries `stage`, failed attempts persist as `ScanHistory.matchMethod = "error:<stage>"`, per-stage timings in telemetry, error UI shows the stage, `scan_response` diag events for manual AND auto scans.
> 3. Live metrics measure the guide-box ROI at the capture gate's 256px analysis dim; readiness `minSharpness` IS capture's `MIN_SHARPNESS`; `maxMotion` rescaled 7.0 → 10.0 for ROI content; auto/bulk skips (quality gate, server failure, duplicate) surface as a self-fading chip.
> 4. Restart Camera re-attaches the fresh stream to the mounted `<video>`; OpenAI calls get 20s timeouts + 1 retry; Scryfall/Pokémon/YGO fetches get 8s `AbortSignal.timeout`; route exports `maxDuration = 60`; Prisma ops retry once on transient connection errors (`dbRetry`).
>
> Batch 5 (100-card device benchmark) remains — see §7 test plan. Threshold values (`DUP_HAMMING_MAX`, `maxMotion`) need validation against `?diag=1` exports.

---

## 1. Current scanner architecture map (as actually implemented)

### Client — capture side

```
getUserMedia (ideal 2560×1440, env camera)            page.tsx acquireCameraStream()
  └─ <video object-fit:cover>  ── onCanPlay → cameraReady
       ├─ LiveMetricsController (~10 Hz, FULL frame @192px)      live-metrics.ts
       │     sharpness (Laplacian) / brightness / glare / motion
       ├─ evaluateReadiness(metrics)  → "Ready to scan" chip     readiness.ts
       │     thresholds: bright 45–232, glare 6%, motion 7.0, sharp ≥12 @192px
       │
       ├─ MANUAL: captureCard()
       │     └─ captureSharpestFrame(5 frames, ROI crop)         capture.ts
       │           best-of-N by Laplacian → assessQuality gate
       │           (bright 32–236, sharp ≥22 @256px, ROI-cropped content)
       │           → JPEG ≤2048px q0.92 → data URL
       │
       └─ AUTO/BULK: SmartCaptureMachine (66 ms ticks)           smart-capture.ts
             scanning → candidate (dwell 500 ms of "ready")
             → dedup gate: 8×8 aHash of FULL video frame,
               Hamming ≤ 6 vs lastHash ⇒ "same card" ⇒ skip + cooldown
             → capturing: captureSharpestFrame(3 frames, ROI)
             → settle(hash) → cooldown 1200 ms → scanning
```

### Server — recognition side (`POST /api/scanner/scan`, route.ts)

```
auth → burst limit (30/min, in-memory) → daily limit (ScanHistory count)
→ req.json()
→ Step 1  extractCardFields()   gpt-4o-mini, detail:auto   (self-caught → 400)
→ Step 1c extractBottomStrip()  gpt-4o-mini, detail:high, parallel (self-caught → {})
→ reconcileSetCn (deterministic)
→ AiLearningRule lookup (Prisma)
→ Step 2  fetchAllPrintings()   Scryfall / Pokémon / YGO   (self-caught → empty)
→ Step 3  HeuristicScorer.score()
            set/CN narrowing → illustration guard → pickArtGroupByVision (self-caught → null)
→ Step 4  gateDecision()  ACCEPT ≥0.85 manual, ≥0.95 auto/bulk
→ accept  → Prisma upsert Card + CardPrice + create ScanHistory + archive context
   disambiguate → create pending ScanHistory, return candidate grid
   not-found    → create ScanHistory, 404
CATCH-ALL: any uncaught throw → 500 "Failed to process card image."   ← the generic error
```

### Method confidence vs the auto/bulk gate

| Method | Confidence | Passes manual gate (0.85) | Passes auto/bulk gate (0.95) |
|---|---|---|---|
| set-cn-verified | 0.97 | ✔ | ✔ |
| single-printing | 0.90 | ✔ | ✘ → disambiguation |
| art-group-vision | 0.86 | ✔ | ✘ → disambiguation |
| single-art-group | 0.85 | ✔ | ✘ → disambiguation |
| fallback-guess | 0.40 | ✘ | ✘ |

**In bulk mode the ONLY path that queues a card without interrupting the session is a
verified set-code + collector-number read.** Everything else halts the loop and shows
the disambiguation grid.

---

## 2. Failure point analysis (stage map)

| Stage | Where | Current visibility |
|---|---|---|
| A. Camera capture failure | `captureSharpestFrame` not-ready | Manual: message. Auto: silent retry |
| B. Preprocessing / quality gate | `assessQuality` (too-dark/bright/blurry) | Manual: message. Auto: **silent**, and poisons dedup (see RC1) |
| C. Vision extraction failure | `extractCardFields` catch | 400 "AI vision error…" |
| D. OCR empty ("no card") | `extraction.fields.name === ""` | 404 message. Auto: **silent** |
| E. Candidate generation failure | `fetchAllPrintings` catch → empty | Masquerades as "not found in any card database" |
| F. Candidate ranking failure | vision compare catch → null | Silently becomes disambiguation |
| G. Decision gate rejection | `gateDecision` demotion | Disambiguation grid (halts bulk) |
| H. External API/data failure | Scryfall/Pokémon/YGO fetch, **no timeouts** | Swallowed → looks like E |
| I. Timeout / network / infra | Prisma throws, req.json, platform timeout | **Generic 500 "Failed to process card image."** |

The only stages that currently produce the observed generic 500 are the **uncaught
throws**: the 5–8 Prisma queries per scan (`scanHistory.count`, `aiLearningRule.findUnique`,
`card.upsert`, `cardPrice.upsert`, `scanHistory.create`), `req.json()`, and `auth()`.
Every OpenAI and card-database call is already self-caught. So "Failed to process card
image" is almost never an image problem — it is a **database/infrastructure problem
mislabeled as an image problem**.

---

## 3. Root-cause hypotheses, ranked by probability

### RC1 — Dedup hash is recorded on FAILED attempts, permanently blocking the card in frame
**Probability: very high. Explains: bulk "ready but never scans", bulk "stops after a few cards".**

`runCapture` in `page.tsx` calls `machine.settle(now, decisionHash)` in its `finally`
block **unconditionally**, and `SmartCaptureMachine.settle()` stores any non-null hash
as `lastHash`. The hash was computed *before* the capture from the live frame.

Consequence: if an attempt fails for ANY reason — quality-gate rejection (stage B),
"no card detected" (D), burst 429, server 500, network error — the current scene's
aHash still becomes `lastHash`. The card is still sitting in frame, so every subsequent
dwell-complete hashes within ≤6 bits of `lastHash` → classified as "same card still
there" → capture skipped → cooldown → repeat forever. The UI shows a green
"Ready to scan" chip and `BULK · 0` indefinitely. That is exactly the screenshot.

The trap arms after a single failed first attempt (e.g. the frame captured while the
card was still being swept into position) and never releases while the card stays put.

### RC2 — Full-frame 8×8 aHash with Hamming ≤ 6 is far too coarse for card-swap detection
**Probability: high. Explains: bulk "scans several cards then stops".**

The hash covers the FULL video frame; the card occupies maybe 25–40% of it (the
playmat/background dominates the other cells, and they never change). Swapping card A
for card B often flips fewer than 7 of 64 bits — especially between two cards of the
same game with dark borders and similar layouts. Result: **a genuinely new card is
silently skipped as a duplicate.** Combined with RC1, one failure or one false-duplicate
ends the session's throughput with zero feedback.

### RC3 — All server-side infrastructure errors collapse into "Failed to process card image."
**Probability: certain (it's the code path), root cause of the misleading single-scan error.**

The route's catch-all maps every uncaught throw to the generic 500. Since OpenAI and
card-DB calls self-catch, the throwers are Prisma/DB (serverless connection churn, pool
exhaustion under bulk bursts — no `connection_limit`, plain `PrismaClient`, pooled +
direct URL via Neon-style setup) and body parsing. "Sometimes works, sometimes fails on
the same card" is the signature of transient infra errors, not recognition errors.
Nothing is persisted for these attempts either — the failure stage is unknowable after
the fact.

### RC4 — Readiness and the capture quality gate measure different things at different scales
**Probability: medium-high. Explains: "ready" chip + silent capture rejection loops; manual "too blurry" on sharp cards.**

- Readiness: Laplacian variance ≥ 12 measured at **192px on the FULL frame** —
  a textured playmat background can carry the score.
- Capture gate: variance ≥ 22 at **256px on the ROI crop** — card content only.

A card whose face is mostly flat (Counterspell's large white text box is the canonical
case) has intrinsically low Laplacian variance even when perfectly focused. So the
chip says "Ready", capture fires, `assessQuality` says "too-blurry", auto mode retries
silently (then RC1 dead-ends it), manual mode occasionally tells the user a sharp card
was blurry. The two thresholds were never cross-calibrated (the code comments admit
this).

### RC5 — Bulk gate at 0.95 makes disambiguation the NORMAL outcome, and disambiguation halts bulk
**Probability: certain by design reading. Explains: "bulk works then stops" (visible variant).**

Only `set-cn-verified` (0.97) exceeds the 0.95 auto/bulk gate. Any strip misread, any
Pokémon card without letter set codes, any vision-picked art group → full-screen
disambiguation that stops the camera loop. A bulk run is therefore only as smooth as
the strip OCR is lucky. (Not a bug per se — an intentional safety choice with a UX
cost that reads as "the scanner stopped".)

### RC6 — "Restart Camera" button bricks the live session
**Probability: high (code-certain), lower frequency of occurrence.**

`startCamera()` while `state === "scanning"` stops the old tracks and acquires a new
stream, but the `<video>` element is already mounted, so `videoRefCallback` (a mount-only
callback ref) never re-attaches `srcObject`. The preview freezes, `cameraReady` is set
false, `onCanPlay` never re-fires → smart loop dead, manual shutter disabled. Only
exit-and-reopen recovers. Also relevant on iOS: returning from background can leave
the old track ended with the same frozen-preview signature.

### RC7 — No timeouts anywhere in the server pipeline
**Probability: medium as a failure source, certain as a hazard.**

OpenAI calls (2–3 per scan) and Scryfall/Pokémon/YGO fetches have no AbortSignal and
no per-call timeout; the route exports no `maxDuration`. A hung upstream = a hung scan;
on platform timeout the client's `res.json()` fails and shows the fallback
"Failed to identify card." with zero diagnostic value.

### RC8 — Preview vs captured frame mismatch: mostly RULED OUT, with one caveat
The captured image is *better* than feared: ROI crop (guide box + 18% pad), no
upsampling, ≤2048px JPEG at q0.92, dimensions logged. `computeCaptureRoi` correctly
models `object-fit: cover`. The one real preview/capture divergence is **time**: the
auto path decides on a frame, then samples 3 frames over ~110 ms and may pick a
different (possibly worse) one; and metrics freshness allows a 500 ms-old sample. Minor
contributor, not the headline.

---

## 4. Diagnostic instrumentation plan (black box)

Goal: every attempt answers "which stage failed, with what numbers".

### Server (route.ts + new `src/lib/scanner/failure.ts`)
1. **Stage-tagged execution.** Wrap each stage; on throw, capture
   `failureStage ∈ {auth, rate-limit, parse, ocr-full, ocr-strip, candidates, scoring, gate, persist, archive}`.
   Return it in the error JSON (`{ success:false, stage, message }`) and log one
   structured line per attempt: stage timings (ocrMs, stripMs, candidatesMs, visionMs,
   dbMs), image byte size, decoded dimensions if cheap, decision, confidence, method.
2. **Persist failures too.** Create a ScanHistory row with
   `matchMethod: "error:<stage>"` and the telemetry JSON for every 5xx path (today
   only accept/disambiguate/not-found persist). The Phase 6 dataset needs the failures
   most of all.
3. **Timeouts**: OpenAI calls `timeout: 20_000` (SDK option), card-DB fetches
   `AbortSignal.timeout(8_000)`, route `export const maxDuration = 60`.

### Client (page.tsx + smart-diagnostics.ts — the collector already exists)
4. **Record manual scans in smartDiag too** (today only the auto loop records).
   Log per attempt: mode, capture debug (sourceW/H, roi, encodedW/H), blob KB,
   winning-frame metrics, per-frame sharpness of all sampled frames, server HTTP
   status + `stage` + message, round-trip ms.
5. **Record dedup verdicts** with both hashes and the Hamming distance, so false
   duplicates are visible in exports.
6. **Bulk failure surface**: a transient, non-blocking toast/counter
   ("skipped: too blurry ×3", "server error ×1") so silent loops become visible to
   the tester without halting the loop. Keep it quiet — a count chip, not an alert.
7. The existing `?diag=1` + "Export SmartCapture Diag" button is the field tool;
   extend its event vocabulary rather than building anything new.

---

## 5. Highest-impact fixes, ranked

| # | Fix | Files | Effort | Impact |
|---|---|---|---|---|
| 1 | **Only record dedup hash on a SUCCESSFUL outcome** (card queued/saved/disambiguated). Pass outcome into `settle(now, hash, ok)`; on failure, clear nothing, keep `lastHash` unchanged. | smart-capture.ts, page.tsx | S | Removes the bulk dead-stall (RC1) |
| 2 | **Hash the ROI, not the full frame**, and re-tune `DUP_HAMMING_MAX` against real exports (likely ≥10 on ROI content). | smart-capture.ts, page.tsx | S | Fixes false "same card" (RC2) |
| 3 | **Stage-classified errors** server + client display (`stage` in every error payload; client shows the stage-specific message; persist error rows). | route.ts, extract.ts, new failure.ts, page.tsx | M | Kills the generic 500 blindness (RC3); prerequisite for measuring everything else |
| 4 | **Cross-calibrate readiness vs capture gate**: compute the capture-gate metrics on the decision frame *before* dwell completes (or lower/condition `MIN_SHARPNESS` for ROI content using diag data). Never let "Ready" + "too-blurry" coexist on the same still scene. | readiness.ts, capture.ts, page.tsx | M | Ends silent rejection loops (RC4) |
| 5 | **Fix Restart Camera**: in `startCamera`, if the video element is mounted, re-attach `srcObject` and re-play explicitly. | page.tsx | S | Removes session brick (RC6) |
| 6 | **Timeouts + maxDuration** (server, per §4.3). | extract.ts, visual.ts, services/*, route.ts | S | Converts hangs into classified failures (RC7) |
| 7 | **Prisma hardening**: drop redundant queries per scan (count via cheaper path or cached window), retry-once on known transient error codes, confirm pooled connection string params. | route.ts, prisma.ts, rate-limit.ts | M | Directly reduces the real 500 rate (RC3) |
| 8 | **Bulk disambiguation flow** (design decision, likely Phase 5.3): queue low-confidence hits as "needs review" in the bulk tray instead of halting the loop. Preserves the truth layer — nothing is auto-saved below the gate. | page.tsx, route.ts | L | Bulk mode survives imperfect strips (RC5) |

Explicitly NOT proposed: loosening `ACCEPT_THRESHOLD_AUTOSCAN`, letting vision guess
harder, or any confidence inflation. Fixes 1–7 change plumbing and observability only.

## 6. Files likely requiring changes

- `src/app/(app)/scanner/page.tsx` — settle outcome, ROI hash, restart fix, stage display, diag events
- `src/lib/scanner/smart-capture.ts` — settle signature, ROI-hash input, DUP_HAMMING_MAX
- `src/app/api/scanner/scan/route.ts` — stage wrapping, error persistence, maxDuration
- `src/lib/scanner/extract.ts`, `src/lib/scanner/visual.ts` — OpenAI timeouts, stage tags
- `src/lib/services/scryfall.ts`, `pokemon.ts`, `yugioh.ts` — fetch AbortSignal
- `src/lib/scanner/capture.ts` / `readiness.ts` — threshold cross-calibration
- `src/lib/scanner/smart-diagnostics.ts` — new event kinds (manual scans, server stage, dedup distance)
- new `src/lib/scanner/failure.ts` — stage taxonomy + helpers
- `src/lib/prisma.ts` — connection hygiene if diag confirms DB as the 500 source

## 7. Test plan (before shipping any fix)

Run on iPhone 13 Pro Max against a Preview deployment with `?diag=1`.

1. **Baseline capture** (before fixes): same card (Counterspell MH2), same lighting,
   fixed position. 10 single scans, then a 10-card bulk run twice. Export diag JSON
   after each. Every failure must map to a stage; count per stage.
2. **Stall reproduction**: in bulk, present a card, force one failure (cover the lens
   for the first attempt), then hold the card still. Baseline expectation: permanent
   stall (RC1). Post-fix expectation: next dwell captures.
3. **Card-swap dedup**: bulk-scan 10 *different* cards without moving the phone.
   Export shows Hamming distance per swap; count false duplicates pre/post fix 2.
4. **Same-card variance test**: 10 consecutive single scans of one card; diff the diag
   records of a success vs a failure (frame metrics, dimensions, blob size, stage,
   timings) — this directly answers "what changed internally between attempt 1 and 2".
5. **Flat-face card test**: repeat 1 with a low-texture card (big text box, white
   borders) to exercise RC4 thresholds.
6. **Infra failure drill**: point a Preview deployment at a deliberately wrong
   DATABASE_URL; confirm the client shows `stage: persist/rate-limit` — never
   "Failed to process card image".
7. **Restart/background**: tap Restart Camera mid-session; background the app 30 s and
   return. Scanner must resume capturing in both cases.
8. **Regression**: manual scan of a normal card still auto-accepts; bulk of
   strip-legible MTG cards queues without prompts; daily/burst limits unchanged.

## 8. Definition of done — Phase 5.2.5

- [ ] Zero occurrences of the string "Failed to process card image." reachable in code;
      every error response carries a stage and a stage-specific user message.
- [ ] Every scan attempt (success or failure, manual or auto) leaves either a
      ScanHistory row or a client diag event with stage + capture metadata.
- [ ] Bulk mode can no longer silently stall: a failed attempt never suppresses the
      next capture of the same scene; a skipped/failed attempt is visible in the UI.
- [ ] Dedup hash is computed on ROI content and its threshold justified by exported
      real-device data.
- [ ] "Ready to scan" and quality-gate rejection cannot both be true for a still scene
      (verified on the flat-face card).
- [ ] All upstream calls (OpenAI, card DBs) time out and classify; route has
      `maxDuration`.
- [ ] Restart Camera and background/foreground both recover to a working scanner.
- [ ] The same-card 10× protocol yields ≥9/10 classified outcomes (accept or
      disambiguate) with no stage-I failures across two runs; remaining failures have
      actionable stages.
- [ ] Architecture unchanged: sensors produce evidence, deterministic gate decides,
      no confidence values invented.
