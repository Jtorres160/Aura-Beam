// ─── Scanner V2 · M2-B — Shadow Wiring Proof ────────────────────────────────
// Proves the LIVE wiring code (src/lib/scanner/fingerprint-shadow.ts) end-to-end
// with the REAL model + REAL index, without touching OpenAI, without a running
// server, and WITHOUT writing anything to the database.
//
// It reproduces route.ts's exact production deps — matcher = matchFingerprint,
// and the same read-modify-write append — except loadOcrText/saveOcrText are
// in-memory instead of prisma, so no row is created or mutated. The DB is only
// read (by matchFingerprint's ANN query and to sample a card image), never
// written. This isolates the one thing the unit tests mock: that the REAL
// matcher, on a REAL card image, produces a block that merges correctly onto the
// row's existing telemetry.
//
// Usage:  node scripts/verify-fingerprint-shadow.mjs [--n 2]

import { register } from "node:module";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";

register("../test/alias-loader.mjs", import.meta.url);
const require = createRequire(import.meta.url);

for (const line of readFileSync(new URL("../.env", import.meta.url), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/i);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
}
// Force the flag ON for this harness only (process-local; never persisted). The
// module reads it at import time, so set it before importing.
process.env.FINGERPRINT_SHADOW_ENABLED = "1";

const { PrismaClient } = require("@prisma/client");
const { matchFingerprint } = await import("../src/lib/scanner/fingerprint-match.ts");
const { runFingerprintShadow, shouldRunFingerprintShadow } = await import(
  "../src/lib/scanner/fingerprint-shadow.ts"
);

const argv = process.argv.slice(2);
const N = Number((() => { const i = argv.indexOf("--n"); return i === -1 ? undefined : argv[i + 1]; })() ?? 2);

async function downloadImage(url) {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`image HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

const prisma = new PrismaClient();

console.log("Shadow-wiring proof (Scanner V2 · M2-B) — real model, real index, ZERO DB writes");
console.log("─".repeat(80));

// ── Gate: prove the no-op contract first ──
console.log("Gate shouldRunFingerprintShadow:");
console.log(`  flag OFF  + POKEMON + row  → ${shouldRunFingerprintShadow("POKEMON", "r", false)}  (expect false: no schedule)`);
console.log(`  flag ON   + MTG     + row  → ${shouldRunFingerprintShadow("MTG", "r", true)}  (expect false: not indexed)`);
console.log(`  flag ON   + POKEMON + null → ${shouldRunFingerprintShadow("POKEMON", null, true)}  (expect false: no row)`);
console.log(`  flag ON   + POKEMON + row  → ${shouldRunFingerprintShadow("POKEMON", "r", true)}  (expect true)`);
console.log("─".repeat(80));

const rows = await prisma.$queryRawUnsafe(`
  SELECT DISTINCT ON ("setCode") "externalId", "setCode", "imageUrl"
  FROM card_fingerprints
  WHERE "imageUrl" IS NOT NULL
  ORDER BY "setCode", random()
  LIMIT ${Math.max(1, N)}
`);

let pass = 0;
let fail = 0;

for (const [i, row] of rows.entries()) {
  const tag = `[${i + 1}/${rows.length}] ${row.externalId} (${row.setCode})`;

  // The base ocrText a real accept would have written to this row before the
  // shadow runs — a realistic v:1 telemetry record we must merge onto, not clobber.
  const baseOcrText = JSON.stringify({
    v: 1,
    decision: { action: "accept", method: "set-cn-verified", confidence: 0.97 },
    game: "POKEMON",
    ocr: "sample",
  });

  let savedOcrText = null;
  const deps = {
    matcher: matchFingerprint,                         // ← the REAL matcher
    loadOcrText: async () => baseOcrText,              // in-memory (no DB write)
    saveOcrText: async (_id, ocrText) => { savedOcrText = ocrText; },
    warn: (msg, err) => console.log(`    warn: ${msg} ${err?.message ?? err}`),
  };

  try {
    const buf = await downloadImage(row.imageUrl);
    // Simulate an ACCEPT of this same card: pipeline pick === the card itself.
    const dataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
    await runFingerprintShadow(
      { rowId: "in-memory-row", imageUrl: dataUri, pipelineExternalId: row.externalId, pipelinePickSource: "accept" },
      deps,
    );

    if (!savedOcrText) throw new Error("saveOcrText was never called");
    const merged = JSON.parse(savedOcrText);
    const fs = merged.fingerprintShadow;

    const originalSurvived = merged.decision?.method === "set-cn-verified" && merged.game === "POKEMON" && merged.ocr === "sample";
    const topIsSelf = fs?.topMatchExternalId === row.externalId;
    const nearZero = typeof fs?.topMatchDistance === "number" && fs.topMatchDistance <= 0.02;
    const pickThreaded = fs?.pipelineExternalId === row.externalId && fs?.pipelinePickSource === "accept";

    const ok = originalSurvived && topIsSelf && nearZero && pickThreaded;
    if (ok) {
      pass++;
      console.log(`  ✓ ${tag} — top=${fs.topMatchExternalId} dist=${fs.topMatchDistance.toExponential(2)}, original telemetry preserved, pick threaded`);
    } else {
      fail++;
      console.log(`  ✗ ${tag} — originalSurvived=${originalSurvived} topIsSelf=${topIsSelf} nearZero=${nearZero} pickThreaded=${pickThreaded}`);
      console.log(`      block: ${JSON.stringify(fs)}`);
    }
  } catch (err) {
    fail++;
    console.log(`  ✗ ${tag} — ${err?.message ?? err}`);
  }
}

await prisma.$disconnect();
console.log("─".repeat(80));
console.log(`Summary: ${pass} pass / ${fail} fail (of ${rows.length})`);
console.log(fail === 0 ? "\nALL CHECKS PASSED" : "\nSOME CHECKS FAILED");
process.exit(fail === 0 ? 0 : 1);
