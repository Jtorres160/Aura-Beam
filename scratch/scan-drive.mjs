import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DIR = dirname(fileURLToPath(import.meta.url));
const URL_ENDPOINT = "http://localhost:3000/api/scanner/scan";

// Game folders (Phase 5.18A) — folder name → the game filter the client would
// send. Images directly in scratch/ still run with game unset (AI-detected).
const GAME_FOLDERS = [
  ["MAGIC THE GATHERING", "MTG"],
  ["POKEMON", "POKEMON"],
  ["YUGIOH", "YUGIOH"],
];

// Optional CLI: --only <substr> reruns matching labels; --gap <ms> overrides
// the inter-scan spacing (the OpenAI org TPM limit needs ~8s+ on full passes).
const args = process.argv.slice(2);
const only = args.includes("--only") ? args[args.indexOf("--only") + 1] : null;
const gapMs = args.includes("--gap") ? Number(args[args.indexOf("--gap") + 1]) : 3000;

const jobs = [];
for (const f of readdirSync(DIR).filter((f) => /\.jpe?g$/i.test(f)).sort()) {
  jobs.push({ file: join(DIR, f), label: f, game: undefined });
}
for (const [folder, game] of GAME_FOLDERS) {
  const p = join(DIR, folder);
  if (!existsSync(p) || !statSync(p).isDirectory()) continue;
  for (const f of readdirSync(p).filter((f) => /\.jpe?g$/i.test(f)).sort()) {
    jobs.push({ file: join(p, f), label: `${folder}/${f}`, game });
  }
}

const selected = only ? jobs.filter((j) => j.label.includes(only)) : jobs;
console.log(`[drive] scanning ${selected.length} images against ${URL_ENDPOINT} (gap=${gapMs}ms)\n`);

let errors = 0;
for (const { file, label, game } of selected) {
  const bytes = readFileSync(file);
  const b64 = bytes.toString("base64");
  const body = JSON.stringify({ image: `data:image/jpeg;base64,${b64}`, ...(game ? { game } : {}) });
  const t0 = Date.now();
  try {
    const res = await fetch(URL_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const rttMs = Date.now() - t0;
    const json = await res.json().catch(() => ({}));
    const summary =
      json.data?.card?.name ||
      json.cardName ||
      json.message ||
      "(no name/message)";
    if (!res.ok && !json.requiresDisambiguation) errors++;
    console.log(
      `[drive] ${label} -> HTTP ${res.status} | clientRTT=${rttMs}ms | ` +
      `success=${json.success} stage=${json.stage ?? "-"} disambig=${Boolean(json.requiresDisambiguation)} | ${summary}`
    );
  } catch (err) {
    errors++;
    console.log(`[drive] ${label} -> FETCH ERROR: ${err.message}`);
  }
  await new Promise((r) => setTimeout(r, gapMs)); // spacing for burst + TPM limits
}
console.log(`\n[drive] done (${errors} hard errors)`);
