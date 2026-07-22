# Scanner V2 · M-CATALOG — Investigation (M1)

**Goal:** own the Pokémon catalog locally so `api.pokemontcg.io` is no longer on
the scan critical path. Import the full card dataset into our own Postgres table,
repoint candidate generation + selection re-fetch at it, and demote the live API
to a background sync/price-refresh job.

**This document is M1 — investigation only. No code, schema, or data was
changed.** Nothing here is applied; the DDL below is a *preview for M2 review*.
Do not proceed past this milestone without sign-off.

**Scope reminder (from the task):** catalog data only. Do NOT touch
`card_fingerprints`, the fingerprint shadow sensor, or the scan route's
evidence/decision logic.

---

## 0. Headline numbers (measured this session)

| Fact | Value | Source |
|---|---|---|
| Total Pokémon cards in the API | **20,479** | `GET /v2/cards?pageSize=1&select=id` → `totalCount` |
| Total Pokémon sets | **174** | `GET /v2/sets?pageSize=1&select=id` → `totalCount` |
| Rows currently in `card_fingerprints` | 20,429 | memory / schema note |
| Gap (cards − fingerprints) | ~50 | new sets since index build + unfingerprintable images |

The 20,479 / 174 figures are the acceptance targets for M3 ("verify against total
known printing count"). The ~50-card gap is expected and is itself a useful
signal: the catalog import should reach ~20,479, i.e. it must NOT inherit the
fingerprint index's gaps — a card whose *image* failed to embed still has valid
*catalog* data.

---

## 1. Where the API sits on the scan path today

Recognition (which card) and resolution (name/rarity/image/price) are both
chained to the live API. Concretely, three request-path dependencies:

### 1a. Candidate generation (scan path) — `src/lib/scanner/candidates.ts`
`fetchPokemonPrintings()` ([candidates.ts:456](../../src/lib/scanner/candidates.ts#L456))
issues up to three live calls per scan:
- `searchPokemonBySetAndNumber(setCode, collectorNumber)` — the set/CN direct hit
- `fetchAllPokemonPrintings(name)` — all printings of the OCR'd name
- `searchPokemonCards(name)` — fuzzy fallback

Reached from `fetchAllPrintings()` at [candidates.ts:206](../../src/lib/scanner/candidates.ts#L206)
(Pokémon branch) and [candidates.ts:224](../../src/lib/scanner/candidates.ts#L224)
(unknown-game probe). **This is the dependency that made the demo fail.**

### 1b. Selection re-fetch (disambiguation → save) — `fetchPrintingById()`
[candidates.ts:362](../../src/lib/scanner/candidates.ts#L362) → `fetchPokemonCardById(externalId)`.
The authoritative by-id re-fetch when a user picks a card off the grid. Two
callers:
- `src/app/api/scanner/save-selection/route.ts:29` (grid pick → save)
- `src/app/api/collections/add/route.ts:17` (add to collection)

### 1c. Enrichment — `formatPokemonCard()`
[pokemon.ts:164](../../src/lib/services/pokemon.ts#L164). Pure formatter: turns an
API card object into a `CandidatePrinting`. Not a call site itself, but it defines
**the field contract the local catalog must satisfy** (see §2). Everything
persisted (`persistPrinting`) is a copy of its output.

### Also API-dependent, but DELIBERATELY OUT OF SCOPE for this task
These hit the API too; the task scope is the scan path (1a) + selection (1b).
Listed so the repoint boundary is explicit and nothing is missed later:
- **Typeahead search** — `pokemonProvider` in `src/lib/search/providers/registry.ts:55`.
  A separate surface; can be repointed in a follow-up once the catalog is proven.
- **Price cron** — `update-prices/route.ts:91` (`getPokemonCardById`). This one is
  *supposed* to stay live — it's the price refresh. M5 extends it.
- **Watchlist add** — `watchlist/add/route.ts:30`.
- **Card detail** — `cards/[id]/route.ts:31`.

### A local-first precedent already exists
`save-selection` already has `printingFromLocalCache(externalId)`
([save-selection/route.ts:43](../../src/app/api/scanner/save-selection/route.ts#L43)):
when the provider stays dark, it reads the `Card` table and serves that copy. This
is exactly the shape of the M4 repoint — only today it's a *last-resort fallback*
over a table that holds solely already-scanned cards. M4 makes a complete catalog
the *primary* read and keeps the live API as the fallback (inverting the current
priority).

---

## 2. The field contract the catalog must satisfy

`formatPokemonCard()` reads these fields off an API card object. The catalog must
be able to reconstruct all of them, or resolution degrades:

| CandidatePrinting field | API source field(s) | Static or live? |
|---|---|---|
| `externalId` | `card.id` | static |
| `name` | `card.name` | static |
| `setName` | `card.set.name` | static |
| `setCode` | `card.set.ptcgoCode` ‖ `card.set.id` | static |
| `setPrintedSize` | `card.set.printedTotal` | static |
| `collectorNumber` | `card.number` | static |
| `rarity` | `card.rarity` | static |
| `imageUrl` | `card.images.large` ‖ `.small` | static (URL) |
| `thumbnailUrl` | `card.images.small` | static (URL) |
| `price.*` | `card.tcgplayer.prices.*`, `card.cardmarket.prices.*` | **LIVE** |

**Everything except `price` is static.** This is the whole thesis of the task,
now confirmed field-by-field: prices are the one column that must stay fresh; the
rest can be owned outright.

Note `setCode`/`setPrintedSize` come from a nested `set` object, and the
image/thumbnail are *URLs* pointing at `images.pokemontcg.io` (a separate CDN,
not the flaky API host). We store the URLs; we do not need to mirror the images.

---

## 3. Source decision: live-API enumeration vs the bulk-data repo

The task asks to prefer the bulk source *if it truly mirrors the API fields
including rarity/images/legalities*. I checked the actual data.

### The bulk repo (`github.com/PokemonTCG/pokemon-tcg-data`)
- Layout: `cards/en/<setId>.json` (one file per set), `sets/en.json` (set list).
- It *does* mirror the static card fields: verified on `cards/en/base1.json` that
  `rarity`, `images.{small,large}`, `types`, `subtypes`, `supertype`, `artist`,
  `hp`, `nationalPokedexNumbers`, `legalities` are all present.
- **But it lacks two things we need:**
  1. **No prices.** No `tcgplayer` / `cardmarket` object at all. (Expected —
     prices are dynamic and served separately by the API.)
  2. **No nested `set` object on the card.** No `set.ptcgoCode`, no
     `set.printedTotal` on the card record — that data lives in the *separate*
     `sets/en.json` file, keyed by set id, and must be joined in.
- Licensing/cadence: community-maintained, directly backs the v2 API; most recent
  set release observed July 2025 ("Black Bolt + White Flare"), ~60 releases.
  Mirrors the API but updates lag real-time and prices are absent.

### Live-API enumeration (reuse `build-fingerprint-index.mjs`)
The fingerprint builder already enumerates **every set → every card** with a
proven, resumable, retry-wrapped loop (`fetchSetCards`,
[build-fingerprint-index.mjs:161](../../scripts/build-fingerprint-index.mjs#L161)).
It currently requests `select=id,name,number,set,images` (enough to embed) and
throws the rest away. Widening the `select` to
`id,name,number,rarity,set,images,tcgplayer,cardmarket,artist,types,subtypes,supertype`
returns **the complete `formatPokemonCard` shape in one pass — including prices,
`ptcgoCode`, and `printedTotal`** (the `set` object carries those when selected).

### Recommendation: **enumerate via the live API, reusing the builder's machinery.**
Rationale:
- **One source, one shape.** The API returns exactly what `formatPokemonCard`
  already consumes, so the formatter is reused verbatim and there's no
  card↔sets-file join. A pure-bulk approach needs *two* sources (repo + sets file)
  and *still* needs the API for prices — three inputs to fill one table.
- **Reuses proven, resumable, rate-limited enumeration** rather than writing a
  second catalog-walk (a ground-rule for this task).
- **Seeds prices for free** at import time; the M5 cron owns them thereafter.
- **"But the API is flaky!"** — for a *background, resumable, retried* build job
  that is a non-issue. The goal is to move the API *off the scan path*, not to
  never call it. Building/refreshing the catalog from the API is fine precisely
  because a collector is never waiting on it.

Keep the bulk repo as a **secondary asset**, not the primary source: it's a good
offline cross-check for the ~20,479 total and a price-free rebuild option if API
load ever becomes a concern.

---

## 4. Schema decision: new `catalog_cards` table (NOT extend `Card`)

### Why not extend `Card`
`Card` today means "a card materialized into our system" — scanned, selected, or
owned. It carries user-facing relations (`collectionCards`, `scanHistory`,
`watchlist`, `recognitionMemory`, `prices`, `priceHistory`). Loading all 20,479
printings into it would:
- change its semantics (queries/aggregations that assume `Card` = user-relevant),
- risk unrelated features that treat any `Card` row as "known/owned",
- entangle read-only reference data with mutable user data.

### Recommendation: a dedicated `catalog_cards` table
Mirror the `card_fingerprints` pattern exactly: standalone, keyed on
`externalId`, which is **the shared join key across `catalog_cards`,
`card_fingerprints`, and `Card`**. The repoint reads `catalog_cards` → builds a
`CandidatePrinting` via a small `formatCatalogCard()` (sibling to
`formatPokemonCard`) → and `persistPrinting` still writes `Card` on *save*,
unchanged. Catalog stays reference data; `Card` keeps its meaning.

### DRAFT DDL — PREVIEW ONLY, NOT APPLIED (for M2 review)
Follows the M1-B precedent: this repo has no `prisma/migrations`; the reviewable
SQL is applied by hand against **DIRECT_URL** (never the pooler), matching
`prisma migrate diff`. `prices` are seeded here but owned by the M5 cron.

```sql
-- Scanner V2 · M-CATALOG — local Pokémon catalog (schema only, no data)
-- PREVIEW for M2. Apply against DIRECT_URL after review, same discipline as
-- docs/scanner-v2/M1-B-schema.sql. Re-runnable (IF NOT EXISTS).
CREATE TABLE IF NOT EXISTS "catalog_cards" (
    "id"              TEXT NOT NULL,
    "externalId"      TEXT NOT NULL,              -- join key to Card + card_fingerprints
    "game"            TEXT NOT NULL DEFAULT 'POKEMON',
    "name"            TEXT NOT NULL,
    "setName"         TEXT NOT NULL,
    "setCode"         TEXT,                        -- set.ptcgoCode || set.id
    "setPrintedSize"  INTEGER,                     -- set.printedTotal
    "collectorNumber" TEXT,                        -- card.number
    "rarity"          TEXT NOT NULL DEFAULT 'Common',
    "imageUrl"        TEXT,
    "thumbnailUrl"    TEXT,
    -- Seeded at import, refreshed by the M5 cron. Nullable/stale is acceptable;
    -- a missing price NEVER fails a scan (truth boundary).
    "marketPrice"     DOUBLE PRECISION,
    "lowPrice"        DOUBLE PRECISION,
    "midPrice"        DOUBLE PRECISION,
    "highPrice"       DOUBLE PRECISION,
    "priceUpdatedAt"  TIMESTAMP(3),
    -- Provenance / staleness for sync (mirrors card_fingerprints.sourceUpdatedAt).
    "sourceUpdatedAt" TIMESTAMP(3),                -- set.updatedAt at import
    "importedAt"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt"       TIMESTAMP(3) NOT NULL,
    CONSTRAINT "catalog_cards_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "catalog_cards_externalId_key"
    ON "catalog_cards"("externalId");
-- Candidate generation reads by (game, setCode, collectorNumber) and by name.
CREATE INDEX IF NOT EXISTS "catalog_cards_game_setCode_collectorNumber_idx"
    ON "catalog_cards"("game", "setCode", "collectorNumber");
CREATE INDEX IF NOT EXISTS "catalog_cards_game_name_idx"
    ON "catalog_cards"("game", "name");
```

Open question for M2 review: whether to also add a `prisma/schema.prisma` model
for `catalog_cards` (for typed Prisma reads) — `card_fingerprints` is queried via
`$queryRaw` for the vector ops, but a plain catalog table reads cleanly through
the Prisma client, which is preferable for the repoint. Recommend: add the model
AND apply the raw SQL, keeping them in agreement as M1-B documented.

---

## 5. Reusing `build-fingerprint-index.mjs`

Confirmed reusable. The enumeration (`fetchAllSets` → `processSet` →
`fetchSetCards`), `--set`/full-catalog modes, `--resume`, retry, and
truth-boundary per-card failure handling are all directly applicable. Two clean
options for M2/M3:

- **Option A (recommended): a sibling script** `build-catalog.mjs` that reuses the
  same enumeration helpers but, per card, does a `catalog_cards` upsert instead of
  embed-and-write. Keeps the fingerprint builder untouched (a scope ground rule)
  and avoids coupling a slow model load to a data-only import.
- **Option B: a `--catalog` flag** on the existing script. Rejected — it would
  edit the fingerprint builder, brushing the "don't touch card_fingerprints /
  fingerprint tooling" boundary, and forces the model load onto a data-only run.

Either way, the `select` must widen to include `rarity,tcgplayer,cardmarket` (and
`set` already yields `ptcgoCode`/`printedTotal`). Upsert `ON CONFLICT ("externalId")`
for idempotent re-runs, matching the fingerprint builder.

---

## 6. Repoint design (M4) — flag-gated, fail-open

- **Flag:** `CATALOG_LOCAL_ENABLED` (default OFF), mirroring
  `FINGERPRINT_SHADOW_ENABLED`. Off ⇒ today's behavior exactly.
- **Candidate generation:** when ON, `fetchPokemonPrintings` reads `catalog_cards`
  first (set/CN and name queries against the indexes above), maps via
  `formatCatalogCard`, and returns the same `CandidateOutcome`. On a **miss**
  (card not in catalog — e.g. a set released since last sync) or any local error,
  **fall through to the existing live-API path**. A local miss is never a
  "not found": it degrades to the live ask, never fabricates and never drops.
- **Selection re-fetch:** `fetchPrintingById` (POKEMON) reads `catalog_cards` by
  `externalId`; miss ⇒ live `fetchPokemonCardById`. The existing
  `printingFromLocalCache` fallback stays as the final safety net.
- **Prices on the grid:** served from the catalog's seeded/cron-refreshed price
  columns. Stale is fine; the grid never blocks on a live price.
- **Truth-boundary invariant (must hold in tests):** with the flag ON and the
  catalog *empty*, every path must produce byte-identical behavior to flag-OFF —
  i.e. a total catalog miss is indistinguishable from "local disabled". This is
  the M4 acceptance test and the guarantee that the repoint can never regress
  identification.

---

## 7. Price refresh + new-set sync (M5)

- **Prices:** extend the `update-prices` cron pattern
  ([cron/update-prices/route.ts](../../src/app/api/cron/update-prices/route.ts)) to
  refresh `catalog_cards.marketPrice/…/priceUpdatedAt` for the stalest rows,
  bounded per run (`MAX_CARDS_PER_RUN`), CRON_SECRET-guarded, failure-tolerant
  (a failed fetch skips a card; never fails the job). Ownership-based
  prioritization can layer on so owned/watched cards refresh first.
- **New-set sync:** periodically re-run the catalog enumeration (resume ON) to
  pick up newly released sets, using `set.updatedAt` vs stored `sourceUpdatedAt`
  as the change-detection key (same idea as the fingerprint builder).
- **Invariant:** stale prices or a missing new set degrade to the live path for
  those specific cards; they never fail a scan.

---

## 8. Risks & open questions (for M2 sign-off)

1. **Prices are still API-sourced** (just off the scan path). Accepted — that's
   the design. The cron's flakiness tolerance is the mitigation.
2. **Catalog freshness:** a set released between syncs is a catalog miss → live
   fallback. Correct behavior, but means the flag doesn't *eliminate* API calls,
   it removes them from the *common* path. Worth measuring the miss rate in M6.
3. **`setCode` collisions / nulls:** `ptcgoCode` is null for some older sets
   (falls back to `set.id`). Candidate generation already tolerates both spellings
   (`searchPokemonBySetAndNumber` matches ptcgoCode OR id) — the local query must
   replicate that tolerance, or set/CN matches silently drop. Flagged for M4.
4. **Name matching:** the API name query is exact-ish + fuzzy fallback. The local
   `name` index must reproduce the same recall (case-insensitive, the
   `nameMatchesOcr` semantics) or auto-accept rates shift. M4 must diff local vs
   live candidate sets on a sample before the flag flips.
5. **Extend-Card temptation:** if a future reviewer prefers extending `Card`,
   re-read §4 — the relation/semantics entanglement is the reason not to.

---

## 9. Recommended milestone acceptance criteria

- **M2:** `catalog_cards` created via reviewed SQL against DIRECT_URL; import a
  handful of sets (e.g. `sv3`, `base1`); verify row shape + count against the API's
  per-set totals; idempotent re-run adds zero duplicate `externalId`s.
- **M3:** full import reaches ~**20,479** rows across **174** sets (not the 20,429
  fingerprint count — catalog must exceed it); resumable; spot-check prices/rarity
  against live API for a sample.
- **M4:** repoint behind `CATALOG_LOCAL_ENABLED`; the empty-catalog-≡-flag-off
  invariant (§6) holds in tests; candidate-set diff local-vs-live on a sample
  shows parity; `tsc` clean, full suite green, `next build` succeeds.
- **M5:** price + new-set cron live, failure-tolerant, CRON_SECRET-guarded.
- **M6:** flag ON in production; measure scan latency before/after (the payoff:
  candidates.ts Pokémon path drops the API round-trip — telemetry already records
  `candidatesMs` and per-source spans, so this is directly measurable).

---

## 10. Bottom line

- The API sits on the scan path in exactly two places we control here
  (§1a candidate generation, §1b selection re-fetch), plus the shared enrichment
  formatter (§1c) that defines the catalog's field contract.
- **All fields except `price` are static and safe to own** (§2, verified
  field-by-field).
- **Source: enumerate from the live API by reusing the fingerprint builder's
  machinery** (§3) — one shape, reuses proven code, seeds prices. The bulk repo
  is a cross-check, not the primary source (it lacks prices and set-subfields).
- **Schema: a new `catalog_cards` table keyed on `externalId`** (§4), not an
  extension of `Card`.
- **Repoint is flag-gated and fail-open** (§6): a catalog miss always degrades to
  the live path — never a fabricated or dropped card.

No code, schema, or data was changed in M1. Awaiting sign-off before M2.
