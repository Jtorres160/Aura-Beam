// ─── Scanner V2 · M-CATALOG — Catalog Verifier ──────────────────────────────
// Read-only checks against catalog_cards in the live DB: per-set counts, the
// no-duplicate-externalId invariant, required-field completeness, and a sample
// row per set showing every formatPokemonCard field (including price). Used to
// verify the M2 scoped import and, later, the M3 full import.
//
// Usage:
//   node scripts/verify-catalog.mjs                 # whole table
//   node scripts/verify-catalog.mjs --set mcd19 --set base1 --set sv3

import { register } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);
for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
const { PrismaClient } = await import("@prisma/client");

const argv = process.argv.slice(2);
const sets = argv.reduce((a, c, i) => (c === "--set" && argv[i + 1] ? [...a, argv[i + 1]] : a), []);

const prisma = new PrismaClient();

const total = await prisma.catalogCard.count();
// Postgres has no cheap COUNT(DISTINCT) via Prisma; use a raw scalar.
const [{ distinct }] = await prisma.$queryRaw`SELECT COUNT(DISTINCT "externalId")::int AS distinct FROM catalog_cards`;

console.log("═".repeat(60));
console.log(`catalog_cards — total rows: ${total}`);
console.log(`distinct externalId:        ${distinct}`);
console.log(total === distinct ? "✓ no duplicate externalIds" : "✗ DUPLICATE externalIds present");

// Required-field completeness: name/setName are NOT NULL in schema, but verify
// nothing came through blank and that setCode/collectorNumber are populated.
const missingCore = await prisma.catalogCard.count({
  where: { OR: [{ name: "" }, { setName: "" }] },
});
const missingSetCode = await prisma.catalogCard.count({ where: { setCode: null } });
const missingCn = await prisma.catalogCard.count({ where: { collectorNumber: null } });
const missingImage = await prisma.catalogCard.count({ where: { imageUrl: null } });
const missingPrice = await prisma.catalogCard.count({ where: { marketPrice: null } });
console.log(`\nField completeness (over ${total} rows):`);
console.log(`  blank name/setName:     ${missingCore}`);
console.log(`  null setCode:           ${missingSetCode}`);
console.log(`  null collectorNumber:   ${missingCn}`);
console.log(`  null imageUrl:          ${missingImage}`);
console.log(`  null marketPrice:       ${missingPrice}  (price is allowed to be null/0)`);

const setList = sets.length ? sets : (await prisma.catalogCard.findMany({
  distinct: ["setCode"], select: { setCode: true },
})).map((r) => r.setCode).filter(Boolean);

if (sets.length) {
  console.log(`\nPer-set counts (externalId prefix):`);
  for (const s of sets) {
    const c = await prisma.catalogCard.count({ where: { externalId: { startsWith: `${s}-` } } });
    console.log(`  ${s.padEnd(10)} ${c} rows`);
  }
}

console.log(`\nSample rows (one per requested set, all fields):`);
for (const s of (sets.length ? sets : setList.slice(0, 3))) {
  const row = await prisma.catalogCard.findFirst({
    where: sets.length ? { externalId: { startsWith: `${s}-` } } : { setCode: s },
    orderBy: { collectorNumber: "asc" },
  });
  if (!row) { console.log(`  (${s}) — no rows`); continue; }
  console.log(`\n  [${s}] ${row.externalId}`);
  console.log(`    name=${JSON.stringify(row.name)} set=${JSON.stringify(row.setName)} code=${row.setCode} printed=${row.setPrintedSize} cn=${row.collectorNumber} rarity=${JSON.stringify(row.rarity)}`);
  console.log(`    image=${row.imageUrl ? "yes" : "NULL"} thumb=${row.thumbnailUrl ? "yes" : "NULL"}`);
  console.log(`    price market=${row.marketPrice} low=${row.lowPrice} mid=${row.midPrice} high=${row.highPrice} priceAt=${row.priceUpdatedAt?.toISOString?.() ?? row.priceUpdatedAt}`);
  console.log(`    sourceUpdatedAt=${row.sourceUpdatedAt?.toISOString?.() ?? row.sourceUpdatedAt}`);
}

await prisma.$disconnect();
