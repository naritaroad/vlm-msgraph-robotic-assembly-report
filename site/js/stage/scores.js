// Stage tab "Scores": row-by-row scoring of one local VLM run, and the paper's Tables 1-3 and Fig. 6.
// The scoring keys come from ../metrics.js (our reading; the paper prints no formula for R / mR).
// The pure functions at the top are also used by graph.js and by tools/tests/metrics.test.mjs (no DOM at import time).
import { RELATIONS, norm, keys, canonTriple, recallSet, recallOrdered, scoreTask } from '../metrics.js';

const KINDS = ['triple', 'pair', 'action'];

/* ------------------------------------------------------------------ pure scoring helpers */

/** Greedy one-to-one matching, same order of operations as metrics.recallSet. Returns, per prediction, the matched GT index or -1. */
export function matchSet(P, G, key) {
  const remaining = G.map((g, i) => ({ k: key(g), i }));
  return P.map(p => {
    const k = key(p);
    const j = remaining.findIndex(r => r.k === k);
    return j < 0 ? -1 : remaining.splice(j, 1)[0].i;
  });
}

/** Position-wise matching, as metrics.recallOrdered: prediction i against GT i. */
export function matchOrdered(P, G, key) {
  return P.map((p, i) => (G[i] && key(p) === key(G[i]) ? i : -1));
}

const count = xs => xs.filter(x => x >= 0).length;

/**
 * Explain one run: which predicted triple hits which ground-truth triple under each of the three looseness levels.
 * gt = contents of data/sceneB_gt.json. opts.names: 'strict' | 'colourblind'. opts.mode: 'set' | 'ordered'.
 * The headline scores (score.set / score.ordered) are metrics.scoreTask, i.e. the best over the accepted GT orders per metric.
 * The row table uses ONE accepted order: the one with the most @Triple hits (then @Action, then @Pair) in the chosen mode.
 */
export function explainRun(pred, gt, opts = {}) {
  const names = opts.names === 'colourblind' ? 'colourblind' : 'strict';
  const mode = opts.mode === 'ordered' ? 'ordered' : 'set';
  const collapse = names === 'colourblind' ? gt.colour_blind.map : null;
  const canon = t => canonTriple(t, gt.aliases, gt.relation_aliases, collapse);
  const P = pred.map(canon);
  const Gs = gt.gts.map(g => g.map(canon));
  const matcher = mode === 'ordered' ? matchOrdered : matchSet;
  let alt = 0, best = null;
  Gs.forEach((G, a) => {
    const m = Object.fromEntries(KINDS.map(k => [k, matcher(P, G, keys[k])]));
    const rank = [count(m.triple), count(m.action), count(m.pair)];
    if (!best || rank[0] > best.rank[0] || (rank[0] === best.rank[0] && (rank[1] > best.rank[1] || (rank[1] === best.rank[1] && rank[2] > best.rank[2])))) {
      best = { rank, m }; alt = a;
    }
  });
  const G = Gs[alt];
  const known = new Set(gt.parts.map(p => (collapse ? collapse[p] || p : p)));
  const setTriple = matchSet(P, G, keys.triple);
  const rows = P.map((c, i) => {
    const hit = Object.fromEntries(KINDS.map(k => [k, best.m[k][i] >= 0]));
    const gtIndex = Object.fromEntries(KINDS.map(k => [k, best.m[k][i]]));
    const outOfList = !RELATIONS.includes(c[1]);
    const unknown = [c[0], c[2]].filter(n => !known.has(n));
    let reason = 'hit', ref = hit.triple ? gtIndex.triple : -1;
    if (!hit.triple) {
      const samePair = G.findIndex(g => keys.pair(g) === keys.pair(c));
      const swapped = G.findIndex(g => g[1] === c[1] && g[0] === c[2] && g[2] === c[0]);
      const dup = G.findIndex(g => keys.triple(g) === keys.triple(c));
      if (mode === 'ordered' && setTriple[i] >= 0) { reason = 'order'; ref = setTriple[i]; }
      else if (dup >= 0) { reason = 'duplicate'; ref = dup; }
      else if (swapped >= 0) { reason = 'swapped'; ref = swapped; }
      else if (samePair >= 0) { reason = 'relation'; ref = samePair; }
      else if (unknown.length) { reason = 'name'; }
      else { reason = 'extra'; }
    }
    return { i, raw: pred[i], canon: c, hit, gtIndex, reason, ref, outOfList, unknown };
  });
  const hits = Object.fromEntries(KINDS.map(k => [k, count(best.m[k])]));
  const matchedGt = new Set(best.m.triple.filter(x => x >= 0));
  const missing = G.map((g, i) => i).filter(i => !matchedGt.has(i));
  const score = scoreTask(pred, gt.gts, gt.aliases, gt.relation_aliases, collapse);
  const n_gt = G.length, n_pred = P.length;
  const R = Object.fromEntries(KINDS.map(k => [k, n_gt ? hits[k] / n_gt : 0]));
  const precision = Object.fromEntries(KINDS.map(k => [k, n_pred ? hits[k] / n_pred : 0]));
  // per metric: does another accepted order score higher than the one shown in the table?
  const bestHits = Object.fromEntries(KINDS.map(k => [k, Math.round(score[mode][k] * n_gt)]));
  return { names, mode, alt, n_alts: Gs.length, P, G, rows, missing, hits, bestHits, n_gt, n_pred, R, precision,
    extras: n_pred - hits.triple, outOfList: rows.filter(r => r.outOfList).length, score };
}

/** Triple Extractor replies that use a relation outside the Fig. 5 list, counted per model from summary.json runs (scene B). */
export function outOfListByModel(runs) {
  const out = {};
  for (const r of runs.filter(r => r.scene === 'B' && r.pred)) {
    const o = (out[r.model] ||= { runs: 0, runsWith: 0, triples: 0, triplesOut: 0, terms: {} });
    const bad = r.pred.filter(t => !RELATIONS.includes(norm(t[1])));
    o.runs++; o.triples += r.pred.length; o.triplesOut += bad.length;
    if (bad.length) o.runsWith++;
    for (const t of bad) o.terms[norm(t[1])] = (o.terms[norm(t[1])] || 0) + 1;
  }
  return out;
}

/** Fig. 6: score one product under both readings. Illegible rows are dropped first and reported in `excluded`. */
export function scoreFig6(product) {
  const excluded = [];
  const keep = (rows, side) => rows.filter((r, i) => { if (!r.legible) excluded.push(`${product.id} ${side} #${i + 1}`); return r.legible; });
  const gtRows = keep(product.gt, 'GT'), prRows = keep(product.pred, 'pred');
  const c = r => canonTriple(r.t, {}, {});
  const G = gtRows.map(c), P = prRows.map(c);
  const out = { n_gt: G.length, n_pred: P.length, excluded, set: {}, ordered: {}, match: { set: matchSet(P, G, keys.triple), ordered: matchOrdered(P, G, keys.triple) } };
  for (const k of KINDS) { out.set[k] = recallSet(P, G, keys[k]); out.ordered[k] = recallOrdered(P, G, keys[k]); }
  out.ticks = prRows.reduce((a, r) => (a[r.tick] = (a[r.tick] || 0) + 1, a), {});
  out.gtOutOfList = G.filter(g => !RELATIONS.includes(g[1])).map(g => g[1]);
  return out;
}

/* ------------------------------------------------------------------ DOM helpers */

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (en, zh) => `<span class="en" lang="en">${en}</span><span class="zh" lang="zh-Hant">${zh}</span>`;
const tag = t => `<span class="tag" data-tag="${t}">${t}</span>`;
const fmt = (x, d = 2) => Number(x).toFixed(d);
const tri = t => `<span class="w-t">⟨${esc(t[0])}, <b>${esc(t[1])}</b>, ${esc(t[2])}⟩</span>`;
const dataUrl = p => new URL(`../../data/${p}`, import.meta.url);
const getJSON = async p => { const r = await fetch(dataUrl(p)); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const S = (name, attrs = {}, inner = '') => `<${name}${Object.entries(attrs).map(([k, v]) => ` ${k}="${esc(v)}"`).join('')}>${inner}</${name}>`;
const runId = r => `${r.model}/${r.variant}/${r.run}`;

const REASON = {
  hit: ['', ''],
  order: ['right triple, other position', '這條對，但位置不同'],
  duplicate: ['repeats a triple already counted', '重複，已算過一次'],
  swapped: ['subject and object swapped', '主詞和受詞對調'],
  relation: ['same two parts, different relation', '兩個零件對，關係詞不同'],
  name: ['name does not map to one part', '名稱對不上單一零件'],
  extra: ['extra: no ground-truth step links these parts', '多出來的：標準答案沒有這兩件的步驟'],
};

/* ------------------------------------------------------------------ component */

export async function mount(el, ctx = {}) {
  const [summary, gt, paper, fig6] = await Promise.all([getJSON('vlm/summary.json'), getJSON('sceneB_gt.json'), getJSON('paper.json'), getJSON('fig6.json')]);
  const runs = summary.runs.filter(r => r.scene === 'B' && r.pred);
  const state = { view: 'run', run: runId(runs.find(r => r.model === 'gpt-4o' && r.variant === 'with_base') || runs[0]), mode: 'set', names: 'strict' };
  const bind = (k, v) => { try { ctx.bind?.(k, v); } catch { /* host not ready */ } };
  const emit = (e, d) => { try { ctx.bus?.emit?.(e, d); } catch { /* host not ready */ } };

  el.classList.add('w', 'w-scores');
  el.innerHTML = `
    <div class="w-nav" role="group" aria-label="Scores views">
      <button type="button" data-view="run">${bi('Our run', '我們的實跑')}</button>
      <button type="button" data-view="table1">Table 1</button>
      <button type="button" data-view="table2">Table 2</button>
      <button type="button" data-view="table3">Table 3</button>
      <button type="button" data-view="fig6">Fig. 6</button>
    </div>
    <div class="w-body"></div>`;
  const body = el.querySelector('.w-body');
  const nav = el.querySelector('.w-nav');

  const seg = (name, value, options) => `<span class="w-seg" role="group" aria-label="${name}">${options.map(([v, label]) =>
    `<button type="button" data-set="${name}" data-value="${v}" aria-pressed="${v === value}">${label}</button>`).join('')}</span>`;
  const modeSeg = () => seg('mode', state.mode, [['set', bi('as a set', '當集合')], ['ordered', bi('in order', '依序對位')]]);

  /* ---------------- view: one run */
  function renderRun() {
    const run = runs.find(r => runId(r) === state.run) || runs[0];
    const x = explainRun(run.pred, gt, state);
    const groups = {};
    for (const r of runs) (groups[`${r.model} · ${r.variant.replace('_', ' ')}`] ||= []).push(r);
    const options = Object.entries(groups).map(([g, rs]) => `<optgroup label="${esc(g)}">${rs.map(r =>
      `<option value="${runId(r)}"${runId(r) === runId(run) ? ' selected' : ''}>${esc(r.model)} · ${r.variant === 'with_base' ? 'with base' : 'without base'} · run ${r.run}</option>`).join('')}</optgroup>`).join('');
    const sc = x.score[state.mode];
    const big = (k, label) => {
      const hits = x.bestHits[k];
      return `<div class="readout" data-flash>
        <small>R@${label}</small>
        <output>${fmt(sc[k])}</output>
        <span class="w-frac">${hits} / ${x.n_gt} <i>${bi('hits / GT triples', '命中 / 標準答案條數')}</i></span>
      </div>`;
    };
    const cell = ok => `<td class="w-yn" data-ok="${ok}"><span aria-hidden="true">${ok ? '✓' : '✗'}</span><span class="vh">${ok ? 'hit' : 'miss'}</span></td>`;
    const why = r => {
      if (r.reason === 'hit') return `<span class="w-ok">${bi('hit', '命中')}</span>`;
      let s = bi(REASON[r.reason][0], REASON[r.reason][1]);
      if (r.reason === 'relation') s += ` <span class="w-mono">GT: ${esc(x.G[r.ref][1])}</span>`;
      if (r.reason === 'name') s += ` <span class="w-mono">${r.unknown.map(u => `“${esc(u)}”`).join(', ')}</span>`;
      return s;
    };
    const rowsHtml = x.rows.map(r => {
      const ref = state.mode === 'ordered' ? (r.i < x.n_gt ? r.i : -1) : (r.hit.triple ? r.gtIndex.triple : r.hit.action ? r.gtIndex.action : r.hit.pair ? r.gtIndex.pair : r.ref);
      return `<tr data-reason="${r.reason}">
        <th scope="row">${r.i + 1}</th>
        <td class="w-tri">${tri(r.raw)}${r.outOfList ? ` <mark class="w-ool" title="not in the Fig. 5 list">${bi('off-list relation', '清單外關係詞')}</mark>` : ''}</td>
        <td class="w-ref">${ref >= 0 ? `GT ${ref + 1}` : '—'}</td>
        ${cell(r.hit.triple)}${cell(r.hit.pair)}${cell(r.hit.action)}
        <td class="w-why">${why(r)}</td></tr>`;
    }).join('');
    const missing = x.missing.map(i => `<li><span class="w-mono">GT ${i + 1}</span> ${tri(gt.gts[x.alt][i])}</li>`).join('');
    const altNote = KINDS.some(k => x.bestHits[k] !== x.hits[k])
      ? `<p class="w-note">${bi(`The three readouts take the best of the ${x.n_alts} accepted orders per metric. The table shows accepted order ${x.alt + 1}, where the hits are ${KINDS.map(k => x.hits[k]).join(' / ')} (Triple / Pair / Action).`,
        `三個讀數各自取 ${x.n_alts} 組可接受順序中最高的一組。下表用第 ${x.alt + 1} 組，命中數是 ${KINDS.map(k => x.hits[k]).join(' / ')}（Triple／Pair／Action）。`)}</p>` : '';
    const prec = x.n_pred ? x.hits.triple / x.n_pred : 0;
    body.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h3 class="panel-name">${bi('R for one task: one desk photo', '一個任務的 R：一張桌面照片')}</h3><span class="panel-ref">R@Triple · R@Pair · R@Action</span>${tag('Local run')}</header><div class="panel-body">
        <div class="w-controls">
          <label class="w-field"><span>${bi('Run', '實跑')}</span><select data-role="run" aria-label="Run">${options}</select></label>
          <span class="w-field"><span>${bi('Order', '順序')}</span>${modeSeg()}</span>
          <span class="w-field"><span>${bi('Names', '名稱')}</span>${seg('names', state.names, [['strict', bi('strict', '嚴格')], ['colourblind', bi('colour-blind', '不看顏色')]])}</span>
        </div>
        <div class="readouts w-reads-lg">${big('triple', 'Triple')}${big('pair', 'Pair')}${big('action', 'Action')}</div>
        <p class="w-formula" data-wtex="R@k=\\frac{\\#\\,\\text{GT triples hit under key }k}{\\#\\,\\text{GT triples}},\\qquad mR@k=\\frac{1}{M}\\sum_{m=1}^{M}R_m@k">R@k = hits under key k / number of GT triples;  mR@k = mean of R@k over M tasks</p>
        ${altNote}
        <div class="w-scroll"><table class="w-table w-match">
          <caption>${bi(`${esc(run.model)} (${esc(run.served || '')}), ${run.variant === 'with_base' ? 'with' : 'without'} Base Searcher, run ${run.run}: ${x.n_pred} predicted triples against ${x.n_gt} ground-truth triples`,
            `${esc(run.model)}（${esc(run.served || '')}），${run.variant === 'with_base' ? '有' : '沒有'} Base Searcher，第 ${run.run} 次：預測 ${x.n_pred} 條，對標準答案 ${x.n_gt} 條`)}</caption>
          <thead><tr><th>#</th><th>${bi('Predicted triple', '預測的 triple')}</th><th>${bi('Against', '對上')}</th><th>@T</th><th>@P</th><th>@A</th><th>${bi('Why', '原因')}</th></tr></thead>
          <tbody>${rowsHtml}</tbody></table></div>
        ${missing ? `<div class="w-missing"><h4>${bi(`Ground-truth triples not hit at @Triple (${x.missing.length})`, `@Triple 沒被命中的標準答案（${x.missing.length} 條）`)}</h4><ul>${missing}</ul></div>` : ''}
        <p class="w-note">${tag('Derived')} ${bi('The paper defines R and mR in one sentence and prints no formula (p.5–6). These two lines are our reading. Keys: @Triple = subject, relation, object; @Pair = subject and object, in that direction; @Action = relation plus the two objects in either direction.',
          '論文只用一句話定義 R 與 mR，沒有印公式（p.5–6）。這兩行是我們的讀法。比對鍵：@Triple 是主詞、關係、受詞全對；@Pair 是主詞與受詞（方向要對）；@Action 是關係詞加兩個物件（不分方向）。')}</p>
        <p class="w-note">${bi('This is R for one task (one photo). mR needs several tasks. We have one, so there is no mR here.', '這是一個任務（一張照片）的 R。mR 要多個任務取平均；我們只有一個任務，所以沒有 mR。')}</p>
        <div class="readouts w-reads-sm">
          <div class="readout"><small>${bi('Extra triples', '多輸出的條數')}</small><output>${x.extras}</output><span class="w-frac">${x.n_pred} − ${x.hits.triple} <i>${bi('predicted − hits', '預測 − 命中')}</i></span></div>
          <div class="readout"><small>Precision@Triple</small><output>${fmt(prec)}</output><span class="w-frac">${x.hits.triple} / ${x.n_pred} <i>${bi('hits / predicted', '命中 / 預測條數')}</i></span></div>
          <div class="readout"><small>${bi('Off-list relations', '清單外關係詞')}</small><output>${x.outOfList}</output><span class="w-frac">/ ${x.n_pred} <i>${bi('triples', '條')}</i></span></div>
        </div>
        <p class="w-note">${tag('Derived')} ${tag('My view')} ${bi('Table 1 reports recall only (P51). Recall does not drop when a model writes extra triples, so we add the count of extras and precision. For a robot, each extra triple is one more action.',
          '表 1 只報 Recall（P51）。模型多寫幾條，Recall 不會掉，所以這裡補上多輸出的條數與 precision。對機器人來說，多一條就是多做一個動作。')}</p>
        </div><footer class="panel-src">${bi(`Source: ${esc(run.file)} · ground truth data/sceneB_gt.json (written before any model was run) · scoring js/metrics.js`, `來源：${esc(run.file)}；標準答案 data/sceneB_gt.json（跑模型之前寫的）；計分 js/metrics.js`)}</footer>
      </section>`;
    renderTex();
    const payload = { hits: x.bestHits.triple, n_gt: x.n_gt, n_pred: x.n_pred, set: { ...x.score.set }, ordered: { ...x.score.ordered },
      model: run.model, variant: run.variant, run: run.run, names: state.names, mode: state.mode, precision: prec, extras: x.extras };
    for (const m of ['set', 'ordered']) for (const k of KINDS) bind(`score.${m}.${k}`, x.score[m][k]);
    bind('score.n_pred', x.n_pred); bind('score.n_gt', x.n_gt); bind('score.hits', x.bestHits.triple);
    emit('score:update', payload);
    return payload;
  }

  /* ---------------- view: Table 1 */
  function renderTable1() {
    const cols = [['rT', 'R@Triple', 'T', 0], ['mrT', 'mR@Triple', 'T', 1], ['rP', 'R@Pair', 'P', 0], ['mrP', 'mR@Pair', 'P', 1], ['rA', 'R@Action', 'A', 0], ['mrA', 'mR@Action', 'A', 1]];
    const rows = paper.table1;
    const near = (ri, v) => ri === 0 && Math.abs(v - 60) <= 3;
    const W = 800, H = 330, L = 46, T = 22, B = 60, top = 70;
    const y = v => T + (H - T - B) * (1 - v / top);
    const bw = 22, gap = 4, gw = 6 * bw + 5 * gap, ggap = (W - L - 12 - 4 * gw) / 3;
    let g = '';
    for (const v of [0, 20, 40, 60]) g += S('line', { class: 'w-grid', x1: L, x2: W - 6, y1: y(v), y2: y(v) }) + S('text', { class: 'w-axis', x: L - 8, y: y(v) + 5, 'text-anchor': 'end' }, `${v}%`);
    g += S('line', { class: 'w-ref60', x1: L, x2: W - 6, y1: y(60), y2: y(60) });
    rows.forEach((r, ri) => {
      const x0 = L + 8 + ri * (gw + ggap);
      cols.forEach(([k, label, kind, isMean], ci) => {
        const v = r[k], x = x0 + ci * (bw + gap), hl = near(ri, v) ? 'near' : (ri === 0 && k === 'rT' ? 'low' : '');
        g += S('rect', { class: `w-bar w-bar-${kind}${isMean ? ' w-bar-mean' : ''}`, 'data-hl': hl, x, y: y(v), width: bw, height: y(0) - y(v) }, `<title>${esc(r.model)} ${label}: ${v.toFixed(2)}%</title>`);
        if (hl) g += S('text', { class: 'w-val', 'data-hl': hl, x: x + bw / 2, y: y(v) - 6 - (hl === 'near' && ci % 2 ? 16 : 0), 'text-anchor': 'middle' }, v.toFixed(2));
      });
      r.model.split(' & ').forEach((part, li, all) => { g += S('text', { class: 'w-xlab', x: x0 + gw / 2, y: H - B + 22 + li * 18, 'text-anchor': 'middle' }, esc(part + (li < all.length - 1 ? ' &' : ''))); });
    });
    const legend = [['T', 'Triple'], ['P', 'Pair'], ['A', 'Action']].map(([k, n]) => `<span class="w-key"><i class="w-sw w-bar-${k}"></i>R@${n}</span><span class="w-key"><i class="w-sw w-bar-${k} w-bar-mean"></i>mR@${n}</span>`).join('');
    const nearCells = cols.filter(([k]) => near(0, rows[0][k])).map(([k, label]) => `${label} ${rows[0][k].toFixed(2)}`);
    const table = `<table class="w-table w-num"><caption>${bi('Table 1 as printed (%, 127 assembly diagrams)', '表 1 原數字（%，127 張組裝圖）')}</caption>
      <thead><tr><th>${bi('Model', '模型')}</th>${cols.map(c => `<th>${c[1]}</th>`).join('')}</tr></thead>
      <tbody>${rows.map((r, ri) => `<tr><th scope="row">${esc(r.model)}</th>${cols.map(([k]) => `<td data-hl="${near(ri, r[k]) ? 'near' : (ri === 0 && k === 'rT' ? 'low' : '')}">${r[k].toFixed(2)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    body.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h3 class="panel-name">${bi('Table 1: four models, six columns', '表 1：四個模型、六欄')}</h3><span class="panel-ref">Table 1 · p.6</span>${tag('Paper')}</header><div class="panel-body">
        <div class="w-legend">${legend}<span class="w-key"><i class="w-sw w-sw-line"></i>60%</span></div>
        <svg class="w-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Grouped bars of Table 1: R and mR at Triple, Pair and Action for four models, in percent. The numbers are in the table below.">${g}
          <text class="w-axis" x="${L}" y="14">${'R, mR (%)'}</text></svg>
        <p class="w-callout">${bi(`The text says “approximately 60%” and names no column (P50). In the GPT-4o row, the cells within 3 points of 60 are ${nearCells.join(', ')}. The full-triple column, R@Triple, is ${rows[0].rT.toFixed(2)}.`,
          `正文寫「約 60%」，沒有說是哪一欄（P50）。GPT-4o 那一列裡，離 60 在 3 個百分點內的是 ${nearCells.join('、')}。整條 triple 都對的那一欄 R@Triple 是 ${rows[0].rT.toFixed(2)}。`)}</p>
        <div class="w-scroll">${table}</div>
        </div><footer class="panel-src">${bi('Source: data/paper.json, copied from Table 1 and checked against the PDF. Highlight rule: GPT-4o row, |value − 60| ≤ 3.', '來源：data/paper.json，抄自表 1 並對過 PDF。標示規則：GPT-4o 那一列，|數值 − 60| ≤ 3。')}</footer>
      </section>`;
  }

  /* ---------------- view: Table 2 */
  function renderTable2() {
    const rows = paper.table2, W = 800, H = 300, L = 46, T = 24, B = 46, top = 20;
    const y = v => T + (H - T - B) * (1 - v / top);
    const gw = (W - L - 12) / rows.length, bw = 46;
    let g = '';
    for (const v of [0, 5, 10, 15, 20]) g += S('line', { class: 'w-grid', x1: L, x2: W - 6, y1: y(v), y2: y(v) }) + S('text', { class: 'w-axis', x: L - 8, y: y(v) + 5, 'text-anchor': 'end' }, v);
    rows.forEach((r, i) => {
      const cx = L + gw * (i + 0.5);
      [['without', -bw - 3, 'w-bar-without'], ['with', 3, 'w-bar-with']].forEach(([k, dx, cls]) => {
        g += S('rect', { class: `w-bar ${cls}`, x: cx + dx, y: y(r[k]), width: bw, height: y(0) - y(r[k]) }, `<title>Product ${r.product}, ${k} base: ${r[k]} of 20</title>`);
        g += S('text', { class: 'w-val', x: cx + dx + bw / 2, y: y(r[k]) - 6, 'text-anchor': 'middle' }, r[k]);
      });
      g += S('text', { class: 'w-xlab', x: cx, y: H - B + 24, 'text-anchor': 'middle' }, `Product ${r.product}`);
    });
    const sum = k => rows.reduce((a, r) => a + r[k], 0);
    const n = rows.length * 20;
    body.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h3 class="panel-name">${bi('Table 2: simulated assembly with and without a base', '表 2：有無基準的模擬組裝')}</h3><span class="panel-ref">Table 2 · Eq. (2)(3)</span>${tag('Paper')}</header><div class="panel-body">
        <div class="w-legend"><span class="w-key"><i class="w-sw w-bar-without"></i>${bi('without base', '沒有 base')}</span><span class="w-key"><i class="w-sw w-bar-with"></i>${bi('with base', '有 base')}</span></div>
        <svg class="w-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Paired bars of Table 2: successes out of 20 runs for five products, without and with a base. The numbers are in the table below.">${g}
          <text class="w-axis" x="${L}" y="14">${'successes / 20 runs'}</text></svg>
        <div class="readouts w-reads-sm">
          <div class="readout"><small>${bi('Sum without base', '沒有 base 加總')}</small><output>${sum('without')}</output><span class="w-frac">/ ${n} <i>${rows.map(r => r.without).join(' + ')}</i></span></div>
          <div class="readout"><small>${bi('Sum with base', '有 base 加總')}</small><output>${sum('with')}</output><span class="w-frac">/ ${n} <i>${rows.map(r => r.with).join(' + ')}</i></span></div>
        </div>
        <p class="w-note">${tag('Derived')} ${bi(`The sums ${sum('without')} → ${sum('with')} of ${n} are ours. The paper prints the ten cells only.`, `加總 ${sum('without')} → ${sum('with')}（共 ${n} 次）是我們算的；論文只印十格。`)}</p>
        <div class="w-scroll"><table class="w-table w-num"><caption>${bi('Table 2 as printed (successes out of 20)', '表 2 原數字（20 次中成功次數）')}</caption>
          <thead><tr><th>${bi('Product', '產品')}</th><th>Without base</th><th>With base</th></tr></thead>
          <tbody>${rows.map(r => `<tr><th scope="row">${r.product}</th><td>${r.without} / 20</td><td>${r.with} / 20</td></tr>`).join('')}</tbody></table></div>
        </div><footer class="panel-src">${bi('Source: data/paper.json, copied from Table 2 (p.6). Simulator DiffRedMax, 20 runs per cell.', '來源：data/paper.json，抄自表 2（p.6）。模擬器 DiffRedMax，每格 20 次。')}</footer>
      </section>`;
  }

  /* ---------------- view: Table 3 */
  function renderTable3() {
    const rows = paper.table3, W = 800, rowH = 46, L = 250, T = 30, H = T + rows.length * rowH + 34, R = 70;
    const x = v => L + (W - L - R) * v / 10;
    const keyOf = p => ['red', 'green', 'yellow', 'blue'].find(c => p.includes(c)) || 'white';
    const short = { red: 'R', green: 'G', yellow: 'Y', blue: 'B', white: 'N' };
    let g = '';
    for (let v = 0; v <= 10; v += 2) g += S('line', { class: 'w-grid', x1: x(v), x2: x(v), y1: T - 6, y2: T + rows.length * rowH }) + S('text', { class: 'w-axis', x: x(v), y: T + rows.length * rowH + 20, 'text-anchor': 'middle' }, v);
    rows.forEach((r, i) => {
      const cy = T + i * rowH + rowH / 2, k = keyOf(r.prompt);
      g += S('text', { class: 'w-xlab', x: L - 44, y: cy + 5, 'text-anchor': 'end' }, `${r.step}. ${esc(r.prompt)}`);
      g += S('circle', { class: `w-dot w-part-${k}`, cx: L - 22, cy, r: 13 }) + S('text', { class: 'w-dot-t', x: L - 22, y: cy + 5, 'text-anchor': 'middle' }, short[k]);
      g += S('rect', { class: `w-bar w-part-${k}`, x: x(0), y: cy - 13, width: x(r.success) - x(0), height: 26 }, `<title>Step ${r.step}: ${r.success} of 10</title>`);
      g += S('text', { class: 'w-val', x: x(r.success) + 8, y: cy + 5 }, `${r.success} / 10`);
    });
    const total = rows.reduce((a, r) => a + r.success, 0), over7 = rows.filter(r => r.success > 7).length, eq7 = rows.filter(r => r.success === 7).length;
    body.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h3 class="panel-name">${bi('Table 3: 3D object instance memory, five steps', '表 3：3D 物件實例記憶，五步')}</h3><span class="panel-ref">Table 3 · §4.2</span>${tag('Paper')}</header><div class="panel-body">
        <svg class="w-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Bars of Table 3: successes out of 10 trials for the five text prompts. The numbers are in the table below.">${g}
          <text class="w-axis" x="${L}" y="14">${'successes / 10 trials'}</text></svg>
        <div class="readouts w-reads-sm">
          <div class="readout"><small>${bi('Sum', '加總')}</small><output>${total}</output><span class="w-frac">/ ${rows.length * 10} <i>${rows.map(r => r.success).join(' + ')}</i></span></div>
          <div class="readout"><small>${bi('Rows above 7', '大於 7 的列')}</small><output>${over7}</output><span class="w-frac">/ ${rows.length} <i>${bi(`${eq7} rows are exactly 7`, `${eq7} 列剛好是 7`)}</i></span></div>
        </div>
        <p class="w-note">${tag('Derived')} ${bi(`The sum ${total}/${rows.length * 10} is ours. The text says “over seven”.`, `加總 ${total}/${rows.length * 10} 是我們算的。正文寫「over seven」。`)}</p>
        <p class="w-note">${bi('The table title is about 3D object instance memory from open-vocabulary perception. Success means an accurate 3D instance with movement and rotation values (P86). It does not say the part ended up assembled.', '這張表的標題是開放詞彙感知的 3D 物件實例記憶。成功的定義是產生準確的 3D 實例並給出移動與旋轉值（P86），不是零件有沒有裝上去。')}</p>
        <div class="w-scroll"><table class="w-table w-num"><caption>${bi('Table 3 as printed (successes out of 10)', '表 3 原數字（10 次中成功次數）')}</caption>
          <thead><tr><th>${bi('Step', '步驟')}</th><th>${bi('Text prompt', '文字提示')}</th><th>${bi('Successes', '成功次數')}</th></tr></thead>
          <tbody>${rows.map(r => `<tr><th scope="row">${r.step}</th><td class="w-l">${esc(r.prompt)}</td><td>${r.success} / 10</td></tr>`).join('')}</tbody></table></div>
        </div><footer class="panel-src">${bi('Source: data/paper.json, copied from Table 3 (p.7).', '來源：data/paper.json，抄自表 3（p.7）。')}</footer>
      </section>`;
  }

  /* ---------------- view: Fig. 6 */
  function renderFig6() {
    const tickName = { g: 'green', p: 'purple', c: 'cyan', x: 'grey' };
    const tickZh = { g: '綠', p: '紫', c: '青', x: '灰' };
    const cards = fig6.products.map(p => {
      const s = scoreFig6(p), m = s.match[state.mode];
      const gtRows = p.gt.filter(r => r.legible), prRows = p.pred.filter(r => r.legible);
      const gtList = gtRows.map((r, i) => `<li><span class="w-mono">${i + 1}</span> ${tri(r.t)}${RELATIONS.includes(norm(r.t[1])) ? '' : ` <mark class="w-ool">${bi('off-list relation', '清單外關係詞')}</mark>`}</li>`).join('');
      const prList = prRows.map((r, i) => `<li data-ok="${m[i] >= 0}">
        <span class="w-tick" data-tick="${r.tick}" title="${tickName[r.tick]} mark on the figure">${r.tick.toUpperCase()}</span>
        <span class="w-mono">${i + 1}</span> ${tri(r.t)}
        <span class="w-verdict" data-ok="${m[i] >= 0}">${m[i] >= 0 ? `✓ GT ${m[i] + 1}` : '✗'}</span></li>`).join('');
      const d = s.set.triple - s.ordered.triple;
      const hitsOf = v => Math.round(v * s.n_gt);
      return `<article class="w-fig6">
        <h4>${esc(p.label)}</h4>
        <div class="readouts w-reads-sm">
          <div class="readout" data-on="${state.mode === 'set'}"><small>${bi('R@Triple, as a set', 'R@Triple，當集合')}</small><output>${fmt(s.set.triple)}</output><span class="w-frac">${hitsOf(s.set.triple)} / ${s.n_gt}</span></div>
          <div class="readout" data-on="${state.mode === 'ordered'}"><small>${bi('R@Triple, in order', 'R@Triple，依序對位')}</small><output>${fmt(s.ordered.triple)}</output><span class="w-frac">${hitsOf(s.ordered.triple)} / ${s.n_gt}</span></div>
          <div class="readout"><small>${bi('Difference', '差')}</small><output>${fmt(d)}</output><span class="w-frac">${hitsOf(s.set.triple)} − ${hitsOf(s.ordered.triple)} <i>${bi('triples', '條')}</i></span></div>
          <div class="readout"><small>${bi('Green marks on the figure', '圖上的綠勾')}</small><output>${s.ticks.g || 0}</output><span class="w-frac">/ ${s.n_pred}</span></div>
        </div>
        <div class="w-fig6-cols">
          <div><h5>${bi('Ground truth', '標準答案')}</h5><ol class="w-list">${gtList}</ol></div>
          <div><h5>${bi('Predicted, with the printed mark and our verdict', '預測：圖上的勾色＋我們算的結果')}</h5><ol class="w-list">${prList}</ol></div>
        </div>
        <p class="w-note">${bi(`Pair / Action as a set: ${fmt(s.set.pair)} / ${fmt(s.set.action)}; in order: ${fmt(s.ordered.pair)} / ${fmt(s.ordered.action)}.`, `Pair／Action 當集合：${fmt(s.set.pair)}／${fmt(s.set.action)}；依序對位：${fmt(s.ordered.pair)}／${fmt(s.ordered.action)}。`)}
          ${s.gtOutOfList.length ? bi(`The ground truth itself uses “${esc(s.gtOutOfList.join(', '))}”, which is not in the Fig. 5 list (P56).`, `標準答案自己用了「${esc(s.gtOutOfList.join('、'))}」，不在圖 5 的清單裡（P56）。`) : ''}</p>
      </article>`;
    }).join('');
    const excluded = fig6.products.flatMap(p => scoreFig6(p).excluded);
    const ticks = Object.entries(fig6.tick_legend).map(([k, v]) => `<span class="w-key"><span class="w-tick" data-tick="${k}">${k.toUpperCase()}</span>${bi(tickName[k], tickZh[k])}</span>`).join('');
    body.innerHTML = `
      <section class="panel">
        <header class="panel-head"><h3 class="panel-name">${bi('Fig. 6: two examples, row by row', '圖 6：兩件例子逐條對照')}</h3><span class="panel-ref">Fig. 6 · p.6</span>${tag('Paper')}${tag('Derived')}</header><div class="panel-body">
        <div class="w-controls"><span class="w-field"><span>${bi('Reading', '讀法')}</span>${modeSeg()}</span><div class="w-legend">${ticks}</div></div>
        <p class="w-note">${bi('The marks G, P, C, X are the colours printed on the figure. The ✓ and ✗ and the scores are computed here with js/metrics.js under the chosen reading. The paper prints no score for these two examples.',
          'G、P、C、X 是圖上印的勾色。✓、✗ 與分數是這裡用 js/metrics.js 依選的讀法算的；論文沒有印這兩件例子的分數。')}</p>
        ${cards}
        <p class="w-note">${bi('In the right example the grey row is a ground-truth triple moved two rows up. Read as a set it counts; read in order it does not, and neither does row 7, which the figure marks green (P55).',
          '右件的灰勾是一條標準答案被往前移了兩列。當集合讀它算對；依序對位它算錯，圖上打綠勾的第 7 條也算錯（P55）。')}</p>
        <p class="w-note">${bi(`Rows left out of the calculation: ${excluded.length ? esc(excluded.join(', ')) : 'none; all 34 rows are legible'}. To be checked: ${esc(fig6.pending.map(x => x.where).join('; '))} (too small to read; not used in any score).`,
          `排除在計算外的列：${excluded.length ? esc(excluded.join('、')) : '沒有，34 列都看得清楚'}。待核對：左件圖內的零件表數量與標題欄（字太小；沒有用在任何分數）。`)}</p>
        </div><footer class="panel-src">${bi('Source: data/fig6.json, transcribed from media/figures/fig6.jpg (Fig. 6, p.6 © Elsevier).', '來源：data/fig6.json，從 media/figures/fig6.jpg 逐條抄出（圖 6，p.6 © Elsevier）。')}</footer>
      </section>`;
  }

  function renderTex() {
    const k = ctx.katex;
    if (!k?.render) return;
    body.querySelectorAll('[data-wtex]').forEach(n => { try { k.render(n.dataset.wtex, n, { throwOnError: false, displayMode: true }); } catch { /* keep the text fallback */ } });
  }

  const views = { run: renderRun, table1: renderTable1, table2: renderTable2, table3: renderTable3, fig6: renderFig6 };
  function render() {
    nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    const out = views[state.view]();
    body.dataset.view = state.view;
    return out;
  }

  nav.addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) { state.view = b.dataset.view; render(); } });
  body.addEventListener('click', e => {
    const b = e.target.closest('button[data-set]');
    if (!b) return;
    state[b.dataset.set] = b.dataset.value;
    render();
    body.querySelector(`button[data-set="${b.dataset.set}"][data-value="${b.dataset.value}"]`)?.focus();
  });
  body.addEventListener('change', e => { if (e.target.matches('select[data-role="run"]')) { state.run = e.target.value; render(); body.querySelector('select[data-role="run"]')?.focus(); } });

  function act(action, args) {
    const parts = [action, ...(Array.isArray(args) ? args : args != null ? [args] : [])].join(':').split(':');
    const [a, ...rest] = parts;
    if (a === 'run') {
      const id = rest.join(':');
      if (runs.some(r => runId(r) === id)) state.run = id;
      state.view = 'run';
    } else if (a === 'mode' && ['set', 'ordered'].includes(rest[0])) state.mode = rest[0];
    else if (a === 'names' && ['strict', 'colourblind'].includes(rest[0])) state.names = rest[0];
    else if (views[a]) state.view = a;
    else return false;
    render();
    return true;
  }

  render();
  return { act, onShow() { if (state.view === 'run') renderRun(); }, onHide() {}, state };
}
