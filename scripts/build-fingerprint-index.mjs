// ─── Scanner V2 · M1-D — Fingerprint Index Builder ──────────────────────────
// Populates card_fingerprints: one visual fingerprint (pHash + MobileCLIP-S2
// embedding) per Pokémon printing, keyed by the Pokémon TCG API card id.
//
// This is the REAL catalog-enumeration + embedding builder (per-set fan-out, the
// design in docs/scanner-v2/M1-investigation.md §1). It is deliberately scoped by
// --set so it can be proven on ONE small set before the full 20,479-card run is
// greenlit as a separate step. Nothing here caps it to one set except the flag —
// pagination is real — but DO NOT point it at all 174 sets until the slice below
// is independently verified against production.
//
// Truth-boundary philosophy (AGENTS.md): a fingerprint that can't be computed for
// one card is a `low-risk unknown`. A failed image download or embed logs and
// continues; the row is simply not written. We never fabricate a fingerprint, and
// one bad card never aborts the set.
//
// Reuse, not duplication:
//   • JSON fetch → fetchProviderJson (src/lib/providers/http.ts) — the shared
//     card-database transport with its classified timeout. Not re-implemented.
//   • pHash → the standard DCT-II perceptual hash computed on top of `sharp`
//     (already present via @huggingface/transformers). No new dependency added
//     — see computePHash below. Matches the Python `imagehash.phash` algorithm
//     (32×32 grayscale → 2-D DCT → top-left 8×8 → median threshold → 64 bits).
//   • embedding → @huggingface/transformers (Transformers.js), onnxruntime-node
//     backend, model loaded ONCE outside the loop.
//
// Writes go through the normal pooled DATABASE_URL (same path the app uses).
// Upsert is ON CONFLICT ("externalId") so re-runs are idempotent.
//
// Usage:
//   node scripts/build-fingerprint-index.mjs                 # default small set (mcd19)
//   node scripts/build-fingerprint-index.mjs --set mcd21     # a specific set id
//   node scripts/build-fingerprint-index.mjs --delay 500     # ms between cards (default 300)
//   node scripts/build-fingerprint-index.mjs --help

import { register } from "node:module";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

register("../test/alias-loader.mjs", import.meta.url);
const require = createRequire(import.meta.url);

// ─── .env → process.env (minimal; no dotenv dep) ─────────────────────────────
// Prisma resolves DATABASE_URL on its own, but POKEMON_TCG_API_KEY is ours to
// load. Parse once, don't clobber anything already set in the real environment.
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const sharp = require("sharp");
const { PrismaClient } = require("@prisma/client");
const { fetchProviderJson } = await import("../src/lib/providers/http.ts");
const { AutoProcessor, CLIPVisionModelWithProjection, RawImage } = await import("@huggingface/transformers");

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/build-fingerprint-index.mjs [--set <setId>] [--delay <ms>]");
  console.log("  Builds card_fingerprints for ONE Pokémon set. Default set: mcd19 (12 cards).");
  process.exit(0);
}

const SET_ID = flag("set") ?? "mcd19"; // small default: McDonald's Collection 2019 (12 cards)
const DELAY_MS = Number(flag("delay") ?? 300);
const MODEL_ID = "Xenova/mobileclip_s2";
const EMBEDDING_MODEL = "mobileclip_s2";
const API_BASE = "https://api.pokemontcg.io/v2/cards";
const IMAGE_TIMEOUT_MS = 15_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The Pokémon API is the slowest database we consult (measured hangs past 8s,
// intermittent 404/504 on urls that later return 200 — see providers/http.ts).
// A single timeout is not a real failure, so retry with backoff before giving up.
async function withRetry(fn, { tries = 4, baseMs = 1000, label = "request" } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= tries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt < tries) {
        const wait = baseMs * attempt;
        console.log(`    …${label} attempt ${attempt} failed (${err?.message ?? err}); retrying in ${wait}ms`);
        await sleep(wait);
      }
    }
  }
  throw lastErr;
}

function pokemonHeaders() {
  // Same shape as src/lib/services/pokemon.ts getHeaders().
  const key = process.env.POKEMON_TCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

// ─── Catalog enumeration (per-set, paginated — real, just scoped by --set) ───
async function fetchSetCards(setId) {
  const headers = pokemonHeaders();
  const pageSize = 250;
  const out = [];
  for (let page = 1; ; page++) {
    const url =
      `${API_BASE}?q=${encodeURIComponent(`set.id:${setId}`)}` +
      `&pageSize=${pageSize}&page=${page}&select=id,name,number,set,images`;
    const json = await withRetry(() => fetchProviderJson(url, { headers }), { label: `list page ${page}` });
    const batch = json?.data ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break; // last page
    await sleep(DELAY_MS); // don't hammer the slowest provider we consult
  }
  return out;
}

async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// ─── pHash: standard DCT-II 64-bit perceptual hash (imagehash.phash algorithm) ─
function dct1d(vec) {
  const N = vec.length;
  const out = new Array(N);
  for (let k = 0; k < N; k++) {
    let s = 0;
    for (let n = 0; n < N; n++) s += vec[n] * Math.cos((Math.PI * (2 * n + 1) * k) / (2 * N));
    out[k] = s;
  }
  return out;
}

async function computePHash(imgBuffer) {
  const SIZE = 32; // resize target; low-freq 8×8 of its DCT becomes the hash
  const { data, info } = await sharp(imgBuffer)
    .resize(SIZE, SIZE, { fit: "fill" })
    .greyscale()
    .raw()
    .toBuffer({ resolveWithObject: true });

  // Reduce to a SIZE×SIZE luminance matrix regardless of channel count.
  const ch = info.channels || 1;
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    const row = new Array(SIZE);
    for (let x = 0; x < SIZE; x++) row[x] = data[(y * SIZE + x) * ch];
    rows.push(row);
  }

  // 2-D DCT (separable): DCT each row, then each column.
  const rowDct = rows.map(dct1d);
  const coeffs = [];
  for (let x = 0; x < SIZE; x++) {
    const col = new Array(SIZE);
    for (let y = 0; y < SIZE; y++) col[y] = rowDct[y][x];
    coeffs.push(dct1d(col)); // coeffs[x][y] — column-major, fine for slicing 8×8
  }

  // Top-left 8×8 low-frequency block.
  const low = [];
  for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) low.push(coeffs[x][y]);
  const median = [...low].sort((a, b) => a - b)[Math.floor(low.length / 2)];
  return low.map((v) => (v > median ? "1" : "0")).join(""); // 64-char bit string
}

// ─── Embedding: MobileCLIP-S2, 512-dim, L2-normalized ────────────────────────
async function computeEmbedding(model, processor, imgBuffer) {
  const image = await RawImage.fromBlob(new Blob([imgBuffer]));
  const inputs = await processor(image);
  const { image_embeds } = await model(inputs);
  const raw = Array.from(image_embeds.data); // length 512
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  const unit = raw.map((v) => v / norm);
  return { vector: unit, literal: `[${unit.map((v) => v.toFixed(7)).join(",")}]` };
}

// ─── Upsert (parameterized $executeRaw — never string-concatenated) ──────────
async function upsertFingerprint(prisma, row) {
  return prisma.$executeRaw`
    INSERT INTO card_fingerprints
      ("id", "externalId", "game", "setCode", "collectorNumber", "imageUrl",
       "sourceUpdatedAt", "pHash", "embedding", "embeddingModel", "builtAt", "updatedAt")
    VALUES
      (${row.id}, ${row.externalId}, ${row.game}, ${row.setCode}, ${row.collectorNumber},
       ${row.imageUrl}, ${row.sourceUpdatedAt}, ${row.pHash}::bit(64),
       ${row.embedding}::vector, ${EMBEDDING_MODEL}, ${row.builtAt}, ${row.builtAt})
    ON CONFLICT ("externalId") DO UPDATE SET
      "setCode"         = EXCLUDED."setCode",
      "collectorNumber" = EXCLUDED."collectorNumber",
      "imageUrl"        = EXCLUDED."imageUrl",
      "sourceUpdatedAt" = EXCLUDED."sourceUpdatedAt",
      "pHash"           = EXCLUDED."pHash",
      "embedding"       = EXCLUDED."embedding",
      "embeddingModel"  = EXCLUDED."embeddingModel",
      "builtAt"         = EXCLUDED."builtAt",
      "updatedAt"       = EXCLUDED."updatedAt"
  `;
}

// ─── Main ────────────────────────────────────────────────────────────────────
const t0 = Date.now();
console.log(`Fingerprint index build — set "${SET_ID}", model ${MODEL_ID}`);
console.log("─".repeat(60));

const prisma = new PrismaClient();

let cards = [];
try {
  cards = await fetchSetCards(SET_ID);
} catch (err) {
  console.error(`Fatal: could not list cards for set "${SET_ID}": ${err?.message ?? err}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Fetched ${cards.length} cards from the Pokémon TCG API.`);
if (cards.length === 0) {
  console.error("No cards returned — is the set id correct?");
  await prisma.$disconnect();
  process.exit(1);
}

console.log(`Loading ${MODEL_ID} (first run downloads the model)…`);
const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID);
console.log("Model ready.\n");

const stats = { fetched: cards.length, downloaded: 0, embedded: 0, hashed: 0, upserted: 0, failed: 0 };
const failures = [];

for (const [i, card] of cards.entries()) {
  const label = `[${i + 1}/${cards.length}] ${card.id} ${card.name ?? ""}`.trim();
  const imageUrl = card.images?.large || card.images?.small;
  if (!imageUrl) {
    stats.failed++;
    failures.push({ id: card.id, why: "no image url on card" });
    console.log(`  ✗ ${label} — no image url`);
    continue;
  }

  try {
    const buf = await withRetry(() => downloadImage(imageUrl), { tries: 3, label: "image" });
    stats.downloaded++;

    const pHash = await computePHash(buf);
    stats.hashed++;

    const { literal: embedding } = await computeEmbedding(model, processor, buf);
    stats.embedded++;

    const set = card.set ?? {};
    const parsedUpdated = set.updatedAt ? new Date(set.updatedAt) : null;
    await upsertFingerprint(prisma, {
      id: randomUUID(),
      externalId: card.id,
      game: "POKEMON",
      setCode: set.ptcgoCode || set.id || null, // matches formatPokemonCard()
      collectorNumber: card.number ?? null,
      imageUrl,
      sourceUpdatedAt: parsedUpdated && !Number.isNaN(parsedUpdated.getTime()) ? parsedUpdated : null,
      pHash,
      embedding,
      builtAt: new Date(),
    });
    stats.upserted++;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    // Low-risk unknown: log why, skip the row, keep going. Never fabricate.
    stats.failed++;
    failures.push({ id: card.id, why: err?.message ?? String(err) });
    console.log(`  ✗ ${label} — ${err?.message ?? err}`);
  }

  if (i < cards.length - 1) await sleep(DELAY_MS);
}

await prisma.$disconnect();

const secs = ((Date.now() - t0) / 1000).toFixed(1);
console.log("\n" + "─".repeat(60));
console.log("Summary");
console.log(`  Set                 ${SET_ID}`);
console.log(`  Cards fetched       ${stats.fetched}`);
console.log(`  Images downloaded   ${stats.downloaded}`);
console.log(`  pHashes computed    ${stats.hashed}`);
console.log(`  Embeddings computed ${stats.embedded}`);
console.log(`  Rows upserted       ${stats.upserted}`);
console.log(`  Failures            ${stats.failed}`);
console.log(`  Wall-clock          ${secs}s`);
if (failures.length) {
  console.log("\n  Failures (card → reason):");
  for (const f of failures) console.log(`    ${f.id} → ${f.why}`);
}
