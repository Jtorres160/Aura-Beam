const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const sample = require('./sample.json');
const IMGDIR = path.join(__dirname, 'images');
const CROPDIR = path.join(__dirname, 'crops');
fs.mkdirSync(IMGDIR, { recursive: true });
fs.mkdirSync(CROPDIR, { recursive: true });

async function dl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return Buffer.from(await r.arrayBuffer());
}

(async () => {
  for (const c of sample) {
    const id = c.externalId;
    const full = path.join(IMGDIR, id + '.png');
    if (!fs.existsSync(full)) {
      const buf = await dl(c.imageUrl);
      fs.writeFileSync(full, buf);
    }
    const meta = await sharp(full).metadata();
    // Bottom strip: Pokemon set/CN text sits in the bottom ~8-13% band along
    // the lower border. Take bottom 14% full width; also a "wide" bottom 18%.
    const h = meta.height, w = meta.width;
    const bandTop = Math.round(h * 0.86);
    const bandH = h - bandTop;
    await sharp(full)
      .extract({ left: 0, top: bandTop, width: w, height: bandH })
      // upscale 2x + grayscale + normalize to help classical OCR
      .resize({ width: w * 2 })
      .grayscale().normalize()
      .toFile(path.join(CROPDIR, id + '_strip.png'));
    // also keep a raw (color, no processing) crop for TrOCR/vision
    await sharp(full)
      .extract({ left: 0, top: bandTop, width: w, height: bandH })
      .toFile(path.join(CROPDIR, id + '_strip_raw.png'));
    console.log(`${id}: ${w}x${h} -> strip ${w}x${bandH} (top=${bandTop})`);
  }
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
