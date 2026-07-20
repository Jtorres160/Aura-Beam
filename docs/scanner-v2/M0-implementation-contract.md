# Scanner V2 · Milestone 0 — Implementation Contract

**Branch:** `feature/scanner-v2`
**Status:** measurement-only. No production recognition behavior changes.
**Governing rule (mandatory):** every recognition source — OpenAI, embeddings, pHash,
OCR, Recognition Memory — is an *evidence generator*. None may produce a user-facing
result directly; all must enter through Evidence Layer → Scorer → Decision Gate.
M0 introduces **no new recognition source**, so it cannot violate this rule; it only
*measures* the sources that already exist.

---

## 1. Objective

M0 answers four questions from real production telemetry, and builds the regression
harness every later milestone will be judged against. It changes **no scan-path code**.

1. **Audit Recognition Memory shadow data** — is `RECOGNITION_MEMORY_SERVE` safe to
   enable later? (i.e. are there zero shadow *disagreements*?)
2. **Establish the recognition accuracy baseline** — the outcome distribution and the
   measurable agreement proxies, honestly bounded by what ground truth exists today.
3. **Measure repeat scans & provider-independence gains** — how many scans are of
   already-known cards, and how many provider calls memory could avoid.
4. **Categorize current failure modes** — a truthful taxonomy of how scans end without
   a card.

Plus deliverable #5: **the Recognition Benchmark Dataset** — the formal, versioned
regression suite for all future recognizer work.

---

## 2. Files to be touched

**All new. No existing file is modified.** (The scan path, evidence engine, scorer,
decision gate, providers, and recognition-memory runtime are untouched.)

| File | Kind | Purpose |
| --- | --- | --- |
| `docs/scanner-v2/M0-implementation-contract.md` | doc | this contract |
| `docs/scanner-v2/M0-completion-report.md` | doc | results + serve recommendation |
| `src/lib/scanner/recognition-baseline.ts` | lib | pure analysis functions + types |
| `src/lib/scanner/recognition-baseline.test.ts` | test | unit tests (synthetic records, no DB) |
| `scripts/recognition-baseline.mjs` | script | READ-ONLY DB reader → runs the analysis |
| `src/lib/scanner/benchmark/types.ts` | lib | benchmark entry + manifest types |
| `src/lib/scanner/benchmark/loader.ts` | lib | load + validate the manifest |
| `src/lib/scanner/benchmark/loader.test.ts` | test | validator/loader unit tests |
| `src/lib/scanner/benchmark/manifest.json` | data | the versioned dataset (starts empty) |
| `src/lib/scanner/benchmark/images/README.md` | doc | how to contribute images/entries |

## 3. Schema / database changes

**None.** No Prisma migration, no new table, no column. The baseline reads existing
`ScanHistory` rows; the benchmark dataset lives entirely in the repo as versioned files
(not the database), so it is reviewable, diffable, and travels with the code.

## 4. Telemetry additions

**None emitted at runtime in M0.** The scan route is not touched, so no new field is
written. M0 only *reads and analyzes* the telemetry that already exists.

> **Finding carried to M1 (not implemented here):** the persisted telemetry does **not**
> record `bestMatchExternalId` (vision's art-group pick). Without it, "did vision's pick
> match the user's final disambiguation choice?" — the single cleanest end-to-end accuracy
> proxy — cannot be computed from history. Recording it is a purely additive, behavior-neutral
> telemetry change, proposed for M1. M0 documents the gap rather than silently working around it.

## 5. Feature flags

**None introduced.** M0 changes no production code path, so there is nothing to gate.
The existing `RECOGNITION_MEMORY_SERVE` env flag is **left OFF** — M0 only produces the
evidence for whether it *should* be turned on; per the approved scope, flipping it is a
separate, later decision.

## 6. Rollback plan

Trivial and total. Every M0 artifact is a new file; no production code is modified.

- **Revert:** `git revert <M0 commit>` (or drop the commit) removes every analysis/
  benchmark/doc file. Because no scan-path file changed, there is **zero** runtime
  surface to roll back — the app behaves identically with or without M0.
- **Blast radius if something is wrong:** confined to dev tooling and docs. The scanner,
  providers, and database are untouched. The DB reader script is read-only (`findMany` /
  `count` only) and never imported by the app.

## 7. Test strategy

- **Unit (added):** `recognition-baseline.test.ts` drives the analysis functions with
  hand-built synthetic telemetry records (accepts, disambiguations, memory hits/misses,
  agree/disagree/memory-only, failures) and asserts every tallied metric — no DB, runs in
  the existing `node --test` suite.
- **Unit (added):** `benchmark/loader.test.ts` asserts the manifest validator rejects
  malformed entries (missing identity, unknown difficulty category, duplicate id) and
  accepts well-formed ones.
- **Regression:** the full existing suite (`npm test`) must stay 100% green — M0 must not
  perturb a single existing test, since it touches no existing file.
- **Build & types:** `npm run build` succeeds; `tsc --noEmit` reports zero errors.
- **Live validation:** run `scripts/recognition-baseline.mjs` against production
  `ScanHistory` (read-only) and record the real numbers in the completion report.

## 8. Definition of done (M0)

- [ ] Existing tests 100% green
- [ ] New tests 100% green
- [ ] Production build succeeds
- [ ] TypeScript zero errors
- [ ] Baseline script runs against production and numbers are captured
- [ ] Completion report written (incl. the serve-mode safety verdict)
- [ ] No production recognition behavior changed (verified: no scan-path file modified)
- [ ] Committed as a single revertible M0 commit
