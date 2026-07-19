# Recognition Benchmark — images

This folder holds the card photos referenced by `../manifest.json`. It is the
**regression corpus** for every Scanner V2 recognizer change: a recognizer is
scored by how many of these known cards it identifies, reported **per difficulty
category** (so a gain on easy cards can't hide a loss on holos or promos).

## Why it starts empty

Milestone 0 defines and validates the *structure*; the corpus is populated with
real, rights-cleared photos before any recognizer work (M1+). Committing fabricated
or unlicensed images would poison the very benchmark meant to keep us honest.

## How to add an entry

1. Drop the photo here with a descriptive, kebab-case filename that matches its
   manifest `image` field, e.g. `pokemon-base-charizard-holo.jpg`.
   - A **bare filename** — no subfolders (the loader rejects paths).
   - Prefer a real phone photo over a digital scan: the whole point is to measure
     the scan-vs-photo domain gap the recognizer must cross.
2. Add the matching entry to `../manifest.json`:

   ```json
   {
     "id": "pokemon-base-charizard-holo",
     "image": "pokemon-base-charizard-holo.jpg",
     "game": "POKEMON",
     "expectedName": "Charizard",
     "expectedExternalId": "base1-4",
     "expectedPrinting": "Base Set #4",
     "categories": ["holo", "vintage"],
     "notes": "Own photo, good lighting."
   }
   ```

3. `expectedName` (identity) is **required**. `expectedExternalId` (printing) is
   optional — omit it only when the exact printing is genuinely unknowable from the
   photo, so the benchmark never rewards guessing.
4. Declare at least one `categories` value from the fixed list in `../types.ts`
   (`easy`, `alt-art`, `holo`, `reverse-holo`, `foil`, `promo`, `vintage`,
   `sleeved`, `damaged`, `multilang`, `glare`, `angled`).
5. Run the tests — `benchmark/loader.test.ts` validates `manifest.json`, so a
   malformed or duplicate entry fails the suite.

## Sourcing

Use images you own or that are clearly licensed for this use. Record provenance in
the entry's `notes`. Aura's own collected scans (a user's photo + their confirmed
disambiguation pick) are the ideal source — they are real, labeled, and already ours.

> Binary images are intentionally **not** tracked as text; keep this folder small
> and curated. Aim for coverage across every difficulty category rather than volume.
