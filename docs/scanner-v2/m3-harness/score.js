// Shared scoring: compare an extracted {setCode, collectorNumber} against ground truth.
// Returns a per-field verdict: 'exact' | 'near' | 'miss'.

// Normalize a collector number for comparison. Ground truth is bare ("6","258").
// Printed form is usually "006/198". We compare the NUMERATOR, stripping leading
// zeros and any /total, and lowercasing alnum (for TG12/H1 style).
function normCN(s) {
  if (s == null) return '';
  let t = String(s).trim().toLowerCase().replace(/\s+/g, '');
  // take part before a slash if present
  const slash = t.indexOf('/');
  if (slash !== -1) t = t.slice(0, slash);
  // strip leading zeros on pure-numeric
  if (/^\d+$/.test(t)) t = String(parseInt(t, 10));
  return t;
}
function normSet(s) {
  if (s == null) return '';
  return String(s).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

// collector number verdict
function cnVerdict(pred, truth) {
  const p = normCN(pred), t = normCN(truth);
  if (!p) return 'miss';
  if (p === t) return 'exact';
  // near-miss: numerator matches ignoring a transposed/extra punctuation already
  // handled by normCN; treat a raw-string difference that collapses to same digits
  // Also: if predicted contains the truth digits as a substring token
  const rawP = String(pred).toLowerCase();
  if (t && rawP.replace(/[^0-9a-z]/g,'').includes(t) && /\d/.test(t)) {
    // e.g. predicted "6/198" truth "6" already exact; predicted "06" -> exact via normCN
    // this catches OCR that glued extra chars, e.g. "b6" 
    if (Math.abs(p.length - t.length) <= 1) return 'near';
  }
  // one-char edit distance => near
  if (editDist(p, t) === 1) return 'near';
  return 'miss';
}
function setVerdict(pred, truth) {
  const p = normSet(pred), t = normSet(truth);
  if (!p) return 'miss';
  if (p === t) return 'exact';
  if (t && (p.includes(t) || t.includes(p)) && Math.min(p.length,t.length) >= 2) return 'near';
  if (editDist(p, t) === 1 && t.length >= 2) return 'near';
  return 'miss';
}
function editDist(a, b) {
  const m = a.length, n = b.length;
  const d = Array.from({length: m+1}, (_,i)=>[i,...Array(n).fill(0)]);
  for (let j=0;j<=n;j++) d[0][j]=j;
  for (let i=1;i<=m;i++) for (let j=1;j<=n;j++)
    d[i][j] = Math.min(d[i-1][j]+1, d[i][j-1]+1, d[i-1][j-1]+(a[i-1]===b[j-1]?0:1));
  return d[m][n];
}
module.exports = { normCN, normSet, cnVerdict, setVerdict, editDist };
