// ─── DEV-ONLY · Draft Benchmark Entries from Selections (V2 · M1 step 3) ─────
// Read-only helper that DRAFTS Recognition Benchmark entries from the scans that
// already carry a ground-truth label: a `selection` (the user looked at the
// physical card and picked a printing from the disambiguation grid — see
// SelectionLabel in src/lib/scanner/telemetry.ts). Those picks are the strongest
// truth we have, so they are the natural seed for the permanent benchmark.
//
// It DOES NOT seed the manifest. It reads ScanHistory, prints the drafted
// entries, validates them against the REAL loader (validateManifest in
// src/lib/scanner/benchmark/loader.ts), reports how many would pass vs. fail and
// WHY, and lists the scan ids a human must still categorize. Seeding
// manifest.json is a separate, deliberate decision made after reviewing this
// draft.
//
// Honesty boundaries this script holds:
//   • Ground truth = selection.externalId + selection.game ONLY. That is all the
//     label actually asserts.
//   • expectedName is the scan's OCR read, NOT ground truth. It is included only
//     as a convenience for the human reviewer and is marked as such — the
//     reviewer confirms it against the externalId.
//   • Difficulty category is a judgment about the physical card and is NOT
//     derivable from telemetry. It is left EMPTY on every draft, on purpose, and
//     every drafted scan is listed as needing manual categorization.
//   • No image exists in telemetry, so `image` is left empty. A real,
//     rights-cleared photo must be attached before an entry is valid.
//
// The last two mean EVERY draft is expected to FAIL loader validation today —
// that is the correct, truthful result: it names exactly the manual work
// (categorize + photograph) that stands between these labels and a real
// benchmark entry.
//
// It issues findMany and nothing else — byte-for-byte the read pattern of
// scripts/recognition-baseline.mjs. It never writes the database, never touches
// manifest.json, and imports no scan-path module.
//
// Usage:
//   node scripts/draft-benchmark-from-selections.mjs                # print draft + report
//   node scripts/draft-benchmark-from-selections.mjs --out <file>   # also write drafts JSON to a scratch file
//   node scripts/draft-benchmark-from-selections.mjs --json         # machine-readable summary to stdout
//
// Reads DATABASE_URL from the environment (.env) — it measures whichever
// database that points at.

import { register } from "node:module";
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);
const require = createRequire(import.meta.url);
const { PrismaClient } = require("@prisma/client");

// The REAL validator — the whole point is to grade drafts against the loader the
// benchmark actually uses, not a private copy of the rules.
const { validateManifest } = await import("../src/lib/scanner/benchmark/loader.ts");
const { DEV_USER } = await import("../src/lib/auth-dev-bypass.ts");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name) => argv.includes(`--${name}`);

if (has("help")) {
  console.log("Usage: node scripts/draft-benchmark-from-selections.mjs [--out <file>] [--json]");
  process.exit(0);
}

// ─── Defensive readers (records come from a text column, many app versions) ──
const isObject = (x) => typeof x === "object" && x !== null;
const str = (x) => (typeof x === "string" && x.trim() !== "" ? x : undefined);

/** Stable kebab slug from an arbitrary provider id. */
function slug(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

// ─── Pull the labeled rows ───────────────────────────────────────────────────
const prisma = new PrismaClient();

// Development rows are not collector scans — excluded, exactly as
// recognition-baseline.mjs does.
const rows = await prisma.scanHistory.findMany({
  where: { ocrText: { not: null }, userId: { not: DEV_USER.id } },
  select: { id: true, ocrText: true, createdAt: true },
  orderBy: { createdAt: "asc" },
});

const drafts = [];
let parsedRows = 0;
let labeledRows = 0;
let skippedNoExternalId = 0;

for (const row of rows) {
  let parsed;
  try {
    parsed = JSON.parse(row.ocrText);
  } catch {
    continue;
  }
  if (!isObject(parsed) || parsed.v !== 1) continue;
  parsedRows++;

  const selection = isObject(parsed.selection) ? parsed.selection : undefined;
  if (!selection) continue;
  labeledRows++;

  const externalId = str(selection.externalId);
  const game = str(selection.game) ?? str(parsed.game);
  if (!externalId) {
    // A selection with no externalId cannot anchor printing-level truth — the
    // one thing this seed exists to carry. Count it, don't fake it.
    skippedNoExternalId++;
    continue;
  }

  // Best-effort name for the reviewer — the OCR read, NOT ground truth.
  const ocrName = isObject(parsed.ocr) ? str(parsed.ocr.name) : undefined;
  const evidenceName =
    isObject(parsed.evidence) && isObject(parsed.evidence.identity) && isObject(parsed.evidence.identity.name)
      ? str(parsed.evidence.identity.name.value)
      : undefined;
  const draftName = ocrName ?? evidenceName; // may be undefined

  // A short scan-id suffix keeps ids/traceability unique even when the same card
  // was selected across several scans (each is a distinct future photo).
  const scanShort = row.id.slice(-6);
  const id = `${(game ?? "unknown").toLowerCase()}-${slug(externalId).slice(0, 24)}-${scanShort}`;

  drafts.push({
    entry: {
      id,
      image: "", // no photo exists in telemetry — must be attached by hand
      game: game ?? undefined,
      expectedName: draftName ?? undefined,
      expectedExternalId: externalId, // ← the ground truth
      categories: [], // ← deliberately unfilled: difficulty is a human judgment
      notes: `Drafted from scan ${row.id} (selection @ ${str(selection.at) ?? "?"}). `
        + `expectedName is the OCR read, unverified. Needs: difficulty category + real photo.`,
    },
    scanId: row.id,
    hasDraftName: Boolean(draftName),
  });
}

await prisma.$disconnect();

// ─── Grade the drafts against the REAL loader ────────────────────────────────
// Per-entry validity: each draft is validated as a one-entry manifest so its
// intrinsic pass/fail is independent of cross-entry duplicate checks. The full
// draft manifest is validated separately to surface any id/image collisions.
const failureReasons = {};
let pass = 0;
let fail = 0;
for (const d of drafts) {
  const res = validateManifest({ v: 1, description: "draft", entries: [d.entry] });
  if (res.ok) {
    pass++;
  } else {
    fail++;
    for (const e of res.errors) {
      // Normalize the entry-specific bits out so reasons aggregate cleanly.
      const key = e.message.replace(/"[^"]*"/g, "…").replace(/\(got .*\)/, "(got …)");
      failureReasons[key] = (failureReasons[key] ?? 0) + 1;
    }
  }
}

const fullManifest = { v: 1, description: "draft (all selections)", entries: drafts.map((d) => d.entry) };
const fullResult = validateManifest(fullManifest);
const collisionErrors = fullResult.errors.filter((e) => /duplicate/.test(e.message));

const summary = {
  sourceRows: rows.length,
  v1Records: parsedRows,
  labeledRows,
  skippedNoExternalId,
  drafted: drafts.length,
  wouldPassValidation: pass,
  wouldFailValidation: fail,
  failureReasons,
  crossEntryCollisions: collisionErrors.length,
  needsManualCategorization: drafts.map((d) => d.scanId),
};

// ─── Optional scratch write (NEVER manifest.json, NEVER src/) ────────────────
const outPath = flag("out");
if (outPath) {
  if (/manifest\.json$/i.test(outPath) || /[\\/]src[\\/]/.test(outPath)) {
    console.error(`Refusing to write to "${outPath}": this script never writes manifest.json or anything under src/.`);
    process.exit(1);
  }
  writeFileSync(outPath, JSON.stringify(fullManifest, null, 2));
}

// ─── Report ──────────────────────────────────────────────────────────────────
if (has("json")) {
  console.log(JSON.stringify({ summary, drafts: drafts.map((d) => d.entry) }, null, 2));
} else {
  console.log("Benchmark seed draft from selection labels (V2 · M1 step 3)");
  console.log("══════════════════════════════════════════════════════════");
  console.log(`  ScanHistory rows read       ${summary.sourceRows}`);
  console.log(`  v1 telemetry records        ${summary.v1Records}`);
  console.log(`  Rows with a selection label ${summary.labeledRows}`);
  console.log(`  · skipped (no externalId)   ${summary.skippedNoExternalId}`);
  console.log(`  Drafted entries             ${summary.drafted}`);
  console.log(`    · with an OCR name        ${drafts.filter((d) => d.hasDraftName).length}`);
  console.log("");
  console.log("Loader validation (src/lib/scanner/benchmark/loader.ts)");
  console.log("──────────────────────────────────────────────────────");
  console.log(`  Would PASS                  ${summary.wouldPassValidation}`);
  console.log(`  Would FAIL                  ${summary.wouldFailValidation}`);
  if (summary.wouldFailValidation > 0) {
    console.log("  Failure reasons (expected — these name the manual work left):");
    for (const [reason, n] of Object.entries(failureReasons).sort((a, b) => b[1] - a[1])) {
      console.log(`      ${String(n).padStart(4)}×  ${reason}`);
    }
  }
  if (collisionErrors.length > 0) {
    console.log(`  ⚠ cross-entry collisions    ${collisionErrors.length} (same card selected in multiple scans)`);
  }
  console.log("");
  console.log("Scans needing MANUAL difficulty categorization");
  console.log("──────────────────────────────────────────────");
  console.log("  Difficulty (easy/holo/alt-art/promo/…) is a judgment about the physical");
  console.log("  card, not derivable from telemetry. Every drafted scan below needs a human");
  console.log("  to assign categories AND attach a real photo before it can be seeded:");
  for (const id of summary.needsManualCategorization) console.log(`      ${id}`);
  console.log("");
  console.log(`  Nothing was written to the database or manifest.json.`);
  if (outPath) console.log(`  Draft manifest written to: ${outPath}`);
  else console.log(`  (pass --out <file> to save the drafted entries to a scratch file)`);
}
