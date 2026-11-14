// R / mR for assembly triples (VLM-MSGraph §4.1). The paper defines them in words only:
// R = proportion of correctly identified assembly sequences for one task; mR = mean of R over tasks;
// @Triple / @Pair / @Action = full triple / object pair / object-relation must match.
// The keys below are OUR reading (same as ../li25-figures/checks/triple_metrics.py), shown on the page as Derived.
// Shared by the browser and tools/score.mjs.

export const RELATIONS = ['attached to', 'wrapping', 'inside', 'screw', 'hanging from',
  'goes through', 'inserted into', 'meshed with', 'below', 'above'];

export function norm(s) {
  return String(s).toLowerCase().replace(/[“”"'`]/g, '').replace(/\s+/g, ' ').trim()
    .replace(/^(the|a|an) /, '');
}

/** Map a free-text entity to a canonical part name via alias lists; returns the input when nothing matches. */
export function canonEntity(name, aliases = {}) {
  const n = norm(name);
  for (const [canon, list] of Object.entries(aliases)) {
    if (n === norm(canon) || list.some(a => n === norm(a))) return canon;
  }
  return n;
}

export const keys = {
  triple: t => `${t[0]}|${t[1]}|${t[2]}`,
  pair: t => `${t[0]}|${t[2]}`,
  // object-relation: same predicate, the two objects as an unordered set
  action: t => `${t[1]}|${[t[0], t[2]].sort().join('&')}`,
};

/** One-to-one set match; order ignored; denominator |gt|. */
export function recallSet(pred, gt, key) {
  const remaining = gt.map(key);
  let hit = 0;
  for (const p of pred) { const k = key(p); const i = remaining.indexOf(k); if (i >= 0) { remaining.splice(i, 1); hit++; } }
  return gt.length ? hit / gt.length : 0;
}

/** Position-wise match: step i of pred against step i of gt. */
export function recallOrdered(pred, gt, key) {
  let hit = 0;
  gt.forEach((g, i) => { if (pred[i] && key(pred[i]) === key(g)) hit++; });
  return gt.length ? hit / gt.length : 0;
}

/** Best score over several acceptable ground truths (alternative valid orders / pairings). */
export function bestOver(pred, gts, fn, key) { return Math.max(...gts.map(g => fn(pred, g, key))); }

export function canonTriple(t, aliases, relAliases = {}, collapse = null) {
  const rel = norm(t[1]);
  const ent = x => { const c = canonEntity(x, aliases); return collapse ? (collapse[c] || c) : c; };
  return [ent(t[0]), relAliases[rel] || rel, ent(t[2])];
}

/** Score one prediction against one or more GT sequences. Returns {set:{triple,pair,action}, ordered:{...}}. */
export function scoreTask(pred, gts, aliases = {}, relAliases = {}, collapse = null) {
  const P = pred.map(t => canonTriple(t, aliases, relAliases, collapse));
  const G = gts.map(g => g.map(t => canonTriple(t, aliases, relAliases, collapse)));
  const out = { set: {}, ordered: {} };
  for (const k of ['triple', 'pair', 'action']) {
    out.set[k] = bestOver(P, G, recallSet, keys[k]);
    out.ordered[k] = bestOver(P, G, recallOrdered, keys[k]);
  }
  out.outOfList = P.filter(t => !RELATIONS.includes(t[1])).length;
  return out;
}

export function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
export function sd(xs) { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1)); }

/** Parse "(head, relation, tail)" lines from a model reply. Commas inside names are not supported (none in our part list). */
export function parseTriples(text) {
  const out = [];
  const re = /\(([^()]+?),\s*([^(),]+?),\s*([^()]+?)\)/g;
  let m;
  while ((m = re.exec(text))) out.push([m[1].trim(), m[2].trim(), m[3].trim()]);
  return out;
}
