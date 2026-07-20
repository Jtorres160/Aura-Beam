# Scanner V2 · Milestone 1 — Investigation (Index + Probe)

**Branch:** `feature/scanner-v2`
**Status:** Investigation only. **No schema change, no `prisma db push`, no bulk API
calls, no data written.** This is groundwork for a build decision; nothing here is
applied. It touches production Supabase, so every finding below is either read-only or
a paper design.

**What M1 needs before any build starts:** a fingerprint index holding an embedding +
pHash for every Pokémon printing, keyed by `externalId` (the Pokémon TCG API card id).
Two prerequisites did not exist and are settled here — (1) where the catalog comes from,
(2) whether pgvector is usable — plus (3) a draft table and (4) a concrete model.

---

## 1. Catalog source — Pokémon TCG API

Today [`src/lib/services/pokemon.ts`](../../src/lib/services/pokemon.ts) only queries the
API *live and on demand* (`?q=name:"…"` or set/collector-number), capped at
`pageSize=50`. There is no local catalog table, and the `Card` model only holds cards
that have actually been scanned/collected. Building the index requires enumerating the
**entire** catalog, which the current code never does.

### Endpoints

Base: `https://api.pokemontcg.io/v2` — the same host and `X-Api-Key` header the app
already uses (key is configured in `.env`).

| Purpose | Endpoint | Notes |
| --- | --- | --- |
| List all cards | `GET /v2/cards` | No `q` ⇒ returns the full catalog, paginated. Every card carries `id`, `name`, `set`, `number`, `images.{small,large}`. |
| List all sets | `GET /v2/sets` | 174 sets; each has `id`, `ptcgoCode`, `printedTotal`, `total`, `releaseDate`, `updatedAt`. |

Two viable enumeration strategies:

- **Flat paginate `/v2/cards`** — walk `page=1..N` at `pageSize=250`. Simplest.
- **Per-set fan-out** — list `/v2/sets`, then `GET /v2/cards?q=set.id:<id>` per set. More
  requests but naturally chunked, restartable per set, and aligns the index build with a
  natural staleness unit (re-embed only sets whose `updatedAt` moved).

**Recommendation:** per-set fan-out. It makes incremental re-indexing cheap (the roadmap's
"index staleness = low risk" only needs the *changed* sets rebuilt) and each set is a
resumable checkpoint. Use `select=` to trim payloads to just the fields the index needs
(`select=id,name,number,set,images`).

### Pagination

- Query params: `page` (1-indexed), `pageSize` (**max 250**, default 250).
- Response envelope: `{ data: [...], page, pageSize, count, totalCount }`.
  - `count` = items on this page; `totalCount` = total matching the query.
- Standard rate limits apply; the app already routes through `fetchProviderJson` with a
  timeout, and the API key raises the ceiling. A full build should still throttle
  (sequential per-set, small delay) — but that is build-time work, out of scope here.

### Real count (read-only, measured today — a single `pageSize=1` call, no pagination)

```
GET /v2/cards?pageSize=1&select=id   → totalCount: 20,479
GET /v2/sets?pageSize=1              → totalCount: 174
```

> **The index must cover ~20,479 printings across 174 sets.** At `pageSize=250` that is
> ~82 pages for a flat walk, or 174 set-scoped requests for the fan-out. This is the count
> as of 2026-07-19; it grows a few hundred per new set release, which is exactly what the
> staleness/re-embed path is for.

**Scope guard honored:** only the two `totalCount` probes above were issued. No full
pagination, no image downloads.

---

## 2. pgvector availability — Supabase Postgres (production)

Read-only queries against the instance `DATABASE_URL`/`DIRECT_URL` point at
(`db.uflwfxyqfrwkhrubgrgy.supabase.co`). **No `CREATE EXTENSION` was run.**

```sql
SELECT extname, extversion FROM pg_extension WHERE extname = 'vector';
-- → []  (0 rows)

SELECT name, default_version, installed_version
FROM pg_available_extensions WHERE name = 'vector';
-- → [{ name: 'vector', default_version: '0.8.0', installed_version: null }]

SELECT version();
-- → PostgreSQL 17.6 on aarch64-unknown-linux-gnu
```

**Findings:**

- **Not currently enabled** — `pg_extension` has no `vector` row.
- **Available to enable** — Supabase ships pgvector **0.8.0**; it is present in
  `pg_available_extensions`, just not installed. A future, reviewed
  `CREATE EXTENSION vector;` is the only step needed (single statement, run on
  `DIRECT_URL`, not the pooled `pgbouncer` URL).
- **Host is Postgres 17.6** — no version obstacle.
- pgvector 0.8.0 gives us everything the design assumes: `vector` type, **HNSW** indexes
  (since 0.5.0), `halfvec` half-precision storage (0.7.0), and `bit`-type Hamming/Jaccard
  distance with HNSW support (0.7.0) — the last is directly useful for the pHash column
  (see §3).

> **Decision needed at build time (flagged, not taken):** enabling `vector` is a schema-
> level change on production. It's low-risk and additive, but per the standing rule
> (`.env` points at production; use `db push`/`diff` under review) it must go through the
> normal review gate alongside the migration that adds the table.

---

## 3. Draft Prisma model + HNSW index

**This is a draft in this doc only — `prisma/schema.prisma` is NOT touched.**

Prisma 5.15 has no native `vector`/`bit` column type, so those go through
`Unsupported(...)`. That is expected and fine: the columns are written and read via
`$queryRaw`/`$executeRaw` (the query path is raw SQL anyway, since Prisma can't express
`<=>` distance operators). The scalar/identity columns stay first-class Prisma fields.

```prisma
// ─── Card Fingerprint Index (Scanner V2 · M1) ───────────────────────
// One row per printing = the visual fingerprint of a single Pokémon TCG card
// image, keyed by the Pokémon TCG API card id. Populated offline by a batch
// script (not the scan path). Read at scan time as *evidence*, never as the
// final judge — the truth boundary and set/CN OCR still decide (see AGENTS.md,
// "AI is a sensor, not the judge").
//
// Staleness is queryable, not enforced: `builtAt` + `embeddingModel` +
// `sourceUpdatedAt` let a rebuild target only stale/changed rows. A missing or
// stale fingerprint is low-risk — the pipeline degrades to the current live
// path, it never tells a collector a real card doesn't exist.

model CardFingerprint {
  id              String   @id @default(cuid())

  // Identity — the join key back to the live catalog / persisted Card.
  externalId      String   @unique            // Pokémon TCG API card id, e.g. "sv3-125"
  game            String   @default("POKEMON")
  setCode         String?                      // set.ptcgoCode ("SV3") or set.id fallback
  collectorNumber String?                      // card.number

  // Provenance of the pixels this fingerprint was computed from.
  imageUrl        String                       // exact source image (images.large)
  sourceUpdatedAt DateTime?                    // set.updatedAt at build time (change detection)

  // Fingerprints.
  // pHash: 64-bit perceptual hash. Stored as bit(64) so pgvector's
  // hamming_distance() + a bit_hamming HNSW index can serve it as a cheap,
  // lighting/scale-robust coarse pre-filter before the embedding rerank.
  pHash           Unsupported("bit(64)")?
  // embedding: L2-normalized MobileCLIP-S2 image vector (see §4). 512 dims.
  embedding       Unsupported("vector(512)")?

  // Staleness / reproducibility.
  embeddingModel  String   @default("mobileclip_s2")  // which model produced `embedding`
  builtAt         DateTime @default(now())             // when this fingerprint was computed
  updatedAt       DateTime @updatedAt

  @@index([game, setCode, collectorNumber])
  @@map("card_fingerprints")
}
```

**HNSW index (raw SQL — Prisma can't emit it; goes in the migration's manual SQL block,
run once after `CREATE EXTENSION vector`):**

```sql
-- Primary: cosine ANN over the embedding. Embeddings are L2-normalized, so
-- cosine ranks identically to inner product; cosine_ops keeps it explicit.
CREATE INDEX card_fingerprints_embedding_hnsw
  ON card_fingerprints
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Optional coarse pre-filter: Hamming ANN over the 64-bit perceptual hash.
-- Cheap to build; lets a query shortlist by pHash before the embedding rerank.
CREATE INDEX card_fingerprints_phash_hnsw
  ON card_fingerprints
  USING hnsw (pHash bit_hamming_ops)
  WITH (m = 16, ef_construction = 64);
```

Query shape at scan time (illustrative, not built here):

```sql
SELECT external_id, set_code, collector_number,
       embedding <=> $1::vector AS distance
FROM card_fingerprints
WHERE game = 'POKEMON'
ORDER BY embedding <=> $1::vector
LIMIT 20;
```

Notes:
- `m=16, ef_construction=64` are pgvector defaults — fine for 20k rows; tune `ef_search`
  at query time, not now.
- 512-dim `vector` is well under pgvector's 2000-dim HNSW limit. If storage/latency ever
  matters at scale, `halfvec(512)` halves index size with negligible recall loss — a
  later optimization, noted not adopted.
- The two nullable fingerprint columns let the row exist (identity known) before its
  vectors are computed — useful for a resumable, per-set build.

---

## 4. Embedding model — concrete recommendation

**Recommended: Apple MobileCLIP‑S2, image encoder, 512‑dim, run via Transformers.js on the
`onnxruntime-node` backend in a Node batch script.**

| Property | Value |
| --- | --- |
| Model | `Xenova/mobileclip_s2` (Transformers.js/ONNX port of Apple MobileCLIP‑S2) |
| Runtime | `@huggingface/transformers` (Transformers.js v3) → `onnxruntime-node` backend; **no browser, no WASM/WebGPU** for the M1 build |
| Image embedding dim | **512** (L2-normalized) |
| Model size | ~136 MB (vision encoder ONNX) |
| Loader | `CLIPVisionModelWithProjection` + `AutoProcessor` |
| Quality | Beats SigLIP ViT‑B/16 zero-shot while being ~2.3× faster and ~2.1× smaller (Apple MobileCLIP paper) |
| Inference cost | ~10–30 ms/image on CPU, single‑digit ms on GPU. Full 20,479-image build ≈ a few minutes of pure inference; wall-clock dominated by downloading the 20k source images, not the model. |
| License | Apple ML research license (permissible for this internal indexing use — confirm at build time) |

**Why this one (not "a CLIP-class model"):**

1. **Dual-use with the future browser query path.** The roadmap's M5 runs the *query*-side
   embedding in-browser under WASM/WebGPU constraints. The index and the query **must use
   the same model** or their vectors aren't comparable. MobileCLIP was purpose-built to run
   fast on-device, and `Xenova/mobileclip_s2` already ships a Transformers.js build — so
   one model serves both the Node index build now and the browser probe later. A heavier
   server-only model would force a second, matching browser model or a re-index.
2. **Runs from Node today**, no Python service: `@huggingface/transformers` +
   `onnxruntime-node` is a pure-npm path (neither is currently a dependency — adding them
   is a build-time step, out of scope here).
3. **Right task fit.** We need robust *overall-art* similarity that survives the
   render-vs-photograph domain gap (glare, angle, crop). CLIP-family encoders generalize
   well here. It will **not** disambiguate same-art reprints across sets — but that's by
   design: M0 showed 78% of confident accepts come from set/CN, so the embedding is
   evidence for the visual/art-group cases, and set/CN OCR (M3) remains load-bearing.

**Alternative considered:** `onnx-community/siglip2-base-patch16-224` (SigLIP 2, 768‑dim)
— marginally stronger pure retrieval, but larger/slower and a poorer fit for the M5
browser probe. Choose it only if the query path moves fully server-side. If adopted, the
model changes `vector(512)` → `vector(768)` and `embeddingModel` → `"siglip2_base"`; the
`embeddingModel` column exists precisely so a model swap is a re-index, not a schema fight.

---

## Summary & what's decided vs. still open

| # | Finding | State |
| --- | --- | --- |
| 1 | Catalog = Pokémon TCG API; **20,479 printings / 174 sets**; per-set fan-out over `/v2/cards?q=set.id:` at `pageSize=250` | Confirmed, read-only |
| 2 | pgvector **not enabled** but **available (0.8.0)** on **PG 17.6**; one reviewed `CREATE EXTENSION` unblocks it | Confirmed, read-only |
| 3 | `CardFingerprint` model drafted (`vector(512)` + `bit(64)` via `Unsupported`) + HNSW index SQL | Draft only — `schema.prisma` untouched |
| 4 | **MobileCLIP‑S2**, 512‑dim, Transformers.js + `onnxruntime-node`; SigLIP 2 as fallback | Recommended |

**Decisions deferred to review (not taken here):** enabling `vector` on production;
adding `@huggingface/transformers` + `onnxruntime-node` deps; the migration that adds
`card_fingerprints`; the batch-build throttling/robustness. None of these were performed —
this milestone step produced findings and a paper design only.

### Sources
- Pokémon TCG API docs — <https://docs.pokemontcg.io> (live `totalCount` probes measured
  against `https://api.pokemontcg.io/v2`).
- [Xenova/mobileclip_s2](https://huggingface.co/Xenova/mobileclip_s2) · [plhery/mobileclip2-onnx](https://huggingface.co/plhery/mobileclip2-onnx) · [apple/MobileCLIP-S2-OpenCLIP](https://huggingface.co/apple/MobileCLIP-S2-OpenCLIP)
- [Transformers.js](https://huggingface.co/docs/transformers.js/index) · [SigLIP 2](https://huggingface.co/docs/transformers/model_doc/siglip2) · [onnx-community/siglip2-large-patch16-512-ONNX](https://huggingface.co/onnx-community/siglip2-large-patch16-512-ONNX)
- pgvector — HNSW / `halfvec` / `bit` distance support (v0.7.0–0.8.0).
