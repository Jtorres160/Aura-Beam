// M3-B measurement: run the REAL cropBottomStrip() helper, then the strip-read
// prompt, over M3-A's exact 29-card ground truth. Tests detail:"high" vs "auto"
// on the crop. Writes results_gpt_crop_<detail>.json next to the M3-A results.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { cropBottomStrip } from "../../../src/lib/scanner/crop-strip.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(path.join(__dirname, "../../../.env"), "utf8").split(/\r?\n/)) {
  const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)?\s*$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = (m[2] || "").replace(/^["']|["']$/g, "");
}
const sample = JSON.parse(readFileSync(path.join(__dirname, "sample.json"), "utf8"));
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SYS = `You are reading ONLY the small printed information strip along the BOTTOM EDGE of a trading card (Magic: The Gathering or Pokemon). Ignore the artwork, the title, and the rules text. Focus on the bottom border line, which typically shows the set/expansion code, the collector number, the rarity, and the illustrator. Return ONLY a valid JSON object with these keys:
- "setCode": The set / expansion code exactly as printed (e.g., "MH2", "SV3", "WOT"). Pokemon often prints only a set symbol; if just a number "x/y" is visible with no letters, return "".
- "collectorNumber": The collector number exactly as printed, keeping any "/" total (e.g., "267", "267/303", "021/198"), otherwise "".
- "rarity": The rarity letter or word if printed (e.g., "R", "M", "C", "Rare"), otherwise "".
- "artist": The illustrator name after "Illus." or an artist credit if legible, otherwise "".
If the bottom strip is not legible, return every value as "". Return ONLY raw JSON. No markdown. No explanation.`;

const approxKB = (dataUri) => { const c = dataUri.indexOf(","); return Math.round((dataUri.slice(c+1).length*0.75)/1024); };

async function toDataUri(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const buf = Buffer.from(await r.arrayBuffer());
  return `data:image/png;base64,${buf.toString("base64")}`;
}

async function runDetail(detail) {
  const results = [];
  let totalPrompt = 0, totalCompletion = 0, totalKB = 0, cropFails = 0;
  for (const c of sample) {
    const fullUri = await toDataUri(c.imageUrl);
    const cropUri = await cropBottomStrip(fullUri);
    if (cropUri === fullUri) cropFails++;
    totalKB += approxKB(cropUri);
    const t0 = Date.now();
    let parsed = {}, ms = 0;
    try {
      const r = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: SYS },
          { role: "user", content: [{ type: "image_url", image_url: { url: cropUri, detail } }] }
        ],
        max_tokens: 80, temperature: 0.0,
      });
      ms = Date.now() - t0;
      totalPrompt += r.usage?.prompt_tokens || 0;
      totalCompletion += r.usage?.completion_tokens || 0;
      let clean = (r.choices[0]?.message?.content || "{}").trim();
      if (clean.startsWith("```")) clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
      parsed = JSON.parse(clean);
    } catch (e) { parsed = { _error: e.message }; ms = Date.now()-t0; }
    results.push({ externalId: c.externalId, truthSet: c.setCode, truthCN: c.collectorNumber,
      setCode: (parsed.setCode||"").toString().trim(), collectorNumber: (parsed.collectorNumber||"").toString().trim(),
      rarity: parsed.rarity, artist: parsed.artist, ms, cropKB: approxKB(cropUri), err: parsed._error });
    console.error(`[${detail}] ${c.externalId.padEnd(11)} ms=${String(ms).padEnd(5)} cn="${parsed.collectorNumber||''}" set="${parsed.setCode||''}" | truth cn=${c.collectorNumber} set=${c.setCode}`);
  }
  const n = sample.length;
  writeFileSync(path.join(__dirname, `results_gpt_crop_${detail}.json`), JSON.stringify(results, null, 2));
  console.error(`\n[${detail}] TOKENS prompt=${totalPrompt} completion=${totalCompletion} | avg promptTok/img=${Math.round(totalPrompt/n)} | avg cropKB=${Math.round(totalKB/n)} | cropFallbacks=${cropFails}`);
  return { detail, totalPrompt, avgPrompt: Math.round(totalPrompt/n), avgKB: Math.round(totalKB/n), cropFails };
}

const which = process.argv[2] || "both";
const summary = [];
if (which === "high" || which === "both") summary.push(await runDetail("high"));
if (which === "auto" || which === "both") summary.push(await runDetail("auto"));
console.error("\n=== token summary ===");
for (const s of summary) console.error(JSON.stringify(s));
