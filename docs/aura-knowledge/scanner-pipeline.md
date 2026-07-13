# Aura Scanner Pipeline — Architecture Analysis

> Perspective: **Aura Core Engineer**. Read-only analysis; no code was changed.
> Source of truth: the code under `src/lib/scanner/`, `src/app/api/scanner/`, and
> `src/app/(app)/scanner/`, mapped via the graphify knowledge graph.
>
> **Governing rule (from AGENTS.md):** *AI extracts evidence. Deterministic code
> decides.* Every observation below is checked against that boundary.

---

## 1. Architecture Flow

The scanner is a staged evidence pipeline. Responsibilities are cleanly separated
so that no model output is ever the final identification — models are **sensors**,
and deterministic code is the **judge**.

```
                    ┌──────────────────────── CLIENT (browser) ────────────────────────┐
   Camera ──▶ LiveMetrics (≈10Hz) ──▶ evaluateReadiness() ──▶ SmartCaptureMachine
                (raw measurement)        (pure policy)          (when-to-capture FSM)
                                                                     │
                                          captureSharpestFrame() + assessQuality() gate
                                                                     │ (base64 data URI)
                    └───────────────────────────────┬───────────────────────────────────┘
                                                     ▼
                    ┌──────────────────── SERVER: POST /api/scanner/scan ───────────────┐
   Auth + rate limits (burst + daily)                                                   
        │                                                                               
   Step 1  OCR  ── extractCardFields()   (full-card pass)   ┐ parallel, throttled       
           OCR  ── extractBottomStrip()  (set/CN strip)     ┘ vision calls              
        │                                                                               
   Step 1c reconcileSetCn()  ── deterministic sensor fusion → ScanEvidence bundle       
   Step 1b AiLearningRule lookup (best-effort refinement)                               
        │                                                                               
   Step 2  fetchAllPrintings() ── candidate generation from game card DBs               
        │                                                                               
   Step 3  scorer.score() ── HeuristicScorer                                            
                 └─ decideAmongPrintings() ── evidence-narrowing + illustration guard   
                                            + pickArtGroupByVision() (vision sensor)     
        │                                                                               
   Step 4  gateDecision() ── mode-aware confidence/margin/mass floors                   
        │                                                                               
        ├─ accept       → persistPrinting() + ScanHistory (with telemetry)             
        ├─ disambiguate → pending ScanHistory row + candidate grid to client            
        └─ not-found    → best-effort ScanHistory row + 404                             
                    └───────────────────────────────────────────────────────────────────┘
                                                     │
                    User picks from grid ──▶ POST /api/scanner/save-selection
                        (authoritative re-fetch by id; pick = ground-truth label)
```

The pipeline maps 1:1 onto the failure taxonomy in
[failure.ts](../../src/lib/scanner/failure.ts): `parse → ocr → no-card →
candidates → scoring → database`, plus the two verdicts `not-found` and
`rate-limit`. Every stage is wrapped so a failure names *where* it happened.

---

## 2. Files Involved

### Client capture (evidence acquisition)
| File | Role |
|------|------|
| [scanner/page.tsx](../../src/app/(app)/scanner/page.tsx) | Camera loop, capture orchestration, result/queue UI |
| [live-metrics.ts](../../src/lib/scanner/live-metrics.ts) | Raw per-frame measurement (brightness/glare/motion/sharpness) of the guide-box ROI |
| [readiness.ts](../../src/lib/scanner/readiness.ts) | **Pure** readiness policy; single source of truth for "is this frame good enough" (with motion hysteresis) |
| [smart-capture.ts](../../src/lib/scanner/smart-capture.ts) | Synchronous auto-capture FSM (`scanning→candidate→capturing→cooldown`) + aHash duplicate gate |
| [capture.ts](../../src/lib/scanner/capture.ts) | `captureSharpestFrame()`, `assessQuality()` blur gate, ROI cropping |
| [capture-guidance.tsx](../../src/app/(app)/scanner/capture-guidance.tsx) | Guidance chip rendering |

### Server extraction (AI sensors)
| File | Role |
|------|------|
| [extract.ts](../../src/lib/scanner/extract.ts) | `extractCardFields()` (full OCR) + `extractBottomStrip()` (targeted set/CN OCR) — **sensors only** |
| [visual.ts](../../src/lib/scanner/visual.ts) | `pickArtGroupByVision()` — visual sensor; returns an index or "uncertain" |
| [vision-throttle.ts](../../src/lib/scanner/vision-throttle.ts) | Per-instance concurrency + spacing gate over vision calls |

### Server evidence & decision (deterministic judge)
| File | Role |
|------|------|
| [evidence.ts](../../src/lib/scanner/evidence.ts) | `ScanEvidence` model, `FieldReading`, `reconcileSetCn()` sensor fusion, `CandidatePrinting` shape |
| [candidates.ts](../../src/lib/scanner/candidates.ts) | `fetchAllPrintings()` candidate generation per game; `fetchPrintingById()` trust anchor |
| [rank.ts](../../src/lib/scanner/rank.ts) | `decideAmongPrintings()` — evidence-narrowing → illustration guard → vision |
| [decision.ts](../../src/lib/scanner/decision.ts) | Match methods + calibrated confidence, `nameMatchesOcr()`, illustration guard, `gateDecision()` |
| [score.ts](../../src/lib/scanner/score.ts) | `HeuristicScorer` — the single seam between evidence and verdict |

### Persistence, telemetry, orchestration
| File | Role |
|------|------|
| [scan/route.ts](../../src/app/api/scanner/scan/route.ts) | Orchestrates the whole server pipeline; owns none of the decision logic |
| [save-selection/route.ts](../../src/app/api/scanner/save-selection/route.ts) | User-pick save path; authoritative re-fetch by id |
| [telemetry.ts](../../src/lib/scanner/telemetry.ts) | `buildScanTelemetry()` / `withSelection()` — versioned JSON record per attempt |
| [failure.ts](../../src/lib/scanner/failure.ts) | Failure-stage taxonomy + honest per-stage user copy |
| [archive-context.ts](../../src/lib/scanner/archive-context.ts) | Collection context added to a successful result (read-only, failure-safe) |
| [persist-printing.ts](../../src/lib/cards/persist-printing.ts) · [serialize-card.ts](../../src/lib/cards/serialize-card.ts) | Shared Card/CardPrice persistence + response shaping |

---

## 3. Data Movement

**Frame → evidence.** The camera loop measures each frame's ROI (`LiveMetrics`),
`evaluateReadiness()` turns one sample into a guidance state, and
`SmartCaptureMachine` fires a capture only after a stable dwell. `captureSharpestFrame()`
samples N frames, keeps the sharpest, and `assessQuality()` rejects a blurry result
**before** any OCR spend. The surviving frame leaves the client as a base64 JPEG data URI.

**Evidence bundle.** The route runs two OCR passes in parallel (full-card first so the
throttle's pacing gap lands on the non-critical strip pass). Readings are fused
deterministically by `reconcileSetCn()` into **one `ScanEvidence` bundle** — the only
identification input the scorer receives. Each reading carries `{value, confidence,
source}`; confidence is a property of *how* it was read, never a number the model
reports about itself (`SET_CN_CONFIDENCE`: full 0.5, strip 0.75, agreement 0.95).

**Candidates.** `fetchAllPrintings()` returns every printing of the identified card
from the game database, plus an optional `fallbackCard` tagged with the *method* by
which it was found (`set-cn-verified` vs the weak `fallback-guess`).

**Verdict.** `HeuristicScorer.score()` reduces evidence + candidates to a `Decision`
`{action, confidence, method, printing?, candidates?}` and a shape-stable
`{confidence, margin, evidenceMass}` triple. `gateDecision()` applies mode-aware
floors and either accepts, demotes to disambiguation, or reports not-found.

**Persistence & label loop.** Every attempt writes a `ScanHistory` row; the telemetry
JSON (evidence + verdict + timings) lives in the previously-unused `ocrText` column.
On accept, `persistPrinting()` writes the global Card/CardPrice. On disambiguation, a
*pending* row is created and its id echoed to `save-selection`, which **re-fetches the
card by id server-side** (never trusts the request body) and updates the same row —
the user's pick becomes the ground-truth label attached to that scan's evidence.

---

## 4. Current Strengths

1. **The core rule is enforced structurally, not by convention.** OCR
   ([extract.ts](../../src/lib/scanner/extract.ts)) and vision
   ([visual.ts](../../src/lib/scanner/visual.ts)) can only emit `FieldReading`s and
   indices. The verdict is produced exclusively by
   [score.ts](../../src/lib/scanner/score.ts) / [rank.ts](../../src/lib/scanner/rank.ts)
   / [decision.ts](../../src/lib/scanner/decision.ts). A model's "I'm confident" never
   reaches the user directly.

2. **The illustration guard is a genuine guarantee.** `canVisionDisambiguate()` /
   `groupByIllustration()` refuse to ask vision to pick between printings that share an
   `illustrationId` — a coin flip is never dressed up as a match. This is the sharpest
   expression of Aura's "uncertainty over hallucination" principle.

3. **Confidence is calibrated to method, not to the model.** `METHOD_CONFIDENCE`
   ranks *how* a match was made (set-cn-verified 0.97 → fallback-guess 0.40), and the
   auto-scan gate demands more (0.95) than interactive (0.85) because bulk mode has no
   review screen.

4. **Deterministic sensor fusion.** `reconcileSetCn()` weighs two independent OCR
   passes with agreement-boosting — two sensors are unlikely to share a misread. Pure
   and testable.

5. **Trust boundary on the save path.** `save-selection` re-fetches by id; a tampered
   request can at worst save a card that exists. Global Card/CardPrice tables never
   receive request-body data.

6. **Honest failure taxonomy.** Every failure names its stage and never blames the
   image for an infrastructure error — directly serving collector trust.

7. **A designed swap-in seam.** `Scorer` is an interface; `margin`/`evidenceMass`
   already exist on the output so the planned `ProbabilisticScorer` drops in behind the
   same shape with no change to the gate or telemetry.

8. **The label loop is already closing.** Disambiguation picks are written back as
   ground truth onto the originating scan's evidence — the dataset the probabilistic
   scorer needs is accumulating from real scans now.

---

## 5. Current Weaknesses / Risks

Ordered by impact on **identification accuracy and collector trust** first.

### 5.1 Accuracy / trust risks

- **Games without `illustrationId` can bypass the illustration guard.** Pokémon and
  Yu-Gi-Oh! sources don't provide an `illustrationId`, so `groupByIllustration()` puts
  each candidate in *its own* group (`unknown:<externalId>`). Vision can therefore be
  asked to choose between two genuinely near-identical artworks it cannot distinguish,
  and `art-group-vision` (0.86) clears the **interactive** accept threshold (0.85) — a
  confident-looking auto-save with no deterministic corroboration. The guard that
  protects MTG does not protect these games. **This is the highest-value risk to close.**

- **The margin and evidence-mass floors are currently inert.** The heuristic scorer
  emits `margin = 1` for every accept and `evidenceMass ≥ 1` whenever OCR read a name
  (always). So `MARGIN_FLOOR` (0.2) and `MIN_EVIDENCE_MASS` (1) in `gateDecision()`
  never fire today — the gate rests entirely on the single confidence number. Near-tie
  protection only becomes real with the probabilistic scorer. Correct by design, but
  worth stating plainly: **two of three gate dimensions are dormant.**

- **`IdentityEvidence` is largely unused.** `manaCost`, `typeLine`, `powerToughness`,
  and `game` are OCR'd and typed into the evidence model, but only `name` is ever
  placed into the bundle. The physical-attribute fields feed *only* the MTG deep
  fallback search, never scoring or `evidenceMass`. Strong evidence the AGENTS.md
  hierarchy calls out (mana cost, type, P/T) is being discarded at the decision layer.

- **Short card names require an exact normalized match.** `nameMatchesOcr()` only
  applies edit-distance tolerance when `target.length >= 8`. Names under 8 normalized
  chars ("Island", "Sol Ring", many Pokémon) demand an exact match, so a single OCR
  slip can drop a legitimate `set-cn-verified` match down to `fallback-guess`.

- **OCR is non-deterministic.** `temperature: 0.1` (full pass) means the same image can
  yield different readings across scans. Acceptable for a sensor, but it means the
  telemetry dataset carries sensor jitter that calibration must account for.

### 5.2 Reliability / performance risks

- **Throttle and rate-limit state is per-instance, best-effort.** Both
  `vision-throttle.ts` and the burst limiter hold state in module memory on a warm
  Vercel instance. Under fan-out to multiple instances the pacing/limits weaken. Fine
  for the serialized bulk path they target, but not a hard guarantee.

- **Unknown-game path multiplies latency.** When `game` is unknown, `fetchAllPrintings()`
  tries MTG → Pokémon → Yu-Gi-Oh! **sequentially**, each a full round of DB calls. A
  Yu-Gi-Oh! card with no game hint pays two full failed lookups first — real risk of
  approaching the 60s `maxDuration` when stacked with OCR retries.

- **An un-timed serial DB call sits on the critical path.** The `aiLearningRule`
  lookup (Step 1b) is awaited between reconciliation and candidate fetch, is not wrapped
  in `runStage`, and is not captured in `timings`. It's failure-safe (catches to null)
  but invisible to the latency black box and adds a serial hop.

### 5.3 Maintainability / data risks

- **Telemetry rides in `ScanHistory.ocrText`.** Versioned JSON in a repurposed column
  avoids a migration but is acknowledged schema debt; the hot fields (method,
  confidence, margin, mass, stage) aren't queryable as columns yet. A corrupt/omitted
  write silently loses that attempt from the eval dataset.

- **`gpt-4o-mini` hardcoded across three call sites** (both OCR passes + vision). Model
  choice, `max_tokens`, and detail levels are duplicated inline rather than centralized,
  so model migration touches three files.

---

## 6. Future Improvement Areas

Prioritized to advance the AGENTS.md goals — *higher accuracy, transparency,
reliability, trust* — while preserving the sensor/judge boundary.

1. **Close the non-MTG illustration-guard gap (highest priority).** Give Pokémon/YGO a
   real per-artwork identity — perceptual/artwork hashing (already foreshadowed as
   "Phase 7") or a source-provided art id — so vision is never asked to auto-accept
   between arts it can't tell apart. Until then, consider not letting `art-group-vision`
   auto-accept for games lacking `illustrationId`.

2. **Land the `ProbabilisticScorer` behind the existing seam.** The dataset is
   accumulating; log-odds fusion + softmax posterior would make `margin` and
   `evidenceMass` live, activating the two dormant gate dimensions. No gate/telemetry
   reshape required — that's the whole point of the seam.

3. **Feed identity evidence into scoring.** Wire `manaCost`/`typeLine`/`powerToughness`
   into `ScanEvidence` and `countEvidenceMass()` so the AGENTS.md "Strong" evidence tier
   actually contributes to the verdict and to mass — not just to a fallback search.

4. **Promote telemetry to real columns.** The Phase 5 migration the code anticipates:
   method, confidence, margin, evidenceMass, stage, timings as queryable fields so
   accuracy/latency/failure rates are measurable without JSON parsing.

5. **Parallelize (or pre-classify) the unknown-game candidate fetch.** Run the three
   game lookups concurrently, or use the OCR-reported `game` more aggressively, to bound
   worst-case latency well under `maxDuration`.

6. **Tune short-name matching.** Allow bounded edit-distance below 8 chars (e.g. 1 edit
   for 4–7 char names) so OCR noise on short names doesn't demote verified matches.

7. **Centralize the vision-model config.** One module for model id, token budgets, and
   detail levels so migration and calibration are single-touch.

8. **Track the learning-rule lookup.** Move it into `runStage`/`timed` (or make it
   non-blocking) so it's visible in the latency black box.

---

## 7. Boundary Verdict

The pipeline **honors Aura's core rule**. AI is confined to producing `FieldReading`s
and a vision index; the identification verdict is produced only by deterministic code
in `evidence.ts`, `rank.ts`, `decision.ts`, and `score.ts`. The most important open
risk — the illustration-guard gap for Pokémon/Yu-Gi-Oh! — is precisely a place where a
deterministic guarantee is *missing for want of deterministic evidence* (an artwork
identity), not a place where AI was wrongly made the judge. Closing that gap is the
highest-leverage move toward the trust the product is built on.
```
