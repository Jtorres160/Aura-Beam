const { PrismaClient } = require('@prisma/client');
require('dotenv').config({ path: '.env' });
const fs = require('fs');
const p = new PrismaClient();

// Curated era spread. For each set prefix, we grab one "typical" card and,
// for a few modern sets, one high-collector-number card (secret/hyper rare).
const eras = [
  ['base1','WOTC 1999 Base'], ['gym1','WOTC 2000 Gym'], ['neo1','WOTC 2000 Neo'],
  ['ecard1','2002 e-Card'], ['ex1','2003 EX Ruby&Sapphire'], ['ex7','2005 EX'],
  ['dp1','2007 Diamond&Pearl'], ['pl1','2009 Platinum'], ['hgss1','2010 HGSS'],
  ['bw1','2011 Black&White'], ['bw7','2013 BW Boundaries'], ['xy1','2014 XY'],
  ['xy5','2015 Primal Clash'], ['sm1','2017 Sun&Moon'], ['sm12','2019 Cosmic Eclipse'],
  ['swsh1','2020 Sword&Shield'], ['swsh8','2021 Fusion Strike'],
  ['sv1','2023 Scarlet&Violet'], ['sv3','2023 Obsidian Flames'],
  ['sv4pt5','2024 Paldean Fates'], ['sv8','2024 Surging Sparks'],
];
(async () => {
  const picks = [];
  for (const [prefix, label] of eras) {
    // typical: middle-ish numeric collector number
    const typical = await p.$queryRawUnsafe(`
      SELECT "externalId","setCode","collectorNumber","imageUrl"
      FROM card_fingerprints
      WHERE split_part("externalId",'-',1)=$1
        AND "collectorNumber" ~ '^[0-9]+$'
      ORDER BY ("collectorNumber")::int ASC OFFSET 5 LIMIT 1`, prefix);
    if (typical[0]) picks.push({ ...typical[0], era: label, kind: 'typical' });
  }
  // A handful of high-number secret/hyper rares from modern sets
  for (const prefix of ['sv1','sv3','sv8','swsh8','sm12','xy5']) {
    const secret = await p.$queryRawUnsafe(`
      SELECT "externalId","setCode","collectorNumber","imageUrl"
      FROM card_fingerprints
      WHERE split_part("externalId",'-',1)=$1
        AND "collectorNumber" ~ '^[0-9]+$'
      ORDER BY ("collectorNumber")::int DESC LIMIT 1`, prefix);
    if (secret[0]) picks.push({ ...secret[0], era: prefix+' (secret/high#)', kind: 'secret' });
  }
  // a couple with non-numeric collector numbers (TG/GG subsets) for realism
  const special = await p.$queryRawUnsafe(`
    SELECT "externalId","setCode","collectorNumber","imageUrl"
    FROM card_fingerprints
    WHERE "collectorNumber" ~ '[A-Za-z]' LIMIT 2`);
  for (const s of special) picks.push({ ...s, era: 'alphanumeric collector#', kind: 'special' });

  fs.writeFileSync(require('path').join(__dirname, 'sample.json'), JSON.stringify(picks, null, 2));
  console.log('picked', picks.length, 'cards');
  for (const c of picks) console.log(`${c.externalId.padEnd(12)} set=${String(c.setCode).padEnd(7)} cn=${String(c.collectorNumber).padEnd(8)} [${c.kind}] ${c.era}`);
  await p.$disconnect();
})().catch(e => { console.error(e.message); process.exit(1); });
