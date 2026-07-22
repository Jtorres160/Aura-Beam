# Scanner V2 · M-CATALOG — M3 Completion Report (full catalog import)

**Status: DONE.** The full Pokémon catalog is imported into `catalog_cards` in
production and independently verified. Scan-path code (candidate generation,
selection re-fetch) was NOT touched — that is M4.

Branch: `feature/scanner-v2-catalog`. Import + verify scripts committed in M2
(`scripts/build-catalog.mjs`, `scripts/verify-catalog.mjs`); this milestone ran
them and verified the result. No code changed in M3 — the deliverable is data.

## Final verified numbers (queried directly against production)

| Check | Result |
|---|---|
| Total rows in `catalog_cards` | **20,479** |
| Target (API `totalCount`) | 20,479 |
| **Gap** | **0** — every listed printing imported |
| `distinct(externalId)` | 20,479 (== row count → no duplicates) |
| Blank name/setName | 0 |
| Null setCode / collectorNumber / imageUrl | 0 / 0 / 0 |
| Null marketPrice | 0 |
| Card-level failures | 0 |

Note vs. the fingerprint index: `card_fingerprints` had a ~50-row shortfall
(images that could not be embedded). The catalog has **no such gap** — catalog
rows need no image download, so a card whose picture won't fetch still has valid
catalog data. 20,479 vs the 20,429 fingerprint rows, as M1 predicted.

## How it got to zero gap: one pass + two sweeps

The live API was failing ~40%+ of requests throughout, so the per-set *list* call
(the run's fragile point) failed for some sets even after 6 retries. The
truth-boundary design handled this exactly as intended — a set that won't list is
logged as a failed set and skipped; the run never aborts — and `--resume` made
recovery free:

| Pass | Command | Result |
|---|---|---|
| 1 — full | `build-catalog.mjs` (all 174 sets) | 174/174 processed, 17,332 upserted, **18 sets failed to list**, 231m |
| 2 — sweep | `--sets-from failed-sets.txt --list-retries 10 --list-backoff 3000` | 17/18 recovered (+2,499), 1 left (`swshp`), 36m |
| 3 — sweep | `--set swshp --resume --list-retries 15 --list-backoff 3000` | `swshp` recovered (+304), 5m |

Every sweep was resume-on / upsert-safe: re-running never duplicated a row (final
`distinct == count` proves it). Card-level failures across all three passes: 0.

## Spot-check coverage across eras (all fields, incl. price)

| Set | Era | Code | Sample | Price (market) |
|---|---|---|---|---|
| base1 | 1999 | BS | Alakazam (Rare Holo) | $71.88 |
| xy0 | 2013 | KSS | Weedle | $1.26 |
| sm4 | 2017 | CIN | Weedle | $0.21 |
| swsh3 | 2020 | DAA | Butterfree V | $1.38 |
| swshp | promos | PR-SW | Grookey (cn SWSH001) | $2.52 |
| sv1 | 2023 | sv1 | Pineco | $0.12 |
| me5 | 2026 | PBL | Tropius | $0 (see below) |

`me5` (Pitch Black) released ~6 days before this run; TCGplayer has not posted
market data yet, so its `marketPrice=0 / low/mid/high=null`. That is the
"price allowed to be null/0" case, not a data error — the M5 cron will fill it as
pricing appears. Every non-price field on those rows is populated.

## Isolation proof (nothing outside the catalog was written)

| Table | Count | Note |
|---|---|---|
| `card_fingerprints` | **20,429** | UNCHANGED from the M2 baseline — untouched |
| `cards` (user) | 125 | user data — untouched |
| `collection_cards` | 48 | user data — untouched |
| `scan_history` | 363 | user data — untouched |
| `catalog_cards` | 20,479 | the only table this milestone wrote |

`build-catalog.mjs` writes exclusively via `prisma.catalogCard.upsert`; the counts
above confirm it empirically.

## M3 acceptance checklist

- [x] Total vs ~20,479 target — **20,479, gap 0**
- [x] `distinct(externalId) == row count` — 20,479 == 20,479
- [x] Spot-checks across multiple eras/sets — Base (1999) → Pitch Black (2026)
- [x] Zero writes/changes to `card_fingerprints` or any user-facing table

## Boundary

M3 is import-only and complete. **Not started:** M4 (repoint candidate generation
+ selection re-fetch behind `CATALOG_LOCAL_ENABLED`, fail-open) — the first
scan-path change, awaiting explicit sign-off.
