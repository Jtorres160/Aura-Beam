const fs = require('fs');
const path = require('path');
const { createWorker } = require('tesseract.js');
const sample = require('./sample.json');
const CROPDIR = path.join(__dirname, 'crops');

// Pull a collector-number pattern (X/Y or bare) and a candidate set token out of
// free OCR text. This is the "regex out of noisy full-strip text" approach.
function parseStrip(text) {
  const flat = text.replace(/\n/g, ' ');
  // collector number like 006/198, 6/102, 284/264, TG12/TG30
  let cn = '';
  const m = flat.match(/([A-Za-z]{0,3}\d{1,3})\s*\/\s*([A-Za-z]{0,3}\d{1,3})/);
  if (m) cn = m[1] + '/' + m[2];
  // set code: short uppercase token 2-4 letters not a common word
  let set = '';
  const sm = flat.match(/\b([A-Z]{2,4})\b/);
  if (sm) set = sm[1];
  return { setCode: set, collectorNumber: cn, raw: text.trim().replace(/\s+/g,' ').slice(0,120) };
}

(async () => {
  const worker = await createWorker('eng');
  const results = [];
  for (const c of sample) {
    const img = path.join(CROPDIR, c.externalId + '_strip.png');
    const t0 = Date.now();
    const { data } = await worker.recognize(img);
    const ms = Date.now() - t0;
    const parsed = parseStrip(data.text);
    results.push({ externalId: c.externalId, truthSet: c.setCode, truthCN: c.collectorNumber, ...parsed, ms });
    console.log(`${c.externalId.padEnd(11)} ms=${String(ms).padEnd(5)} cn="${parsed.collectorNumber}" set="${parsed.setCode}" | truth cn=${c.collectorNumber} set=${c.setCode}`);
  }
  await worker.terminate();
  fs.writeFileSync(path.join(__dirname, 'results_tesseract.json'), JSON.stringify(results, null, 2));
  console.log('done, wrote results_tesseract.json');
})().catch(e => { console.error(e); process.exit(1); });
