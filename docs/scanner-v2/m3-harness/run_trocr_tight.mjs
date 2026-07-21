import { readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { pipeline } = await import("@huggingface/transformers");
const OUT = path.join(__dirname, "tight");
const ocr = await pipeline("image-to-text", "Xenova/trocr-small-printed");
console.error("loaded");
for (const f of readdirSync(OUT).filter(x=>x.endsWith('.png'))) {
  const out = await ocr(path.join(OUT, f));
  const text = Array.isArray(out) ? out[0]?.generated_text : out?.generated_text;
  console.error(`${f.replace('_tight.png','').padEnd(12)} -> "${text}"`);
}
