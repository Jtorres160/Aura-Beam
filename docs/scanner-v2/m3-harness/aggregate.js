const fs = require('fs');
const path = require('path');
const { cnVerdict, setVerdict } = require('./score.js');
const files = { Tesseract: 'results_tesseract.json', 'TrOCR-small': 'results_trocr.json', 'GPT-4o-mini': 'results_gpt.json' };

function tally(rows) {
  const cn = { exact:0, near:0, miss:0 }, set = { exact:0, near:0, miss:0 };
  let msSum = 0, msN = 0;
  const detail = [];
  for (const r of rows) {
    const cv = cnVerdict(r.collectorNumber, r.truthCN ?? r.truthCN);
    const sv = setVerdict(r.setCode, r.truthSet);
    cn[cv]++; set[sv]++;
    if (typeof r.ms === 'number') { msSum += r.ms; msN++; }
    detail.push({ id: r.externalId, cn: r.collectorNumber, cnv: cv, set: r.setCode, sv, truthCN: r.truthCN, truthSet: r.truthSet });
  }
  return { cn, set, avgMs: Math.round(msSum/msN), detail };
}

const summary = {};
for (const [name, file] of Object.entries(files)) {
  const rows = JSON.parse(fs.readFileSync(path.join(__dirname, file), 'utf8'));
  const t = tally(rows);
  summary[name] = t;
  const n = rows.length;
  const pct = (x) => (100*x/n).toFixed(0)+'%';
  console.log(`\n=== ${name} (n=${n}, avg ${t.avgMs}ms/img) ===`);
  console.log(`  Collector#:  exact ${t.cn.exact} (${pct(t.cn.exact)})  near ${t.cn.near} (${pct(t.cn.near)})  miss ${t.cn.miss} (${pct(t.cn.miss)})`);
  console.log(`  Set code:    exact ${t.set.exact} (${pct(t.set.exact)})  near ${t.set.near} (${pct(t.set.near)})  miss ${t.set.miss} (${pct(t.set.miss)})`);
}
fs.writeFileSync(path.join(__dirname,'summary.json'), JSON.stringify(summary, null, 2));

// Per-card CN comparison table
console.log('\n\n=== Per-card collector# verdicts ===');
const tRows = JSON.parse(fs.readFileSync(path.join(__dirname,'results_tesseract.json'),'utf8'));
const trRows = JSON.parse(fs.readFileSync(path.join(__dirname,'results_trocr.json'),'utf8'));
const gRows = JSON.parse(fs.readFileSync(path.join(__dirname,'results_gpt.json'),'utf8'));
const byId = (rows) => Object.fromEntries(rows.map(r=>[r.externalId,r]));
const T=byId(tRows), TR=byId(trRows), G=byId(gRows);
console.log('card'.padEnd(12), 'truthCN'.padEnd(9), 'Tess'.padEnd(10), 'TrOCR'.padEnd(8), 'GPT'.padEnd(10));
for (const r of tRows) {
  const id=r.externalId;
  const v=(row)=>{const cv=cnVerdict(row.collectorNumber,row.truthCN);return `${(row.collectorNumber||'—')}[${cv[0]}]`;};
  console.log(id.padEnd(12), String(r.truthCN).padEnd(9), v(T[id]).padEnd(10), v(TR[id]).padEnd(8), v(G[id]).padEnd(10));
}
