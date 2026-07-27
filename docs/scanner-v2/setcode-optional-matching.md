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

Driving the real `resolveByNameNumberTotal()` against the real production
catalog, over every labeled Pokémon scan (n=18):

| Outcome | n |
|---|---|
| Resolved, agrees with label | 6 |
| Resolved, disagrees with label | 3 |
| Declined → existing path | 9 |

**n=18 is a smell test, not a rate.** It is 15 distinct cards from 2 users, with
one card scanned 3×. No hit-rate number should be quoted from it.

What the replay *does* establish is the safety property. Every hallucinated OCR
read declined rather than answering: "Diggersby 021/198", "Toxtricity 046/198",
"Gengar 006/198", "Nosepass 029/198" — none of those cards exist, none produced
a match. **0 ambiguous outcomes.**

The 3 disagreements all share one shape: OCR read a name + number + total that
resolves to exactly one real card, and the label names a different printing.
E.g. label `xy0-35` (Poké Ball, Kalos Starter Set) vs. OCR "Poké Ball 080/088"
which is uniquely `me3-80` (Perfect Order). Two of the three recorded
`printingsCount: 0`, meaning no disambiguation grid was ever shown for that
scan, so whatever produced the label was not a pick among candidates for that
image. These look more like label noise than resolver errors — but the photos
are not recoverable, so this is **not** asserted as fact, and they are counted
as disagreements above.

## Unmeasured

Real-world hit rate at scale. The rate at which OCR reads a clean
name + number + `/total` triple is known only from this n=18 (14/18 carried a
total). That is the number the flag flip should be judged on, from live
telemetry, not from this sample.
