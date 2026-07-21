const fs=require('fs'),path=require('path');
const {cnVerdict}=require('./score.js');
const byId=(f)=>Object.fromEntries(JSON.parse(fs.readFileSync(path.join(__dirname,f),'utf8')).map(r=>[r.externalId,r]));
const T=byId('results_tesseract.json'),G=byId('results_gpt.json');
let both=0,tOnly=0,gOnly=0,neither=0, unionExact=0;
const tOnlyIds=[],gOnlyIds=[],neitherIds=[];
for(const id of Object.keys(T)){
  const tv=cnVerdict(T[id].collectorNumber,T[id].truthCN)==='exact';
  const gv=cnVerdict(G[id].collectorNumber,G[id].truthCN)==='exact';
  if(tv&&gv)both++; else if(tv){tOnly++;tOnlyIds.push(id);} else if(gv){gOnly++;gOnlyIds.push(id);} else {neither++;neitherIds.push(id);}
  if(tv||gv)unionExact++;
}
const n=Object.keys(T).length;
console.log(`Collector# EXACT agreement (n=${n}):`);
console.log(`  both correct:      ${both} (${(100*both/n).toFixed(0)}%)`);
console.log(`  Tesseract-only:    ${tOnly}  ${tOnlyIds.join(', ')}`);
console.log(`  GPT-only:          ${gOnly}  ${gOnlyIds.join(', ')}`);
console.log(`  neither:           ${neither}  ${neitherIds.join(', ')}`);
console.log(`  UNION (either):    ${unionExact} (${(100*unionExact/n).toFixed(0)}%)  <- ensemble ceiling`);
