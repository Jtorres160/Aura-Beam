const fs=require('fs'),path=require('path');
const {cnVerdict,setVerdict}=require('./score.js');
function tally(file){
  const rows=JSON.parse(fs.readFileSync(path.join(__dirname,file),'utf8'));
  const cn={exact:0,near:0,miss:0},set={exact:0,near:0,miss:0};let ms=0;
  for(const r of rows){cn[cnVerdict(r.collectorNumber,r.truthCN)]++;set[setVerdict(r.setCode,r.truthSet)]++;ms+=r.ms||0;}
  return {n:rows.length,cn,set,avgMs:Math.round(ms/rows.length),rows};
}
const base=tally('results_gpt.json');        // M3-A baseline (full image, detail:high)
const high=tally('results_gpt_crop_high.json');
const auto=tally('results_gpt_crop_auto.json');
const pct=(x,n)=>`${x} (${(100*x/n).toFixed(0)}%)`;
function line(name,t){
  console.log(`${name.padEnd(26)} CN exact ${pct(t.cn.exact,t.n).padEnd(9)} near ${String(t.cn.near).padEnd(2)} miss ${String(t.cn.miss).padEnd(2)} | SET exact ${t.set.exact} near ${t.set.near} | ${t.avgMs}ms`);
}
console.log('=== M3-B collector-number + set-code comparison (n=29) ===');
line('BASELINE full-img high', base);
line('CROP high', high);
line('CROP auto', auto);

// per-card deltas: which cards changed between baseline and crop-high
console.log('\n=== Per-card change: baseline(full,high) -> crop(high) ===');
const byId=(t)=>Object.fromEntries(t.rows.map(r=>[r.externalId,r]));
const B=byId(base),H=byId(high);
for(const id of Object.keys(B)){
  const bv=cnVerdict(B[id].collectorNumber,B[id].truthCN);
  const hv=cnVerdict(H[id].collectorNumber,H[id].truthCN);
  if(bv!==hv){
    const arrow = (bv!=='exact'&&hv==='exact')?'  ✅ FIXED':(bv==='exact'&&hv!=='exact')?'  ❌ REGRESSED':'  ~changed';
    console.log(`${id.padEnd(12)} ${bv.padEnd(6)}("${B[id].collectorNumber}") -> ${hv.padEnd(6)}("${H[id].collectorNumber}")${arrow}`);
  }
}
