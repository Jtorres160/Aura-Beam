// ─── Scanner V2 · M1-D / M1-E — Fingerprint Index Builder ───────────────────
// Populates card_fingerprints: one visual fingerprint (pHash + MobileCLIP-S2
// embedding) per Pokémon printing, keyed by the Pokémon TCG API card id.
//
// This is the REAL catalog-enumeration + embedding builder (per-set fan-out, the
// design in docs/scanner-v2/M1-investigation.md §1). Two modes:
//   • --set <id>   → ONE set (the M1-D proof-run path; resume OFF by default so
//                    a quick manual re-run behaves exactly as it always has).
//   • no --set     → the FULL catalog: enumerate every set via GET /v2/sets (or
//                    --sets-from <file>) and process each in sequence. Resume is
//                    ON by default here (a multi-hour production run must be safe
//                    to stop and restart cheaply). Disable with --no-resume.
//
// Truth-boundary philosophy (AGENTS.md): a fingerprint that can't be computed is
// a `low-risk unknown`. A failed download/embed logs the reason and continues;
// the row is simply not written — never fabricated. One bad card never aborts a
// set, and one bad SET never aborts the catalog: a set whose cards can't be
// listed is logged as a failed set and the run moves on.
//
// Reuse, not duplication:
//   • JSON fetch → fetchProviderJson (src/lib/providers/http.ts), the shared
//     card-database transport with its classified timeout. Not re-implemented.
//   • pHash → standard DCT-II perceptual hash on top of `sharp` (already present
//     via @huggingface/transformers). No new dependency. Matches the Python
//     `imagehash.phash` algorithm (32×32 grey → 2-D DCT → top-left 8×8 → median).
//   • embedding → @huggingface/transformers, onnxruntime-node backend, model
//     loaded ONCE for the whole run.
//
// Writes go through the normal pooled DATABASE_URL. Upsert is
// ON CONFLICT ("externalId") so re-runs are idempotent even with resume off.
//
// Usage:
//   node scripts/build-fingerprint-index.mjs                    # FULL catalog (resume on)
//   node scripts/build-fingerprint-index.mjs --no-resume        # full catalog, rebuild all
//   node scripts/build-fingerprint-index.mjs --sets-from ids.txt # full catalog from a set-id list
//   node scripts/build-fingerprint-index.mjs --set mcd19        # one set (proof run; resume off)
//   node scripts/build-fingerprint-index.mjs --set sv3 --resume # one set, skip already-built
//   node scripts/build-fingerprint-index.mjs --delay 500        # ms between cards (default 300)
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
  console.log("Usage: node scripts/build-fingerprint-index.mjs [--set <id>] [--sets-from <file>] [--resume|--no-resume] [--delay <ms>] [--list-retries <n>] [--list-backoff <ms>]");
  console.log("  No --set → FULL catalog (all sets), resume ON by default.");
  console.log("  --set <id> → one set (proof run), resume OFF by default.");
  console.log("  --list-retries/--list-backoff → patience for the flaky per-set list call (default 6 / 2000ms).");
  process.exit(0);
}

const SINGLE_SET = flag("set"); // defined → single-set mode
const SETS_FROM = flag("sets-from");
const DELAY_MS = Number(flag("delay") ?? 300);
// Resume default depends on mode: OFF for a single-set manual run (preserves the
// M1-D proof behavior byte-for-byte), ON for a full-catalog production run.
const RESUME = SINGLE_SET ? has("resume") : !has("no-resume");

const MODEL_ID = "Xenova/mobileclip_s2";
const EMBEDDING_MODEL = "mobileclip_s2";
const API_CARDS = "https://api.pokemontcg.io/v2/cards";
const API_SETS = "https://api.pokemontcg.io/v2/sets";
const IMAGE_TIMEOUT_MS = 15_000;

// The set-LIST call is the whole run's fragile point: the Pokémon API's per-set
// enumeration times out (or 404s while unwell) in sustained slow spells, and a
// failed list = a whole set skipped. Observed ~25 sets fail this way over one
// full pass. These are more patient than the per-card image retries so a set is
// only abandoned after the API has had real time to recover between attempts.
// Tunable so a resume sweep of the previously-failed sets can push harder.
const LIST_RETRIES = Number(flag("list-retries") ?? 6);
const LIST_BACKOFF_MS = Number(flag("list-backoff") ?? 2000);
const listRetryOpts = (label) => ({ tries: LIST_RETRIES, baseMs: LIST_BACKOFF_MS, label });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nfmt = (n) => n.toLocaleString("en-US");

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

/** Coarse, finite failure category for the end-of-run breakdown. */
function classifyFailure(msg) {
  const s = String(msg);
  if (/no image url/i.test(s)) return "no image url on card";
  if (/8000ms|timeout|aborted|AbortError/i.test(s)) return "timeout";
  const http = s.match(/image HTTP (\d+)/i);
  if (http) return `image HTTP ${http[1]}`;
  if (/vector|bit\(64\)|SQL|prisma|column/i.test(s)) return "db upsert error";
  if (/embed|processor|model|tensor|RawImage/i.test(s)) return "embed error";
  return `other: ${s.slice(0, 60)}`;
}

// ─── Catalog enumeration ─────────────────────────────────────────────────────
async function fetchAllSetIds() {
  if (SETS_FROM) {
    const ids = readFileSync(SETS_FROM, "utf8")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"));
    return ids;
  }
  const headers = pokemonHeaders();
  const url = `${API_SETS}?pageSize=250&select=id,name,total,releaseDate`;
  const json = await withRetry(() => fetchProviderJson(url, { headers }), listRetryOpts("list sets"));
  const sets = json?.data ?? [];
  // Oldest-first is the friendliest order to watch and to resume: newly added
  // sets land at the end, so a re-run reaches fresh cards last.
  sets.sort((a, b) => String(a.releaseDate ?? "").localeCompare(String(b.releaseDate ?? "")));
  return sets.map((s) => s.id);
}

async function fetchSetCards(setId) {
  const headers = pokemonHeaders();
  const pageSize = 250;
  const out = [];
  for (let page = 1; ; page++) {
    const url =
      `${API_CARDS}?q=${encodeURIComponent(`set.id:${setId}`)}` +
      `&pageSize=${pageSize}&page=${page}&select=id,name,number,set,images`;
    const json = await withRetry(() => fetchProviderJson(url, { headers }), listRetryOpts(`${setId} list page ${page}`));
    const batch = json?.data ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break; // last page
    await sleep(DELAY_MS);
  }
  return out;
}

/** externalIds already fingerprinted for this set (externalId = `${set.id}-…`). */
async function existingIdsForSet(prisma, setId) {
  const rows = await prisma.$queryRaw`
    SELECT "externalId" FROM card_fingerprints WHERE "externalId" LIKE ${setId + "-%"}
  `;
  return new Set(rows.map((r) => r.externalId));
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
    coeffs.push(dct1d(col));
  }

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
  return `[${unit.map((v) => v.toFixed(7)).join(",")}]`;
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

// ─── Per-card fingerprint (shared by both modes) ─────────────────────────────
async function fingerprintCard(prisma, model, processor, card) {
  const imageUrl = card.images?.large || card.images?.small;
  if (!imageUrl) throw new Error("no image url on card");

  const buf = await withRetry(() => downloadImage(imageUrl), { tries: 3, label: "image" });
  const pHash = await computePHash(buf);
  const embedding = await computeEmbedding(model, processor, buf);

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
}

/**
 * Process one set. Returns per-set stats. Throws only if the set's card LIST
 * could not be fetched at all (a failed set) — per-card failures are captured
 * and never propagate, honoring the truth boundary.
 */
async function processSet(prisma, model, processor, setId, running) {
  const cards = await fetchSetCards(setId); // may throw → caught by caller as failed set
  const s = { setId, listed: cards.length, upserted: 0, skipped: 0, failed: 0 };

  const skip = RESUME ? await existingIdsForSet(prisma, setId) : new Set();

  for (const [i, card] of cards.entries()) {
    if (skip.has(card.id)) {
      s.skipped++;
      running.skipped++;
      continue;
    }
    try {
      await fingerprintCard(prisma, model, processor, card);
      s.upserted++;
      running.upserted++;
    } catch (err) {
      const why = err?.message ?? String(err);
      s.failed++;
      running.failed++;
      running.failures.push({ id: card.id, reason: classifyFailure(why), detail: why });
    }
    if (i < cards.length - 1) await sleep(DELAY_MS);
  }
  return s;
}

// ─── Driver ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const mode = SINGLE_SET ? `single set "${SINGLE_SET}"` : "FULL catalog";
console.log(`Fingerprint index build — ${mode}, model ${MODEL_ID}, resume=${RESUME ? "on" : "off"}`);
console.log("═".repeat(64));

const prisma = new PrismaClient();

// Resolve the set list first.
let setIds;
try {
  setIds = SINGLE_SET ? [SINGLE_SET] : await fetchAllSetIds();
} catch (err) {
  console.error(`Fatal: could not enumerate sets: ${err?.message ?? err}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Sets to process: ${setIds.length}`);

// A denominator for the running total, so progress reads against the catalog.
// Cheap single count call; falls back to "?" if the API won't answer.
let catalogTotal = "?";
if (!SINGLE_SET) {
  try {
    const c = await withRetry(
      () => fetchProviderJson(`${API_CARDS}?pageSize=1&select=id`, { headers: pokemonHeaders() }),
      { label: "catalog count" },
    );
    if (typeof c?.totalCount === "number") catalogTotal = nfmt(c.totalCount);
  } catch { /* denominator is a nicety, not required */ }
}

console.log(`Loading ${MODEL_ID} (first run downloads the model)…`);
const processor = await AutoProcessor.from_pretrained(MODEL_ID);
const model = await CLIPVisionModelWithProjection.from_pretrained(MODEL_ID);
console.log("Model ready.\n");

if (!SINGLE_SET) {
  console.log(`⚠ This is a FULL-catalog production run over ${setIds.length} sets / ~${catalogTotal} cards.`);
  console.log("  Expect it to take HOURS. Progress prints per set below; resume makes it safe to stop/restart.\n");
}

const running = { upserted: 0, skipped: 0, failed: 0, listed: 0, failures: [] };
const failedSets = [];
const perSet = [];

for (const [idx, setId] of setIds.entries()) {
  const n = `${idx + 1}/${setIds.length}`;
  try {
    const s = await processSet(prisma, model, processor, setId, running);
    running.listed += s.listed;
    perSet.push(s);
    console.log(
      `Set ${n} (${setId}) done — listed ${s.listed}, +${s.upserted} new, ${s.skipped} skipped, ${s.failed} failed` +
        ` — ${nfmt(running.upserted)} new / ${nfmt(running.skipped)} skipped so far` +
        (SINGLE_SET ? "" : ` (catalog ~${catalogTotal})`),
    );
  } catch (err) {
    const why = err?.message ?? String(err);
    failedSets.push({ setId, reason: classifyFailure(why), detail: why });
    console.log(`Set ${n} (${setId}) FAILED to list cards — ${why}. Logged as failed set; continuing.`);
  }
  if (idx < setIds.length - 1) await sleep(DELAY_MS);
}

await prisma.$disconnect();

// ─── Final report ────────────────────────────────────────────────────────────
const secs = Math.round((Date.now() - t0) / 1000);
const hh = Math.floor(secs / 3600), mm = Math.floor((secs % 3600) / 60), ss = secs % 60;

const reasonBreakdown = {};
for (const f of running.failures) reasonBreakdown[f.reason] = (reasonBreakdown[f.reason] ?? 0) + 1;

console.log("\n" + "═".repeat(64));
console.log("FINAL SUMMARY");
console.log(`  Mode                 ${mode}`);
console.log(`  Sets attempted       ${setIds.length}`);
console.log(`  Sets fully failed    ${failedSets.length}`);
console.log(`  Cards listed         ${nfmt(running.listed)}`);
console.log(`  Rows upserted (new)  ${nfmt(running.upserted)}`);
console.log(`  Cards skipped (had)  ${nfmt(running.skipped)}`);
console.log(`  Card failures        ${nfmt(running.failed)}`);
console.log(`  Wall-clock           ${hh}h ${mm}m ${ss}s`);

if (Object.keys(reasonBreakdown).length) {
  console.log("\n  Card-failure breakdown (reason → count):");
  for (const [r, n] of Object.entries(reasonBreakdown).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(5)}  ${r}`);
  }
}
if (failedSets.length) {
  console.log("\n  Failed sets (set → reason):");
  for (const f of failedSets) console.log(`    ${f.setId} → ${f.reason} (${f.detail})`);
}
if (running.failures.length) {
  // A capped sample so the tail of a huge run stays readable; full count is above.
  console.log("\n  Sample failed cards (up to 25):");
  for (const f of running.failures.slice(0, 25)) console.log(`    ${f.id} → ${f.reason}`);
}
