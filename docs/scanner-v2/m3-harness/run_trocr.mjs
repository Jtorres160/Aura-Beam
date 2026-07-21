import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { pipeline } = await import("@huggingface/transformers");
const sample = JSON.parse(readFileSync(path.join(__dirname, "sample.json"), "utf8"));
const CROPDIR = path.join(__dirname, "crops");
const scorePath = path.join(__dirname, "score.js");

const MODEL_ID = "Xenova/trocr-small-printed";
console.error("loading", MODEL_ID, "...");
const t0 = Date.now();
const ocr = await pipeline("image-to-text", MODEL_ID);
console.error("model loaded in", Date.now() - t0, "ms");

function parse(text) {
  const flat = String(text).replace(/\n/g, " ");
  let cn = "";
  const m = flat.match(/([A-Za-z]{0,3}\d{1,3})\s*\/\s*([A-Za-z]{0,3}\d{1,3})/);
  if (m) cn = m[1] + "/" + m[2];
  let set = "";
  const sm = flat.match(/\b([A-Z]{2,4})\b/);
  if (sm) set = sm[1];
  return { setCode: set, collectorNumber: cn, raw: flat.trim().slice(0,120) };
}

const results = [];
for (const c of sample) {
  const img = path.join(CROPDIR, c.externalId + "_strip_raw.png");
  const t = Date.now();
  const out = await ocr(img);
  const ms = Date.now() - t;
  const text = Array.isArray(out) ? (out[0]?.generated_text ?? "") : (out?.generated_text ?? "");
  const parsed = parse(text);
  results.push({ externalId: c.externalId, truthSet: c.setCode, truthCN: c.collectorNumber, ...parsed, ms });
  console.error(`${c.externalId.padEnd(11)} ms=${String(ms).padEnd(6)} text="${text.slice(0,60)}" -> cn="${parsed.collectorNumber}"`);
}
writeFileSync(path.join(__dirname, "results_trocr.json"), JSON.stringify(results, null, 2));
console.error("done");
