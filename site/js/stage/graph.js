// Stage tab "Graph": the scene graph G_t = (N_t, E_t) drawn as SVG with a fixed layout (no graph library).
// Nodes are objects, edges are directed and carry the predicate. Sources: our ground truth for the desk scene
// (data/sceneB_gt.json), any local VLM run (data/vlm/summary.json) and the five triples of Fig. 7 (lab/config.js).
import { RELATIONS, norm, canonEntity } from '../metrics.js';
import { explainRun } from './scores.js';
import { PAPER_PLAN, PARTS, FIXTURES } from '../lab/config.js';

const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (en, zh) => `<span class="en" lang="en">${en}</span><span class="zh" lang="zh-Hant">${zh}</span>`;
const tag = t => `<span class="tag" data-tag="${t}">${t}</span>`;
const tri = t => `<span class="w-t">⟨${esc(t[0])}, <b>${esc(t[1])}</b>, ${esc(t[2])}⟩</span>`;
const getJSON = async p => { const r = await fetch(new URL(`../../data/${p}`, import.meta.url)); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const runId = r => `${r.model}/${r.variant}/${r.run}`;

// Desk scene (scene 2): nine parts in three assembly regions. Colour = region; the two-letter code names the part.
const DESK = [
  { id: 'black ink refill', ab: 'Rk', region: 'k' }, { id: 'black rubber front grip', ab: 'Gk', region: 'k' },
  { id: 'purple ink refill', ab: 'Rp', region: 'r' }, { id: 'red rubber front grip', ab: 'Gr', region: 'r' },
  { id: 'pen barrel with black clip', ab: 'Bk', region: 'k', base: true }, { id: 'pen barrel with red clip', ab: 'Br', region: 'r', base: true },
  { id: 'threaded cap', ab: 'Th', region: 's' }, { id: 'stud cap', ab: 'St', region: 's' }, { id: 'spinner body with bearing', ab: 'Sp', region: 's', base: true },
];
const PATHS = [['pen barrel with black clip', 'black ink refill', 'black rubber front grip'], ['pen barrel with red clip', 'purple ink refill', 'red rubber front grip'], ['spinner body with bearing', 'stud cap', 'threaded cap']];
const GEAR = [...PARTS.map(p => ({ id: p.name, ab: p.short, region: p.key })), ...FIXTURES.map(f => ({ id: f.name, ab: f.short, region: f.key, base: true }))];

// Fixed coordinates (node centres) for the two widths. Same nodes, same places, every time.
const LAYOUT = {
  wide: { W: 820, nw: 150, nh: 54,
    desk: { Rk: [85, 44], Gk: [245, 44], Rp: [405, 44], Gr: [565, 44], Bk: [165, 205], Br: [485, 205], Th: [735, 44], St: [735, 205], Sp: [735, 366], amb: [325, 205] },
    slots: [[85, 366], [245, 366], [405, 366], [565, 366], [85, 446], [245, 446], [405, 446], [565, 446]], H: 410,
    pens: { Rk: [190, 70], Gk: [630, 70], Bk: [410, 290] }, pensH: 350,
    gear: { N: [410, 44], B: [410, 156], R: [150, 280], G: [410, 280], Y: [670, 280], C: [410, 420] }, gearH: 470 },
  narrow: { W: 420, nw: 130, nh: 58,
    desk: { Rk: [66, 46], Gk: [200, 46], Bk: [133, 190], Rp: [66, 330], Gr: [200, 330], Br: [133, 474], Th: [352, 46], St: [352, 260], Sp: [352, 474], amb: [133, 590] },
    slots: [[66, 590], [280, 590], [66, 680], [200, 680], [334, 680], [66, 770], [200, 770], [334, 770]], H: 520,
    pens: { Rk: [80, 60], Gk: [340, 60], Bk: [210, 270] }, pensH: 330,
    gear: { N: [210, 40], B: [210, 150], R: [70, 290], G: [210, 290], Y: [350, 290], C: [210, 440] }, gearH: 490 },
};

function wrap(label, max, maxLines = 2) {
  const words = label.split(' '), lines = [''];
  for (const w of words) { const cur = lines[lines.length - 1]; if (cur && (cur + ' ' + w).length > max) lines.push(w); else lines[lines.length - 1] = cur ? cur + ' ' + w : w; }
  if (lines.length > maxLines) { lines[maxLines - 1] = lines.slice(maxLines - 1).join(' '); lines.length = maxLines; if (lines[maxLines - 1].length > max + 2) lines[maxLines - 1] = lines[maxLines - 1].slice(0, max + 1) + '…'; }
  return lines;
}

/** Point where the segment from the centre of a w×h box towards (tx, ty) leaves the box. */
function edgeOfBox(c, w, h, tx, ty, pad = 3) {
  const dx = tx - c[0], dy = ty - c[1];
  if (!dx && !dy) return [...c];
  const s = Math.min((w / 2 + pad) / Math.abs(dx || 1e-9), (h / 2 + pad) / Math.abs(dy || 1e-9));
  return [c[0] + dx * s, c[1] + dy * s];
}

export async function mount(el, ctx = {}) {
  const [summary, gt] = await Promise.all([getJSON('vlm/summary.json'), getJSON('sceneB_gt.json')]);
  const runs = summary.runs.filter(r => r.scene === 'B' && r.pred);
  const defaultRun = runId(runs.find(r => r.model === 'gpt-4o' && r.variant === 'with_base') || runs[0]);
  const state = { mode: 'build', source: 'gt', run: defaultRun, t: gt.gts[0].length, asSet: false, pens: 0, narrow: false, fresh: -1 };
  let timer = null;
  const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

  el.classList.add('w', 'w-graph');
  el.innerHTML = `
    <div class="w-nav" role="group" aria-label="Graph views">
      <button type="button" data-mode="pens">${bi('Triple', 'Triple')}</button>
      <button type="button" data-mode="build">${bi('Build G_t', '逐條長出 G_t')}</button>
      <button type="button" data-mode="base">${bi('Base σ', '基準 σ')}</button>
      <button type="button" data-mode="path">${bi('Path ϱ', '路徑 ϱ')}</button>
      <button type="button" data-mode="gt">${bi('vs ground truth', '對標準答案')}</button>
      <button type="button" data-mode="gear">${bi('Gearbox', '齒輪箱')}</button>
    </div>
    <section class="panel">
      <header class="panel-head"><h3 class="panel-name" data-role="title"></h3><span class="panel-ref" data-role="eqref"></span><span data-role="tags"></span></header><div class="panel-body">
      <div class="w-controls" data-role="controls"></div>
      <div class="w-graph-grid">
        <div class="w-graph-canvas"><svg data-role="svg" role="img"></svg><p class="w-gt-line" data-role="gline" aria-live="polite"></p></div>
        <div class="w-graph-side" data-role="side"></div>
      </div>
      <div data-role="notes"></div>
      </div><footer class="panel-src" data-role="src"></footer>
    </section>`;
  const $ = r => el.querySelector(`[data-role="${r}"]`);
  const nav = el.querySelector('.w-nav');

  const runOf = id => runs.find(r => runId(r) === id);
  const canonName = n => canonEntity(n, gt.aliases);
  /** Triples of the current source, each as { raw, canon, status }. */
  function triples() {
    if (state.mode === 'gear') return PAPER_PLAN.map(t => ({ raw: t, canon: t }));
    if (state.mode === 'pens') return gt.gts[0].slice(0, 2).map(t => ({ raw: t, canon: t }));
    if (state.mode === 'base' || state.mode === 'path') return gt.gts[0].map(t => ({ raw: t, canon: t }));
    if (state.mode === 'gt') {
      const run = runOf(state.run), x = explainRun(run.pred, gt, { names: 'strict', mode: 'set' });
      const out = x.rows.map(r => ({ raw: r.raw, canon: r.canon, status: r.hit.triple ? 'ok' : 'extra', n: r.i + 1 }));
      for (const i of x.missing) out.push({ raw: gt.gts[x.alt][i], canon: x.G[i], status: 'missing', n: i + 1 });
      return out;
    }
    const src = state.source === 'gt' ? gt.gts[0] : runOf(state.source).pred;
    return src.map(t => ({ raw: t, canon: [canonName(t[0]), norm(t[1]), canonName(t[2])] }));
  }

  function draw() {
    const L = LAYOUT[state.narrow ? 'narrow' : 'wide'];
    const gear = state.mode === 'gear', pens = state.mode === 'pens';
    const T = triples();
    const stepped = state.mode === 'build' || gear;
    const shown = stepped && !state.asSet ? T.slice(0, state.t) : T;
    const defs = gear ? GEAR : DESK;
    const pos = gear ? L.gear : pens ? L.pens : L.desk;
    // nodes: the fixed ones, plus names from a model reply that map to no single part
    const nodes = new Map();
    for (const d of defs) { if (pos[d.ab]) nodes.set(d.id, { ...d, c: pos[d.ab] }); }
    let slot = 0;
    if (!gear && !pens) for (const t of T) for (const name of [t.canon[0], t.canon[2]]) {
      if (nodes.has(name)) continue;
      const amb = name === 'pen barrel' || name === 'pen barrels';
      nodes.set(name, { id: name, ab: amb ? 'B?' : '?', region: 'x', extra: true, c: amb && !nodes.has('pen barrel') && !nodes.has('pen barrels') ? L.desk.amb : L.slots[slot++ % L.slots.length] });
    }
    const maxY = Math.max(...[...nodes.values()].map(n => n.c[1])) + (state.mode === 'path' ? 14 : 0);
    let H = Math.max(gear ? L.gearH : pens ? L.pensH : L.H, maxY + L.nh / 2 + 16);
    const touched = new Set(shown.flatMap(t => [t.canon[0], t.canon[2]]));
    const pathNodes = new Map();
    if (state.mode === 'path') PATHS.forEach(p => p.forEach((id, i) => pathNodes.set(id, i + 1)));

    // edges
    const seen = {}, placed = [];
    const boxes = [...nodes.values()].map(n => [n.c[0] - L.nw / 2 - 2, n.c[1] - L.nh / 2 - 2, n.c[0] + L.nw / 2 + 2, n.c[1] + L.nh / 2 + 2]);
    const hits = r => [...boxes, ...placed].filter(b => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1]).length;
    let edgesSvg = '', loopBottom = 0;
    // the same triple written twice becomes one arrow that carries both step numbers
    const groups = new Map();
    shown.forEach((t, i) => {
      const key = `${t.canon.join('|')}|${t.status || ''}`;
      if (!groups.has(key)) groups.set(key, { t, i, ns: [], fresh: false });
      const g = groups.get(key);
      g.ns.push(t.n ?? i + 1);
      if (stepped && !state.asSet && i === state.fresh) g.fresh = true;
    });
    [...groups.values()].forEach(({ t, i, ns, fresh }) => {
      const a = nodes.get(t.canon[0]), b = nodes.get(t.canon[2]);
      if (!a || !b) return;
      const pairKey = [a.id, b.id].sort().join('|'), k = (seen[pairKey] = (seen[pairKey] || 0) + 1) - 1;
      const status = t.status || '';
      const isNew = fresh;
      const hl = pens && (state.pens === 1 || state.pens === 4) && (state.pens === 4 || i === 0);
      const dimmed = pens && state.pens < 3 && i > 0;
      const off = !RELATIONS.includes(norm(t.canon[1]));
      const n = ns.join(', ');
      const numbered = !state.asSet && !pens && state.mode !== 'base';
      const label = status === 'missing' ? `GT ${n} −` : `${numbered ? `${n}  ` : ''}${t.canon[1]}${status === 'ok' ? ' ✓' : status === 'extra' ? ' +' : ''}`;
      const lw = label.length * 8.6 + 10, lh = 22;
      const rectAt = (x, y) => [x - lw / 2, y - lh / 2, x + lw / 2, y + lh / 2];
      const clampX = x => Math.max(lw / 2 + 4, Math.min(L.W - lw / 2 - 4, x));
      let d, lx, ly, ax, ay, ang;
      if (a === b) { // self-loop under the node
        const x = a.c[0], y = a.c[1] + L.nh / 2, dx = 22 + k * 12, depth = 46 + k * 22;
        d = `M${x + dx},${y + 2} C${x + dx + 26},${y + depth} ${x - dx - 26},${y + depth} ${x - dx},${y + 5}`;
        lx = clampX(x); ly = y + depth + 6; ax = x - dx; ay = y + 5; ang = Math.atan2(-depth, 26) ;
        loopBottom = Math.max(loopBottom, ly + 18);
      } else {
        const mx = (a.c[0] + b.c[0]) / 2, my = (a.c[1] + b.c[1]) / 2, dx = b.c[0] - a.c[0], dy = b.c[1] - a.c[1], len = Math.hypot(dx, dy);
        // bend parallel edges apart; bend long same-column or same-row edges so they pass beside the nodes in between
        const skip = (Math.abs(dx) < 4 && Math.abs(dy) > L.nh * 4) || (Math.abs(dy) < 4 && Math.abs(dx) > L.nw * 2.1);
        const sign = a.id < b.id ? 1 : -1;
        const bend = (skip ? (Math.abs(dx) < 4 ? -(L.nw / 2 + 30) : 60) : 0) + sign * (k === 0 ? 0 : Math.ceil(k / 2) * 36 * (k % 2 ? 1 : -1));
        const cx = mx - dy / len * bend, cy = my + dx / len * bend;
        const p0 = edgeOfBox(a.c, L.nw, L.nh, cx, cy), p1 = edgeOfBox(b.c, L.nw, L.nh, cx, cy, 5);
        d = `M${p0[0].toFixed(1)},${p0[1].toFixed(1)} Q${cx.toFixed(1)},${cy.toFixed(1)} ${p1[0].toFixed(1)},${p1[1].toFixed(1)}`;
        // put the label where it covers no node and no earlier label: try several places along the curve
        let best = null;
        search: for (const side of [0, -17, 17, -34, 34]) for (const tt of [0.5, 0.38, 0.62, 0.27, 0.73, 0.17, 0.83]) {
          const u = 1 - tt, x = clampX(u * u * p0[0] + 2 * u * tt * cx + tt * tt * p1[0] - dy / len * side), y = u * u * p0[1] + 2 * u * tt * cy + tt * tt * p1[1] + dx / len * side;
          const h = hits(rectAt(x, y)) + (side ? 0.5 : 0);
          if (!best || h < best.h) best = { x, y, h };
          if (h < 1) break search;
        }
        lx = best.x; ly = best.y;
        ax = p1[0]; ay = p1[1]; ang = Math.atan2(p1[1] - cy, p1[0] - cx);
      }
      placed.push(rectAt(lx, ly));
      const head = [[0, 0], [-13, -6], [-13, 6]].map(([x, y]) => `${(ax + x * Math.cos(ang) - y * Math.sin(ang)).toFixed(1)},${(ay + x * Math.sin(ang) + y * Math.cos(ang)).toFixed(1)}`).join(' ');
      edgesSvg += `<g class="w-edge" data-status="${status}" data-region="${a.region}"${isNew ? ' data-new' : ''}${hl ? ' data-hl' : ''}${dimmed ? ' data-dim' : ''}${off ? ' data-off' : ''}>
        <path d="${d}" pathLength="1"/><polygon points="${head}"/>
        <text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" text-anchor="middle">${esc(label)}</text></g>`;
    });

    // path ϱ as a soft line through the node centres, drawn under everything
    let pathSvg = '';
    if (state.mode === 'path') for (const p of PATHS) pathSvg += `<polyline class="w-path" points="${p.map(id => nodes.get(id).c.join(',')).join(' ')}"/>`;

    // nodes
    let nodesSvg = '';
    for (const n of nodes.values()) {
      const [x, y] = n.c, x0 = x - L.nw / 2, y0 = y - L.nh / 2;
      const lines = state.narrow ? wrap(n.id, Math.floor((L.nw - 48) / 6.6), 3) : wrap(n.id, Math.floor((L.nw - 50) / 7.3));
      const lineY = k => y + 5 + (k - (lines.length - 1) / 2) * (state.narrow ? 15 : 19);
      const isS = pens && state.pens === 0 && n.id === T[0].canon[0], isO = pens && state.pens === 2 && n.id === T[0].canon[2];
      const hl = isS || isO || (pens && state.pens === 3) || ((state.mode === 'base' || state.mode === 'path') && n.base);
      const idle = stepped && !state.asSet && !touched.has(n.id);
      const role = isS ? 'ŝ' : isO ? 'ô' : '';
      const badge = (state.mode === 'base' || state.mode === 'path') && n.base ? 'σ' : '';
      const rk = pathNodes.get(n.id);
      nodesSvg += `<g class="w-node" data-region="${n.region}"${n.extra ? ' data-extra' : ''}${hl ? ' data-hl' : ''}${idle ? ' data-idle' : ''}>
        <rect x="${x0}" y="${y0}" width="${L.nw}" height="${L.nh}" rx="9"/>
        <circle cx="${x0 + 25}" cy="${y}" r="17"/><text class="w-ab" x="${x0 + 25}" y="${y + 5}" text-anchor="middle">${esc(n.ab)}</text>
        ${lines.map((s, i) => `<text class="w-nl" x="${x0 + (state.narrow ? 46 : 49)}" y="${lineY(i).toFixed(1)}">${esc(s)}</text>`).join('')}
        ${badge ? `<g class="w-badge"><circle cx="${x0 + L.nw - 6}" cy="${y0 + 4}" r="14"/><text x="${x0 + L.nw - 6}" y="${y0 + 9}" text-anchor="middle">${badge}</text></g>` : ''}
        ${rk ? `<text class="w-rk" x="${x0 + 4}" y="${rk === 1 ? y0 + L.nh + 17 : y0 - 7}">r${rk}${rk === 1 ? ' = σ' : ''}</text>` : ''}
        ${role ? `<text class="w-rk" x="${x}" y="${y0 - 8}" text-anchor="middle">${role}</text>` : ''}
        <title>${esc(n.id)}${n.extra ? ' (name from the model reply; maps to no single part)' : ''}</title></g>`;
    }
    const svg = $('svg');
    H = Math.max(H, loopBottom);
    svg.setAttribute('viewBox', `0 0 ${L.W} ${H}`);
    svg.toggleAttribute('data-narrow', state.narrow);
    svg.setAttribute('aria-label', `Scene graph with ${nodes.size} nodes and ${shown.length} edges: ${shown.map(t => t.canon.join(' ')).join('; ')}`);
    svg.innerHTML = pathSvg + edgesSvg + nodesSvg;
    return { T, shown, nodes };
  }

  function render() {
    const m = state.mode, gear = m === 'gear', pens = m === 'pens', stepped = m === 'build' || gear;
    nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.mode === m)));
    const titles = {
      pens: bi('One triple, then a graph', '一條 triple，接著一張圖'), build: bi('Edges join one step at a time', '邊一步一步加進來'),
      base: bi('One base per assembly region', '每個組裝區一個基準'), path: bi('The path from each base', '從基準出發的路徑'),
      gt: bi('Predicted against ground truth', '預測對標準答案'), gear: bi('The five triples of Fig. 7', '圖 7 的五條 triple'),
    };
    $('title').innerHTML = titles[m];
    $('eqref').textContent = { pens: 'G = (N, E) · Eq. (1)', build: 'G_t = (N_t, E_t) · Eq. (1)', base: 'Eq. (2)', path: 'Eq. (2)(3)', gt: 'R@Triple', gear: 'Fig. 7 · §4.2' }[m];
    $('tags').innerHTML = gear ? tag('Paper') : (m === 'build' && state.source === 'gt') || pens ? tag('Local run') + tag('My view') : tag('Local run');
    const n = triples().length;
    if (state.t > n) state.t = n;
    const opts = `<option value="gt"${state.source === 'gt' ? ' selected' : ''}>Ground truth (sceneB_gt.json)</option>` + runs.map(r => `<option value="${runId(r)}">${esc(r.model)} · ${r.variant === 'with_base' ? 'with base' : 'without base'} · run ${r.run}</option>`).join('');
    const runOpts = sel => runs.filter(r => m !== 'base' && m !== 'path' || r.base).map(r => `<option value="${runId(r)}"${runId(r) === sel ? ' selected' : ''}>${esc(r.model)} · ${r.variant === 'with_base' ? 'with base' : 'without base'} · run ${r.run}</option>`).join('');
    let c = '';
    if (m === 'build') c += `<label class="w-field"><span>${bi('Source', '來源')}</span><select data-ctl="source" aria-label="Triple source">${opts}</select></label>`;
    if (m === 'gt' || m === 'base' || m === 'path') c += `<label class="w-field"><span>${bi('Run', '實跑')}</span><select data-ctl="run" aria-label="Run">${runOpts(state.run)}</select></label>`;
    if (stepped) c += `<span class="w-field"><span>t</span><span class="w-stepper">
        <button type="button" data-ctl="prev" aria-label="Previous step">‹</button>
        <input type="range" data-ctl="t" min="0" max="${n}" step="1" value="${state.t}" aria-label="Time step t" aria-valuetext="t = ${state.t} of ${n}"${state.asSet ? ' disabled' : ''}>
        <button type="button" data-ctl="next" aria-label="Next step">›</button>
        <button type="button" data-ctl="play" class="btn">${timer ? 'Pause' : 'Play'}</button></span></span>`;
    if (stepped) c += `<span class="w-field"><span>Eq. (1)</span><span class="w-seg" role="group" aria-label="Read Eq. (1) as">
        <button type="button" data-ctl="seq" aria-pressed="${!state.asSet}">${bi('as a sequence', '當序列')}</button>
        <button type="button" data-ctl="set" aria-pressed="${state.asSet}">${bi('as a set', '當集合')}</button></span></span>`;
    if (pens) c += `<span class="w-seg" role="group" aria-label="Highlight">${[['ŝ subject', 'ŝ 主詞'], ['p̂ predicate', 'p̂ 謂詞'], ['ô object', 'ô 受詞'], ['N nodes', 'N 節點'], ['E edges', 'E 邊']].map(([en, zh], i) =>
      `<button type="button" data-ctl="pens" data-i="${i}" aria-pressed="${state.pens === i}">${bi(en, zh)}</button>`).join('')}</span>`;
    $('controls').innerHTML = c;
    if (m === 'build') $('controls').querySelector('[data-ctl="source"]').value = state.source;

    const { T, shown, nodes } = draw();
    // G_t line
    const N = [...nodes.keys()];
    if (pens) {
      const t0 = T[0].canon, part = ['ŝ', 'p̂', 'ô'];
      $('gline').innerHTML = state.pens < 3
        ? `⟨ŝ, p̂, ô⟩ = ⟨${t0.map((s, i) => i === state.pens ? `<mark>${esc(s)}</mark>` : esc(s)).join(', ')}⟩ &nbsp; ${part[state.pens]} = <b>${esc(t0[state.pens])}</b>`
        : state.pens === 3 ? `N = {${N.map(esc).join(', ')}} &nbsp; |N| = ${N.length}` : `E = {${T.map(t => `${esc(t.canon[0])} →[${esc(t.canon[1])}] ${esc(t.canon[2])}`).join(', ')}} &nbsp; |E| = ${T.length}`;
    } else {
      const tt = stepped && !state.asSet ? state.t : shown.length;
      $('gline').innerHTML = stepped ? `G<sub>${state.asSet ? '' : tt}</sub> = (N, E) &nbsp; |N| = ${N.length} &nbsp; |E<sub>${state.asSet ? '' : tt}</sub>| = ${shown.length}`
        : `G = (N, E) &nbsp; |N| = ${N.length} &nbsp; |E| = ${shown.length}`;
    }

    // side list
    let side = '';
    if (m === 'gt') {
      const cnt = s => T.filter(t => t.status === s).length;
      side = `<div class="w-legend"><span class="w-key"><i class="w-sw w-st-ok"></i>✓ ${bi(`in both (${cnt('ok')})`, `兩邊都有（${cnt('ok')}）`)}</span><span class="w-key"><i class="w-sw w-st-extra"></i>+ ${bi(`predicted only (${cnt('extra')})`, `只有預測有（${cnt('extra')}）`)}</span><span class="w-key"><i class="w-sw w-st-missing"></i>− ${bi(`ground truth only (${cnt('missing')})`, `只有標準答案有（${cnt('missing')}）`)}</span></div>
        <ol class="w-list w-tlist">${T.map(t => `<li data-status="${t.status}"><span class="w-mono">${t.status === 'missing' ? 'GT ' : ''}${t.n}</span> ${tri(t.raw)}</li>`).join('')}</ol>`;
    } else if (m === 'base' || m === 'path') {
      const run = runOf(state.run), reply = run?.base || '';
      const names = [...DESK.map(d => d.id)].sort((a, b) => b.length - a.length);
      const re = new RegExp(`(${names.map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
      side = `<h4>${bi('Base Searcher reply (first 1200 characters)', 'Base Searcher 的回覆（前 1200 字）')}</h4>
        <pre class="w-pre w-pre-sm" tabindex="0">${esc(reply).replace(re, '<mark>$1</mark>')}${reply.length >= 1200 ? '…' : ''}</pre>
        <p class="w-note">${bi(`${esc(runId(run))}. Part names from the list are marked. The full prompt and reply are on the Real tab.`, `${esc(runId(run))}。清單裡的零件名有標出。完整的提示詞與回覆在 Real 分頁。`)}</p>`;
    } else {
      const items = state.asSet && stepped ? [...T].sort((a, b) => a.canon.join().localeCompare(b.canon.join())) : T;
      const tagName = state.asSet && stepped ? 'ul' : 'ol';
      side = `<${tagName} class="w-list w-tlist${state.asSet && stepped ? ' w-unordered' : ''}">${items.map(t => {
        const i = T.indexOf(t), on = !stepped || state.asSet || i < state.t, cur = stepped && !state.asSet && i === state.t - 1;
        const off = !RELATIONS.includes(norm(t.canon[1]));
        return `<li${on ? '' : ' data-pending'}${cur ? ' aria-current="step"' : ''}>${state.asSet && stepped ? '' : `<span class="w-mono">t = ${i + 1}</span> `}${tri(t.raw)}${off ? ` <mark class="w-ool">${bi('off-list', '清單外')}</mark>` : ''}</li>`;
      }).join('')}</${tagName}>`;
    }
    $('side').innerHTML = side;

    // notes
    const notes = [];
    if (pens) notes.push(bi('A triple is ⟨subject, predicate, object⟩. Each object is a node. Each triple is one arrow from its subject to its object, and the predicate is written on the arrow. N is the set of nodes and E the set of arrows.',
      'triple 是 ⟨主詞, 謂詞, 受詞⟩。每個物件是一個節點；一條 triple 是從主詞指向受詞的一支箭頭，謂詞寫在箭頭上。N 是節點的集合，E 是箭頭的集合。'));
    if (stepped && !state.asSet) notes.push(bi('Sequence reading: edge t is added at time step t, so G_t holds the first t edges. The numbers on the arrows are t.', '序列讀法：第 t 條邊在時間步 t 加入，所以 G_t 有前 t 條邊。箭頭上的數字就是 t。'));
    if (stepped && state.asSet) notes.push(`${tag('Mismatch')} ${bi('Set reading: Eq. (1) is printed as a union ⋃ of sets { }. A set has no first or second element, so the numbers disappear and the list has no order. The robot still needs the order (P11).',
      '集合讀法：式 (1) 印成集合 { } 的聯集 ⋃。集合沒有第一個、第二個，所以編號消失，清單也沒有順序。可是機器人需要順序（P11）。')}`);
    if (m === 'build' && state.source !== 'gt') notes.push(bi('Dashed grey nodes are names from the model reply that map to no single part in the list (for example “pen barrel” without a colour).', '灰色虛線節點是模型回覆裡對不上單一零件的名稱（例如沒寫顏色的「pen barrel」）。'));
    if (m === 'base' || m === 'path') notes.push(`${tag('My view')} ${bi('σ marks our reading for the desk scene: one base per assembly region (the two pen barrels and the spinner body). The paper does not say how one σ is picked from the candidates (P26).',
      'σ 標的是我們對桌面場景的讀法：每個組裝區一個基準（兩支筆管與陀螺本體）。論文沒有寫怎麼從候選裡選出唯一的 σ（P26）。')}`);
    if (m === 'path') notes.push(bi('ϱ is the order in which objects are visited from the base: r1 = σ, then r2, r3. Eq. (2) prints it as {r1, → …, → r_j}; Eq. (3) then re-narrates the steps along σ → ϱ.',
      'ϱ 是從基準出發依序走到的物件：r1 = σ，接著 r2、r3。式 (2) 印成 {r1, → …, → r_j}；式 (3) 再沿 σ → ϱ 重排步驟。'));
    if (m === 'gt') notes.push(bi('Strict names, set reading, @Triple. An edge counts only when subject, relation and object all match. Switch names or order on the Scores tab.', '嚴格名稱、集合讀法、@Triple：主詞、關係、受詞全對才算。名稱與順序的其他讀法在 Scores 分頁切換。'));
    if (gear) notes.push(bi('Steps 1–3 attach to the white cover. Step 4 attaches the blue gear to the green gear, and step 5 the nut to the blue gear (Fig. 7, top row).', '第 1–3 步接到 white cover；第 4 步把藍齒輪接到綠齒輪；第 5 步把螺帽接到藍齒輪（圖 7 最上列）。'));
    $('notes').innerHTML = notes.map(s => `<p class="w-note">${s}</p>`).join('');
    $('src').innerHTML = gear ? bi('Source: PAPER_PLAN in js/lab/config.js, copied from Fig. 7 (p.7).', '來源：js/lab/config.js 的 PAPER_PLAN，抄自圖 7（p.7）。')
      : m === 'build' && state.source !== 'gt' || m === 'gt' ? bi(`Source: ${esc(runOf(m === 'gt' ? state.run : state.source).file)} · data/sceneB_gt.json`, `來源：${esc(runOf(m === 'gt' ? state.run : state.source).file)}、data/sceneB_gt.json`)
      : bi('Source: data/sceneB_gt.json, written by the presenter before any model was run, then checked against the video.', '來源：data/sceneB_gt.json，報告者在跑模型之前寫的，之後對過影片。');
  }

  function setT(n, { fresh = true } = {}) {
    const max = triples().length;
    const next = Math.max(0, Math.min(max, n));
    state.fresh = fresh && next > state.t ? next - 1 : -1;
    state.t = next;
    render();
  }
  function stop() { if (timer) { clearInterval(timer); timer = null; } }
  function play() {
    stop();
    if (state.t >= triples().length) state.t = 0;
    state.asSet = false;
    timer = setInterval(() => { if (state.t >= triples().length) { stop(); render(); } else setT(state.t + 1); }, reduced() ? 1400 : 1100);
    render();
  }
  function setMode(m) {
    stop();
    const stepped = m === 'build' || m === 'gear';
    if (m !== state.mode) { state.mode = m; state.fresh = -1; if (stepped) state.t = triples().length; if (m === 'pens') state.pens = 0; }
    render();
  }

  nav.addEventListener('click', e => { const b = e.target.closest('button[data-mode]'); if (b) setMode(b.dataset.mode); });
  const refocus = sel => $('controls').querySelector(sel)?.focus();
  $('controls').addEventListener('click', e => {
    const b = e.target.closest('button[data-ctl]');
    if (!b) return;
    const c = b.dataset.ctl;
    if (c === 'prev') { stop(); state.asSet = false; setT(state.t - 1); }
    else if (c === 'next') { stop(); state.asSet = false; setT(state.t + 1); }
    else if (c === 'play') { timer ? (stop(), render()) : play(); }
    else if (c === 'set' || c === 'seq') { stop(); state.asSet = c === 'set'; state.fresh = -1; render(); }
    else if (c === 'pens') { state.pens = +b.dataset.i; render(); }
    refocus(c === 'pens' ? `[data-ctl="pens"][data-i="${b.dataset.i}"]` : `[data-ctl="${c}"]`);
  });
  $('controls').addEventListener('input', e => { if (e.target.matches('[data-ctl="t"]')) { stop(); setT(+e.target.value); refocus('[data-ctl="t"]'); } });
  $('controls').addEventListener('change', e => {
    if (e.target.matches('[data-ctl="source"]')) { stop(); state.source = e.target.value; if (state.source !== 'gt') state.run = state.source; state.t = triples().length; state.fresh = -1; render(); refocus('[data-ctl="source"]'); }
    if (e.target.matches('[data-ctl="run"]')) { state.run = e.target.value; render(); refocus('[data-ctl="run"]'); }
  });

  if (typeof ResizeObserver === 'function') new ResizeObserver(() => {
    const narrow = el.clientWidth > 0 && el.clientWidth < 560;
    if (narrow !== state.narrow) { state.narrow = narrow; render(); }
  }).observe(el);

  ctx.bus?.on?.('video:step', d => {
    if (!d || typeof d.n !== 'number') return;
    stop();
    if (state.mode !== 'build' || state.source !== 'gt') { state.mode = 'build'; state.source = 'gt'; state.t = 0; }
    state.asSet = false;
    setT(d.n);
  });
  ctx.bus?.on?.('lab:step', d => {
    if (!d || typeof d.index !== 'number' || state.mode !== 'gear') return;
    stop();
    state.asSet = false;
    // index counts from 0 in the lab; an edge exists once the step has succeeded
    setT(d.status === 'success' ? d.index + 1 : Math.min(state.t, d.index + 1), { fresh: d.status === 'success' });
  });
  ctx.bus?.on?.('score:update', d => { const id = d && `${d.model}/${d.variant}/${d.run}`; if (id && runOf(id)) { state.run = id; if (state.mode === 'gt') render(); } });

  function act(action, args) {
    const [a, ...rest] = [action, ...(Array.isArray(args) ? args : args != null ? [args] : [])].join(':').split(':');
    if (a === 't') { const n = parseInt(rest[0], 10); if (Number.isNaN(n)) return false; stop(); if (state.mode !== 'build' && state.mode !== 'gear') { state.mode = 'build'; state.t = 0; } state.asSet = false; setT(n); return true; }
    if (a === 'build') { stop(); state.mode = 'build'; state.asSet = false; const id = rest.join(':'); if (id === 'gt' || runOf(id)) state.source = id; state.t = 0; state.fresh = -1; play(); return true; }
    if (a === 'set' || a === 'sequence') { stop(); state.asSet = a === 'set'; render(); return true; }
    if (a === 'run' && runOf(rest.join(':'))) { state.run = rest.join(':'); render(); return true; }
    if (['pens', 'base', 'path', 'gt', 'gear'].includes(a)) {
      if (a === 'pens' && state.mode === 'pens') { state.pens = (state.pens + 1) % 5; render(); return true; }
      setMode(a);
      return true;
    }
    return false;
  }

  state.narrow = el.clientWidth > 0 && el.clientWidth < 560;
  render();
  return { act, onShow() { const narrow = el.clientWidth > 0 && el.clientWidth < 560; if (narrow !== state.narrow) { state.narrow = narrow; } render(); }, onHide() { stop(); }, state };
}
