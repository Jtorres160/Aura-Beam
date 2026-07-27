# Set-code-optional matching

Status: built, flag OFF (`SETCODE_OPTIONAL_MATCH_ENABLED`). Pokémon only, local
catalog path only.

## The problem

Candidate generation's strong path (`set-cn-verified`) requires the OCR'd set
code to be correct. It usually isn't, and it cannot be corrected.

Measured against user-selection ground truth (n=14 labeled Pokémon scans that
carried both a set-code read and a resolvable label), OCR's set code matched the
label's set **3/14**. The earlier investigation established that no correction
table can fix this: real reads map one printed code onto several distinct sets
("SV3" appeared for 4 different sets), so there is no function from what OCR saw
to the set it meant.

The consequence a collector sees: a card whose name and number were read
perfectly still lands on a 20-wide disambiguation grid, because the set code
missed.

## The key that was being thrown away

The collector number and the set's printed total — the "138" and the "132" of a
printed "138/132" — are read by OCR at the same time, and `setPrintedSize` was
already stored on every `catalog_cards` row.

Uniqueness, measured over **all 20,479 Pokémon rows** in production
`catalog_cards`, using the codebase's own `foldName()` and
`collectorNumberKey()`:

| Key | keys → exactly 1 printing |
|---|---|
| collectorNumber + printedTotal (no name) | 67.2% |
| **foldName(name) + collectorNumber + printedTotal** | **99.8%** |
| name + collectorNumber (no printedTotal) | 94.4% |
| setCode + collectorNumber (the current gate) | 100.0% |

41 ambiguous keys exist in the entire catalog; the worst collision is 3
(`pikachu|6|12`). The set code fully disambiguates **all 41** of them when
correct — which is why it is retained as a tiebreaker.

Normalized and exact name folding scored identically (99.8% either way), so
using `foldName()` costs no uniqueness and buys OCR noise tolerance.

## What was built

A tier in `fetchPokemonPrintingsLocal()` between `set-cn-verified` and the
all-printings grid. `resolveByNameNumberTotal()` returns a printing or null.

- **Set code is corroboration, not a gate.** It is consulted in exactly one
  place — breaking a tie among 2+ otherwise-equal candidates. A set code that
  *disagrees* with an otherwise-unique match is ignored rather than allowed to
  veto it. Vetoing on a field that reads correctly 3 times in 14 would
  reintroduce the gate this removes.
- **Truth boundary.** Null on: no printed total read, no row at that
  number/total, no row whose folded name agrees, or 2+ rows still standing after
  the tiebreak. Every null continues to the existing path. The tier can decline;
  it cannot guess.
- **Confidence 0.9**, below `set-cn-verified` (0.97) and below
  `ACCEPT_THRESHOLD_AUTOSCAN` (0.95). As a *discriminator* the two keys are
  near-equals; what differs is that this key's *sensor* has no at-scale accuracy
  measurement. So it auto-accepts interactively (review screen still present) and
  stays out of bulk auto-save.

No schema change. The planner serves the new query from the existing
`[game, setCode, collectorNumber]` index by scanning game+collectorNumber and
filtering `setPrintedSize` — measured on production at **6.9ms** execution.

## Replay against labeled production scans

Driving the real `fetchPokemonPrintingsLocal()` — the function the scan route
calls, so tier ORDER is exercised, not just the resolver in isolation — against
the real production catalog, over every labeled Pokémon scan (n=18):

| Outcome | n |
|---|---|
| New tier fired, agrees with label | 6 |
| New tier fired, disagrees with label | 1 |
| Did not fire → unchanged from today | 11 |

An earlier replay that called `resolveByNameNumberTotal()` in isolation reported
3 disagreements. Two of those never reach this tier in the real path: `xy0-35`
and `ru1-15` are caught by `set-cn-verified` first. Those two disagreements are
**pre-existing behavior on main**, not introduced here — and they resolve at
0.97, higher than this tier would give them. Measuring the resolver alone
overstated this change's blast radius; only the full-path number is meaningful.

**n=18 is a smell test, not a rate.** It is 15 distinct cards from 2 users, with
one card scanned 3×. No hit-rate number should be quoted from it.

What the replay *does* establish is the safety property. Every hallucinated OCR
read declined rather than answering: "Diggersby 021/198", "Toxtricity 046/198",
"Gengar 006/198", "Nosepass 029/198" — none of those cards exist, none produced
a match. **0 ambiguous outcomes.**

### The one real disagreement

Scan `cms2ttgml...`, 2026-07-27. OCR read "Venusaur ex 003/165"; the tier
resolves that uniquely to `sv3pt5-3` (151). The collector picked `sv7-1`
(Stellar Crown) from a 5-card grid — a strong label, an actual pick among
candidates.

This is the honest risk case for the change, and it is worth stating plainly:
today that scan produces a grid and the collector picks correctly; with the flag
on it would auto-accept the wrong printing at 0.9, and only the review screen
stands between that and the collection.

Two details, neither of which excuses it: the scan's own vision stage had
independently chosen `sv3pt5-3` (`bestMatchExternalId`), so the tier agrees with
the other sensor and disagrees with the human; and the decision was already
being demoted to a grid by the margin floor (0.10 < `MARGIN_FLOOR` 0.2). The
collector is ground truth. It counts as a disagreement.

## Rollout

The flag is flipped in Vercel by the repo owner, never by tooling or an agent —
same as `CATALOG_LOCAL_ENABLED`.

Report: `node scripts/setcode-optional-rollout.mjs [--since YYYY-MM-DD]`

### What is measurable today, and what is not

**(a) Fire rate — measurable now, no new fields.** `acceptDecision()` stamps
`method` and `buildScanTelemetry()` persists it, so
`decision.method === "name-cn-total-verified"` identifies every scan this tier
resolved. Baseline to beat, measured 2026-07-27 across 106 Pokémon scans
carrying a decision: **50 (47.2%) currently end at a disambiguation grid.**

**(b) Overturn rate — NOT measurable today.** This is a gap, not an oversight to
be papered over. An auto-accepted scan reaches a review screen offering exactly
two actions: "Add to Collection" (`POST /api/collections/add`, carrying a
`cardId` and **no** `scanId`) and "Scan Next" (a client-side reset). Neither
writes anything back to the scan's telemetry row. A collector who keeps a wrong
match and one who rejects it leave identical traces — none. The rollout script
prints `UNMEASURABLE` rather than `0%`, because reporting an absent measurement
as a good result is exactly the failure the truth boundary exists to prevent.

Closing it needs a separate PR:

1. Thread `scanId` from the review screen into `/api/collections/add`; append
   `confirmation: { externalId, at }` to that scan's telemetry via a
   `withConfirmation()` helper mirroring `withSelection()`.
2. Add a "Not this card" affordance to the review screen for accept decisions,
   recording `rejection: { externalId, at }` and dropping the user into search.

Overturn rate is then `rejections / (confirmations + rejections)` among scans
whose `decision.method` is `name-cn-total-verified`. The rollout script already
reads all three fields and will report the rate the moment they exist.

### Sample-size gates

| Gate | n (judged decisions) | Basis |
|---|---|---|
| Any conclusion at all | **30** | below this, no action either way |
| Safety floor | **60** | rule of three: 0 overturns in 60 ⇒ true rate <5% at 95% |
| Raise gate | **200** | estimates a ~5% rate to roughly ±3pp at 95% |

At ~5 scans/day historically, and with the tier firing on roughly a third of
Pokémon scans in replay, 200 judged decisions is a multi-month window. **That is
not a reason to enable and assume.** It is a reason to separate the two
decisions:

- **Enabling at 0.9 does not need the gate.** 0.9 keeps a human on the review
  screen for every match; the downside of a wrong match is a rejected suggestion,
  not a corrupted collection.
- **Raising confidence does need it,** because ≥0.95 removes the human from bulk
  scans entirely.

If volume is the binding constraint, seed it deliberately (a bulk session over
known cards) rather than waiting — and label what was seeded, so it is never
mistaken for organic data.

### Pre-registered decision rules

**Raise 0.9 toward `ACCEPT_THRESHOLD_AUTOSCAN` only when all hold:**
n ≥ 200 judged, observed overturn ≤ 2%, 95% upper bound ≤ 5%, and no overturn
traced to a hallucinated `/total` that matched a real row anyway.

**Pull the flag back to off when any holds:**
- observed overturn ≥ 10% at n ≥ 30 — worse than the grid it replaced;
- **any** scan where the tier returned a match built on a printed total OCR
  fabricated. Replay says this class cannot occur (a fabricated total finds no
  row); a single instance means the safety property is false, and that is an
  immediate off regardless of n;
- p95 candidate latency regresses beyond the ~8ms the query was measured at,
  indicating the planner stopped using the index.

## Unmeasured

Real-world hit rate at scale. How often OCR reads a clean name + number +
`/total` triple is known only from n=18 (14/18 carried a total). That is the
number the flag flip should be judged on, from live telemetry — not this sample.
