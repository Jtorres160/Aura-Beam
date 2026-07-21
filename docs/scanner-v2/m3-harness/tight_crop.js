const path = require('path'), fs = require('fs');
const sharp = require('sharp');
const IMGDIR = path.join(__dirname, 'images');
const OUT = path.join(__dirname, 'tight');
fs.mkdirSync(OUT, { recursive: true });
// modern cards: "006/198" sits bottom-left. Tight box on lower-left of card.
const cards = ['sv1-6','sv3-6','swsh8-284','sm12-6','xy5-164','swsh1-6'];
(async () => {
  for (const id of cards) {
    const f = path.join(IMGDIR, id + '.png');
    const m = await sharp(f).metadata();
    const left = Math.round(m.width * 0.05), top = Math.round(m.height * 0.90);
    const width = Math.round(m.width * 0.33), height = Math.round(m.height * 0.065);
    await sharp(f).extract({ left, top, width, height }).resize({ width: width*3 })
      .toFile(path.join(OUT, id + '_tight.png'));
    console.log(id, 'tight crop', width, 'x', height);
  }
})().catch(e=>{console.error(e);process.exit(1);});
