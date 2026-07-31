# Scanner V2 · M-MTG — Fingerprint Index for Magic: The Gathering (Investigation)

**Branch:** `feature/scanner-v2`
**Status:** Investigation only. **No schema change, no `prisma db push`, no bulk
download, no images fetched, no data written.** This mirrors the discipline of
[`M1-investigation.md`](./M1-investigation.md) (the Pokémon index groundwork): a
build decision on paper, nothing applied. Every finding below is read-only —
lightweight `total_cards` probes against `api.scryfall.com` and doc reads. No
pagination, no image downloads, no bulk-file downloads.

**What this milestone needs before any build starts:** confirm where the MTG
catalog comes from, how many printings must be fingerprinted, that the image URLs
are stable/fetchable, and that the *existing* proven pipeline
([`scripts/build-fingerprint-index.mjs`](../../scripts/build-fingerprint-index.mjs)
+ the `card_fingerprints` table + MobileCLIP-S2) can be reused with only its
*catalog-enumeration front end* swapped. The answer to all four is yes.

---

## 0. What is already proven and reused as-is

The Pokémon milestone (M1) already shipped everything MTG needs except the
catalog source:

| Component | Status | MTG reuse |
| --- | --- | --- |
| `card_fingerprints` table | Live in [`schema.prisma`](../../prisma/schema.prisma) | **No change.** `game` column already exists (`@default("POKEMON")`); MTG rows just set `game = "MTG"`. |
| pgvector `vector(512)` + `bit(64)` + HNSW | Design settled in M1 (§2–3) | **No change.** Same columns, same index, game-agnostic. |
| Embedding model — MobileCLIP-S2 (`Xenova/mobileclip_s2`) via `@huggingface/transformers` + `onnxruntime-node` | Proven in the build script | **No change.** Same 512-dim L2-normalized vectors; MTG and Pokémon share one embedding space, which is exactly what a cross-game index wants. |
| pHash (DCT-II 64-bit on `sharp`) | Proven | **No change.** Runs on any card image. |
| Upsert (`ON CONFLICT ("externalId")`), truth-boundary failure handling, resume | Proven | **No change.** A fingerprint that can't be computed is a low-risk unknown — logged, never fabricated. |

The **only** part that is Pokémon-specific is the catalog enumeration —
`fetchAllSetIds()` / `fetchSetCards()` hitting `api.pokemontcg.io` with per-set
pagination. MTG replaces that front end. Everything downstream (download → pHash →
embed → upsert) is byte-for-byte identical.

---

## 1. Catalog source — Scryfall **bulk data** (not per-set pagination)

MTG's catalog is Scryfall (per `AGENTS.md`), and the app already talks to it via
[`src/lib/services/scryfall.ts`](../../src/lib/services/scryfall.ts) — but only
*live, on demand* (search / named / by-id). There is no full-catalog enumeration,
just as there wasn't for Pokémon.

**Key difference from Pokémon, and it's a simplification:** Scryfall publishes the
**entire database as daily bulk files**, so MTG does **not** need per-set
pagination at all. There is no fan-out over ~1,047 sets and no page-walking. One
gzipped JSONL download contains every printing.

### The bulk-data API (measured live, read-only, today 2026-07-20)

`GET https://api.scryfall.com/bulk-data` returns a list of `bulk_data` objects.
The relevant ones:

| `type` | Name | Contents | Compressed size |
| --- | --- | --- | --- |
| `default_cards` | Default Cards | **Every card object, one per printing**, in English (or the printed language if a card exists in only one language). **This is the right file.** | ~557 MB `.json` / smaller `jsonl.gz` |
| `unique_artwork` | Unique Artwork | One card per **unique artwork** (dedupes reprints that share art). Optimization candidate — see §4. | ~264 MB |
| `all_cards` | All Cards | Every printing in **every language** — 2.5 GB. Overkill; we want one language per printing. | ~2.57 GB |
| `oracle_cards` | Oracle Cards | One card per *Oracle ID* (gameplay identity, not printing). Wrong grain — collapses all printings of a card into one. | ~180 MB |

Each `bulk_data` object carries a `download_uri` (`.json`) and a
`jsonl_download_uri` (`.jsonl.gz`, `content_encoding: gzip`) served from
`data.scryfall.io`. **URLs change their timestamp each day**, so the build must
first `GET /bulk-data/default_cards` and follow the current `download_uri` — never
hardcode a dated URL.

### Structure of the file

A gzipped **JSON Lines** archive (`.jsonl.gz`, *not* a tarball). It streams: read
line by line, decompress on the fly, no need to load 557 MB into memory. Each line
is a full Scryfall card object — the same shape
[`formatScryfallCard()`](../../src/lib/services/scryfall.ts) already parses, so the
field mapping is known and tested:

- `id` → `externalId` (Scryfall UUID; already the app's MTG `externalId`)
- `set` → `setCode`
- `collector_number` → `collectorNumber`
- `image_uris.large` (or `card_faces[0].image_uris.large` for double-faced cards)
  → `imageUrl`
- `digital` (bool) → filter (see §4)

### Real counts (read-only `total_cards` probes — one page each, no pagination)

```
GET /cards/search?q=not:funny unique:prints            → total_cards: 104,324  (all printings, incl. digital)
GET /cards/search?q=game:paper unique:prints           → total_cards:  96,128  (PAPER printings — the scan target)
GET /cards/search?q=game:paper unique:art              → total_cards:  52,365  (unique paper ARTWORKS)
GET /sets                                              → 1,047 sets
```

> **The MTG index covers ~96,128 paper printings** (filter `digital == false` out
> of the ~104k total in `default_cards`). That is **~4.7× the Pokémon index**
> (20,479). Of those, only **~52,365 are visually distinct artworks** — the rest
> are reprints sharing identical art (see §4 for the optimization this enables).

**Scope guard honored:** only the four count/listing probes above plus a couple of
single-card doc-verification reads were issued. No pagination, no bulk-file
download, no image downloads.

---

## 2. Image URLs — stable, fetchable, and the *documented* bulk path

- **Host:** card images live on `cards.scryfall.io`, e.g.
  `https://cards.scryfall.io/large/front/a/e/ae084007-…​.jpg?1783943917`. Verified
  live against a random paper card; `image_uris` exposes
  `small / normal / large / png / art_crop / border_crop`. We use `large` (falling
  back to `normal`/`png`), matching `formatScryfallCard()` and the Pokémon build's
  large→small fallback pattern.
- **The `*.scryfall.io` file origins have _no_ rate limit** (Scryfall's Rate Limits
  page, verbatim): *"The direct file origins located at `*.scryfall.io` do not have
  rate limits."* Both `cards.scryfall.io` (images) and `data.scryfall.io` (bulk
  files) are on this origin. So the ~96k image fetches are **not** rate-limited —
  only politeness/throttling and our own timeout handling apply.
- Scryfall **explicitly directs bulk use here**: *"If you need to rapidly look up
  card names, prices, or resolve a large number of card images, you must use the
  bulk data files."* Resolving 96k images for an index is precisely that case, so
  the bulk approach is the sanctioned one, not a workaround.
- The `?<timestamp>` query suffix on image URLs is a cache-buster tied to the card
  version; the underlying image is stable. Store the exact `imageUrl` used (the
  schema already has an `imageUrl` provenance column).

### Licensing / attribution (documented, must be honored)

Scryfall provides card data + images free under the **Wizards Fan Content
Policy**, for building Magic software / research / community content. Relevant
rules from `/docs/api` (verbatim highlights):

- **User-Agent + Accept headers are required** on `api.scryfall.com` requests, and
  the `User-Agent` "must be accurate to your usage context." The app already sends
  `User-Agent: AuraBeam/1.0` + `Accept: application/json` via
  `SCRYFALL_HEADERS` — reuse it.
- Rate limits on `api.scryfall.com` methods: `/cards/search|named|random|collection`
  = 2/s (500 ms); **all other methods = 10/s (100 ms)**. The single
  `/bulk-data/default_cards` metadata call sits well inside this. HTTP 429 →
  30-second lockout; "It is not acceptable to ignore HTTP 429 responses."
- *"We encourage you to cache the data you download from Scryfall or process it
  locally in your own system, at least for 24 hours."* — a fingerprint index built
  from a daily bulk file is exactly this, well within policy.
- **Image-display guidelines** (for the *product UI*, not the index build, but
  worth recording): don't crop/cover the copyright or artist name; if using
  `art_crop`, show artist + copyright nearby. Our index stores derived vectors +
  pHash, not redistributed images, so the build itself is clean; the display rules
  bind the scanner result UI, which already renders full card images.
- Standard notice: *"Scryfall is not produced by or endorsed by Wizards of the
  Coast … card images … copyright Wizards of the Coast, LLC."*

No licensing blocker for an internal fingerprint index. The one operational
obligation is the correct headers (already in place) and respecting 429s (the
build script's retry/backoff already does).

---

## 3. Schema & dependencies — **no changes required**

- **Schema:** none. `card_fingerprints` already has `game`, `setCode`,
  `collectorNumber`, `imageUrl`, `pHash`, `embedding`, `embeddingModel`. MTG rows
  set `game = "MTG"` and use the Scryfall UUID as `externalId` (globally unique, so
  no collision with Pokémon ids — `externalId @unique` holds across games).
  - One note, not a change: the primary HNSW/ANN query at scan time must filter
    `WHERE game = 'MTG'` (the illustrative query in M1 §3 already does
    `WHERE game = 'POKEMON'`). The existing `@@index([game, setCode, collectorNumber])`
    covers the scalar path; the embedding ANN index is game-agnostic and is
    filtered by the `game` predicate. No new index needed for a first build; if
    per-game ANN recall ever needs tuning, a partial HNSW index per game is a later
    optimization, noted not adopted.
- **Dependencies:** none. `@huggingface/transformers`, `onnxruntime-node`, and
  `sharp` are already used by the build script. The only *new* runtime need is a
  gzip/JSONL **stream reader**, and that is covered by Node's built-in
  `zlib.createGunzip()` + `readline` — no new package.

---

## 4. Concrete build plan — adapt the front end, reuse the engine

**Reuse verdict: reuse the engine, replace only catalog enumeration.** Rather than
fork `build-fingerprint-index.mjs`, add an MTG catalog path behind a `--game`
flag (default `pokemon`) so the two share the identical download→pHash→embed→upsert
core, resume logic, truth-boundary failure handling, and final report.

What changes (front end only):

1. **Enumerate via bulk file, not pagination.** For `--game mtg`:
   `GET /bulk-data/default_cards` → follow `jsonl_download_uri` → stream the
   `.jsonl.gz` with `zlib.createGunzip()` + `readline`. Replaces
   `fetchAllSetIds()` / `fetchSetCards()`. No per-set loop, no `page` walk.
2. **Filter to paper.** Skip lines where `digital === true` (drops Arena/MTGO-only
   printings the scanner will never see), and skip cards with no `image_uris`
   (tokens/placeholders that lack art) — leaving ~96k.
3. **Map fields** (per §1, already proven by `formatScryfallCard`): `id`→`externalId`,
   `set`→`setCode`, `collector_number`→`collectorNumber`,
   `image_uris.large` (or `card_faces[0].image_uris.large`)→`imageUrl`,
   `game: "MTG"`.
4. **Everything else is unchanged:** `downloadImage` (now `cards.scryfall.io`,
   unlimited origin), `computePHash`, `computeEmbedding`, `upsertFingerprint`
   (already game-parameterized via the row's `game` field), per-card try/catch,
   resume-by-existing-externalId, the failure breakdown report.

**Resume unit:** Pokémon resumes per-set; MTG's natural checkpoint is a running
`existingIds` set (the file streams in one pass). Simplest: query already-built
`externalId`s for `game='MTG'` once at start into a `Set` and skip them — safe to
stop/restart. (Streaming ~96k ids is cheap.)

**Estimated scope:**

| Metric | Pokémon (shipped) | MTG (projected) |
| --- | --- | --- |
| Printings to fingerprint | 20,479 | **~96,128** (paper; ~52k if unique-artwork mode) |
| Catalog enumeration | 174 per-set list calls | **1** bulk metadata call + 1 streamed file |
| Image source | `images.pokemontcg.io` | `cards.scryfall.io` (**no rate limit**) |
| Embedding inference | few minutes pure CPU | ~4.7× → still tens of minutes of pure inference |
| Wall-clock bottleneck | downloading 20k images | downloading ~96k images (throttle for politeness, not limits) |

**Optimization to decide at build time (flagged, not taken): unique-artwork mode.**
MobileCLIP embeddings *cannot* disambiguate two printings that share identical art
(same `illustration_id`) — the same limitation M1 §4 documented for Pokémon, and
the reason set/CN OCR stays load-bearing. Since ~44% of the 96k paper printings are
same-art reprints, one could fingerprint the **52,365 unique artworks** and map a
visual hit back to *all* printings that share that `illustration_id`, roughly
halving build cost and index size with **zero recall loss on the visual signal**.
Trade-off: the `externalId @unique` schema assumes one row per printing, so
unique-artwork mode needs either (a) a chosen representative `externalId` per
artwork plus an artwork→printings resolve step at scan time, or (b) storing by
`illustration_id`. This is a real design fork worth its own decision — **recommend
starting with the straightforward per-printing build (~96k, matches the Pokémon
model exactly) and treating unique-artwork as a follow-up optimization** once the
index proves out, keeping the schema and query path identical to Pokémon's for the
first pass.

---

## Summary — what's decided vs. still open

| # | Finding | State |
| --- | --- | --- |
| 1 | Catalog = Scryfall **bulk `default_cards`** (daily gzipped JSONL); **one download, no per-set pagination** | Confirmed, read-only |
| 2 | Scope = **~96,128 paper printings** (~52,365 unique artworks); ~4.7× Pokémon | Confirmed via `total_cards` probes |
| 3 | Images on `cards.scryfall.io` — **no rate limit**; bulk is the *documented* path for mass image resolution; headers already correct | Confirmed |
| 4 | **No schema change** (`game` column exists) and **no dependency change** (pipeline + gzip/JSONL via Node built-ins) | Confirmed |
| 5 | Build = reuse the engine, add a `--game mtg` bulk-stream front end; scan-time ANN query filters `game='MTG'` | Recommended |
| 6 | Unique-artwork mode (~52k) halves cost with no visual-recall loss but forks the schema assumption | Flagged, **not** adopted — start per-printing |

**Decisions deferred to review (not taken here):** the `--game mtg` build path;
per-printing vs. unique-artwork mode; running the ~96k-image build; any scan-time
query/`game` predicate wiring. None performed — this step produced findings and a
paper plan only, matching every prior milestone's discipline.

### Sources
- Scryfall Bulk Data — `https://api.scryfall.com/bulk-data` (live listing measured
  2026-07-20) and `/docs/api/bulk-data`.
- Scryfall Rate Limits — `/docs/api/rate-limits` ("`*.scryfall.io` … do not have
  rate limits"; "you must use the bulk data files"; 429 policy).
- Scryfall API overview + image guidelines — `/docs/api`, `/docs/api/images`
  (User-Agent/Accept requirement, Fan Content Policy, attribution rules).
- Live `total_cards` probes against `https://api.scryfall.com/cards/search`.
- Existing proven code: [`scripts/build-fingerprint-index.mjs`](../../scripts/build-fingerprint-index.mjs),
  [`src/lib/services/scryfall.ts`](../../src/lib/services/scryfall.ts),
  [`prisma/schema.prisma`](../../prisma/schema.prisma) (`CardFingerprint`),
  [`docs/scanner-v2/M1-investigation.md`](./M1-investigation.md).
</content>
</invoke>
