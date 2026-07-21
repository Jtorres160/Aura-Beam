// ─── Scanner V2 · M-CATALOG — Local Catalog Builder ─────────────────────────
// Populates catalog_cards: one row per Pokémon printing, keyed by the Pokémon TCG
// API card id, holding exactly the fields formatPokemonCard() produces — so a
// catalog row maps 1:1 to a CandidatePrinting and the M4 repoint can reconstruct
// an identical result without touching the live API.
//
// SIBLING to build-fingerprint-index.mjs, not an extension of it (disclosed in
// docs/scanner-v2/M-CATALOG-investigation.md §5). Why separate: the fingerprint
// builder executes at top level and unconditionally loads MobileCLIP — useless
// for a data-only import — and it is a proven artifact best left untouched. This
// script shares the parts that MATTER via real imports, not copy-paste:
//   • transport → fetchProviderJson (src/lib/providers/http.ts), same classified
//     timeout + the Phase 5.19 retry. Not re-implemented.
//   • normalization → formatPokemonCard (src/lib/services/pokemon.ts), the SAME
//     formatter the scan path uses. The catalog therefore cannot drift from what
//     candidate generation expects — it stores that function's own output.
//
// Only the thin enumeration (set list + per-set card list, with a WIDENED select
// so prices/rarity/set come back too) is local, mirroring the fingerprint
// builder's shape so the two read alike.
//
// Truth boundary (AGENTS.md): a card that can't be fetched/normalized is logged
// and skipped — never written half-formed, never fabricated. One bad card never
// aborts a set; one bad set never aborts the run.
//
// Writes go through the pooled DATABASE_URL via the typed Prisma client (plain
// columns — no raw SQL, unlike the vector table). Upsert on the unique externalId
// makes re-runs idempotent.
//
// Usage:
//   node scripts/build-catalog.mjs --set mcd19            # one set (scoped run)
//   node scripts/build-catalog.mjs --set base1 --set sv3  # (repeat --set) — see note
//   node scripts/build-catalog.mjs --sets-from ids.txt    # sets listed in a file
//   node scripts/build-catalog.mjs                        # FULL catalog (resume on)
//   node scripts/build-catalog.mjs --no-resume            # full catalog, rewrite all
//   node scripts/build-catalog.mjs --delay 500            # ms between calls (default 300)
//   node scripts/build-catalog.mjs --help

import { register } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);

// ─── .env → process.env (minimal; no dotenv dep) — same as the fp builder ────
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}

const { PrismaClient } = await import("@prisma/client");
const { fetchProviderJson } = await import("../src/lib/providers/http.ts");
const { formatPokemonCard } = await import("../src/lib/services/pokemon.ts");

// ─── CLI ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
// Collect every occurrence of a repeated flag, e.g. --set a --set b.
const flags = (name) =>
  argv.reduce((acc, cur, i) => (cur === `--${name}` && argv[i + 1] ? [...acc, argv[i + 1]] : acc), []);
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/build-catalog.mjs [--set <id> ...] [--sets-from <file>] [--resume|--no-resume] [--delay <ms>] [--list-retries <n>] [--list-backoff <ms>]");
  console.log("  No --set → FULL catalog (all sets), resume ON by default.");
  console.log("  --set <id> (repeatable) → those sets only (scoped run), resume OFF by default.");
  process.exit(0);
}

const SINGLE_SETS = flags("set");            // one or more → scoped mode
const SCOPED = SINGLE_SETS.length > 0;
const SETS_FROM = flag("sets-from");
const DELAY_MS = Number(flag("delay") ?? 300);
// Resume OFF for a manual scoped run (predictable re-run), ON for full catalog.
const RESUME = SCOPED ? has("resume") : !has("no-resume");

const API_CARDS = "https://api.pokemontcg.io/v2/cards";
const API_SETS = "https://api.pokemontcg.io/v2/sets";
// The per-set list call is the flaky point (see fp builder); be patient with it.
const LIST_RETRIES = Number(flag("list-retries") ?? 6);
const LIST_BACKOFF_MS = Number(flag("list-backoff") ?? 2000);
const listRetryOpts = (label) => ({ tries: LIST_RETRIES, baseMs: LIST_BACKOFF_MS, label });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nfmt = (n) => n.toLocaleString("en-US");

function pokemonHeaders() {
  const key = process.env.POKEMON_TCG_API_KEY;
  return key ? { "X-Api-Key": key } : {};
}

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

function classifyFailure(msg) {
  const s = String(msg);
  if (/8000ms|timeout|aborted|AbortError/i.test(s)) return "timeout";
  if (/SQL|prisma|column|constraint/i.test(s)) return "db upsert error";
  if (/format|undefined|cannot read/i.test(s)) return "normalize error";
  return `other: ${s.slice(0, 60)}`;
}

// ─── Enumeration (thin; the WIDENED select is the only real difference from the
//     fingerprint builder's list calls) ────────────────────────────────────────
async function fetchAllSetIds() {
  if (SETS_FROM) {
    return readFileSync(SETS_FROM, "utf8")
      .split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  }
  const url = `${API_SETS}?pageSize=250&select=id,name,releaseDate`;
  const json = await withRetry(() => fetchProviderJson(url, { headers: pokemonHeaders() }), listRetryOpts("list sets"));
  const sets = json?.data ?? [];
  sets.sort((a, b) => String(a.releaseDate ?? "").localeCompare(String(b.releaseDate ?? "")));
  return sets.map((s) => s.id);
}

// select carries everything formatPokemonCard() reads: rarity + set (ptcgoCode,
// id, name, printedTotal, updatedAt) + images + tcgplayer/cardmarket prices. This
// is the one line that makes the row full instead of embed-only.
const CARD_SELECT = "id,name,number,rarity,set,images,tcgplayer,cardmarket";
async function fetchSetCards(setId) {
  const pageSize = 250;
  const out = [];
  for (let page = 1; ; page++) {
    const url =
      `${API_CARDS}?q=${encodeURIComponent(`set.id:${setId}`)}` +
      `&pageSize=${pageSize}&page=${page}&select=${CARD_SELECT}`;
    const json = await withRetry(() => fetchProviderJson(url, { headers: pokemonHeaders() }), listRetryOpts(`${setId} list page ${page}`));
    const batch = json?.data ?? [];
    out.push(...batch);
    if (batch.length < pageSize) break;
    await sleep(DELAY_MS);
  }
  return out;
}

/** externalIds already in the catalog for this set (externalId = `${set.id}-…`). */
async function existingIdsForSet(prisma, setId) {
  const rows = await prisma.catalogCard.findMany({
    where: { externalId: { startsWith: `${setId}-` } },
    select: { externalId: true },
  });
  return new Set(rows.map((r) => r.externalId));
}

// ─── Per-card upsert ─────────────────────────────────────────────────────────
// The catalog stores formatPokemonCard()'s OWN output, so it cannot drift from
// what candidate generation expects. Prices are seeded here (priceUpdatedAt=now)
// and owned by the M5 cron thereafter.
async function upsertCatalogCard(prisma, card) {
  const p = formatPokemonCard(card); // → CandidatePrinting
  const set = card.set ?? {};
  const parsedUpdated = set.updatedAt ? new Date(set.updatedAt) : null;
  const sourceUpdatedAt = parsedUpdated && !Number.isNaN(parsedUpdated.getTime()) ? parsedUpdated : null;

  const data = {
    game: p.game,
    name: p.name,
    setName: p.setName,
    setCode: p.setCode ?? null,
    setPrintedSize: p.setPrintedSize ?? null,
    collectorNumber: p.collectorNumber ?? null,
    rarity: p.rarity,
    imageUrl: p.imageUrl ?? null,
    thumbnailUrl: p.thumbnailUrl ?? null,
    marketPrice: p.price?.marketPrice ?? null,
    lowPrice: p.price?.lowPrice ?? null,
    midPrice: p.price?.midPrice ?? null,
    highPrice: p.price?.highPrice ?? null,
    priceUpdatedAt: new Date(),
    sourceUpdatedAt,
  };

  await prisma.catalogCard.upsert({
    where: { externalId: p.externalId },
    create: { externalId: p.externalId, ...data },
    update: data,
  });
}

async function processSet(prisma, setId, running) {
  const cards = await fetchSetCards(setId); // throws → caught by caller as failed set
  const s = { setId, listed: cards.length, upserted: 0, skipped: 0, failed: 0 };
  const skip = RESUME ? await existingIdsForSet(prisma, setId) : new Set();

  for (const [i, card] of cards.entries()) {
    if (skip.has(card.id)) {
      s.skipped++; running.skipped++; continue;
    }
    try {
      await upsertCatalogCard(prisma, card);
      s.upserted++; running.upserted++;
    } catch (err) {
      const why = err?.message ?? String(err);
      s.failed++; running.failed++;
      running.failures.push({ id: card.id, reason: classifyFailure(why), detail: why });
    }
    if (i < cards.length - 1) await sleep(DELAY_MS);
  }
  return s;
}

// ─── Driver ──────────────────────────────────────────────────────────────────
const t0 = Date.now();
const mode = SCOPED ? `scoped [${SINGLE_SETS.join(", ")}]` : "FULL catalog";
console.log(`Catalog build — ${mode}, resume=${RESUME ? "on" : "off"}`);
console.log("═".repeat(64));

const prisma = new PrismaClient();

let setIds;
try {
  setIds = SCOPED ? SINGLE_SETS : await fetchAllSetIds();
} catch (err) {
  console.error(`Fatal: could not enumerate sets: ${err?.message ?? err}`);
  await prisma.$disconnect();
  process.exit(1);
}
console.log(`Sets to process: ${setIds.length}`);

const running = { upserted: 0, skipped: 0, failed: 0, listed: 0, failures: [] };
const failedSets = [];

for (const [idx, setId] of setIds.entries()) {
  const n = `${idx + 1}/${setIds.length}`;
  try {
    const s = await processSet(prisma, setId, running);
    running.listed += s.listed;
    console.log(
      `Set ${n} (${setId}) done — listed ${s.listed}, +${s.upserted} upserted, ${s.skipped} skipped, ${s.failed} failed` +
      ` — ${nfmt(running.upserted)} upserted so far`,
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
const mm = Math.floor(secs / 60), ss = secs % 60;
const reasonBreakdown = {};
for (const f of running.failures) reasonBreakdown[f.reason] = (reasonBreakdown[f.reason] ?? 0) + 1;

console.log("\n" + "═".repeat(64));
console.log("FINAL SUMMARY");
console.log(`  Mode                 ${mode}`);
console.log(`  Sets attempted       ${setIds.length}`);
console.log(`  Sets fully failed    ${failedSets.length}`);
console.log(`  Cards listed         ${nfmt(running.listed)}`);
console.log(`  Rows upserted        ${nfmt(running.upserted)}`);
console.log(`  Skipped (had)        ${nfmt(running.skipped)}`);
console.log(`  Card failures        ${nfmt(running.failed)}`);
console.log(`  Wall-clock           ${mm}m ${ss}s`);
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
