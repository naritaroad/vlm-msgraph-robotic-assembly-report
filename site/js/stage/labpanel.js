// labpanel.js — the Lab tab of the stage: the 3D view with its HUD on top, the instrument panels below.
//
//   export async function mount(el, ctx)  ->  { act(action, args), onShow(), onHide(), dispose(), lab }
//
// ctx: { bus:{ on, emit }, bind(key, value), lang(), katex, setStatus(text), createLab? }
//   ctx.createLab is optional. When it is absent the real lab is imported from ../lab/index.js.
//   site/dev/labpanel.html passes site/dev/mocklab.js here; the report page never loads the mock.
//
// Every Lab event is forwarded to ctx.bus as "lab:<type>" and written to ctx.bind with the keys of
// docs/content-guide.md §6. The panel also emits  lab:param { path, value, params }  when a knob moves
// and  lab:reset {}  after a reset, so formulas.js can follow.
//
// ── site/data/lab/plans.json (optional; without it the only plan is the paper's five triples) ──────────
// {
//   "generated": "2026-11-12T10:00:00Z",            ISO time the file was written
//   "note": "free text shown under the plan table",
//   "plans": [{
//     "id": "gpt-4o/with_base/1",                    unique; used by data-act="lab:plan:<id>"
//     "label": "GPT-4o · with Base Searcher · run 1",
//     "model": "gpt-4o",                             groups the Model menu
//     "variant": "with_base" | "without_base",       Base Searcher on or off
//     "run": 1,                                      1-based run number
//     "source": "paper" | "local-run",               decides the evidence tag (Paper / Local run)
//     "image": "media/lab/snapshot_hero.jpg",        picture the model saw (path relative to site/), or null
//     "utc": "2026-11-12T09:41:07Z",                 when the model was called, or null
//     "triples": [["red large gear", "attached to", "white cover"], …],   in execution order
//     "raw": "the model's reply, unedited"           string or null
//   }]
// }
// The plan with id "paper" is always built from config.PAPER_PLAN; an entry with that id in the file is ignored.
//
// ── site/data/lab/sweep.json (optional; without it the Sweep panel is not shown) ───────────────────────
// {
//   "generated": "…", "note": "…",
//   "param": "depth.sigmaMm", "unit": "mm",          the parameter that was swept (a key of config.PARAMS)
//   "trials": 10, "seeds": [7, 8, …],                trials per value, and the seeds used
//   "steps": ["red large gear", …],                  one entry per plan step (subject of the triple)
//   "rows": [{ "value": 0.0, "success": [10, 10, 10, 10, 10], "all": 10 }, …]   successes per step; "all" optional
// }

import * as CFG from '../lab/config.js';
import { JOINTS, HOME } from '../lab/kinematics.js';
import { fmt, formatBind, backproject, transformPoint, yawAboutY, clopperPearson } from './formulas.js';

const DEG = 180 / Math.PI;
const LAB_EVENTS = ['ready', 'telemetry', 'waypoints', 'capture', 'cloud', 'icp', 'grasp', 'step', 'plan', 'log'];
const DEMO_ACTS = ['overview', 'labels', 'frustum', 'backproject', 'fuse', 'memory', 'icp', 'grasp', 'waypoints', 'run', 'spin'];
const CAMERAS = ['hero', 'robot', 'top', 'side', 'close', 'wrist', 'free'];
const CAMERA_NAME = { hero: ['Table', '桌面'], robot: ['Robot', '手臂'], top: ['Top', '俯視'], side: ['Side', '側面'], close: ['Close', '近看'], wrist: ['Wrist', '腕部相機'], free: ['Free', '自由'] };

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const T = (en, zh) => `<span class="en" lang="en">${esc(en)}</span><span class="zh" lang="zh-Hant">${esc(zh)}</span>`;
const tag = (name) => `<span class="tag" data-tag="${esc(name)}">${esc(name)}</span>`;
const minus = (s) => String(s).replace('-', '−');
const num = (v, d = 1) => minus(fmt(v, d));
const assetUrl = (rel) => new URL('../../' + rel, import.meta.url).href;

async function fetchJson(rel) {
  try {
    const r = await fetch(assetUrl(rel), { cache: 'no-cache' });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

// ───────────────────────────────────────────────────────────── names

const normName = (s) => String(s ?? '').toLowerCase().replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').replace(/^(the|a|an) /, '').trim();
const ALIAS = new Map();
for (const [key, list] of Object.entries(CFG.ALIASES)) for (const a of list) ALIAS.set(normName(a), key);
const PART_INFO = Object.fromEntries([...CFG.PARTS, ...CFG.FIXTURES].map((p) => [p.key, p]));
/** Canonical part key for a free-text name, or null. */
export function matchPart(name) { return ALIAS.get(normName(name)) ?? null; }
/** Is the predicate one of the ten relations of Fig. 5? */
export function relationInList(p) { return CFG.RELATIONS.includes(normName(p)); }
const chip = (key) => (key ? `<span class="chip" data-part="${key}" title="${esc(PART_INFO[key]?.name ?? key)}">${esc(PART_INFO[key]?.short ?? '?')}</span>` : '<span class="chip is-unknown" title="not in the scene">?</span>');

const STATUS = {
  idle: ['idle', '待命'], start: ['start', '開始'], pick: ['pick', '夾取'], carry: ['carry', '搬運'], place: ['place', '放置'],
  settle: ['settle', '等靜止'], success: ['success', '成功'], fail: ['fail', '失敗'], skipped: ['skipped', '略過'],
};
const REASON_ZH = {
  'no grasp': '沒夾到', 'not seated': '沒坐到位', 'unknown object': '場景裡沒有這個零件', 'unknown relation': '關係詞不在清單內',
  blocked: '被擋住', dropped: '掉了', 'ik failed': 'IK 無解', 'not detected': '沒偵測到',
};

// ───────────────────────────────────────────────────────────── parameters

const PARAM_GROUPS = [
  { id: 'eq4', ref: 'Eq. (4)', en: 'Depth and intrinsics', zh: '深度與內參', keys: ['depth.sigmaMm', 'camera.fx'] },
  { id: 'eq6', ref: 'Eq. (6)', en: 'Views and masks', zh: '視角與遮罩', keys: ['views.k', 'mask.erodePx'] },
  { id: 'eq7', ref: 'Eq. (7)', en: 'Approach waypoints', zh: '進場路點', keys: ['eq7.a', 'eq7.b', 'eq7.c', 'approach.height'] },
  { id: 'icp', ref: 'ICP [32]', en: 'Alignment', zh: '對齊', keys: ['icp.maxIters'] },
  { id: 'gobj', ref: 'Γ_obj = Γᶜ_b × Γ_grasp', en: 'Hand–eye calibration', zh: '手眼校正', keys: ['handeye.errMm'] },
  { id: 'det', ref: 'Grounding DINO [30]', en: 'Detection', zh: '偵測', keys: ['detect.threshold'] },
  { id: 'match', ref: 'MSGraph nodes N, §3.2', en: 'Matching names to parts', zh: '名稱對到零件', keys: ['match.strict'] },
  { id: 'play', ref: 'playback', en: 'Speed', zh: '速度', keys: ['speed'] },
];
const PARAM_LABEL = {
  'eq7.a': ['<i>a</i>', 'first approach fraction', '第一個進場係數'],
  'eq7.b': ['<i>b</i>', 'second approach fraction', '第二個進場係數'],
  'eq7.c': ['<i>c</i>', 'third approach fraction', '第三個進場係數'],
  'approach.height': ['|<i>T</i>|', 'approach height', '進場高度'],
  'depth.sigmaMm': ['<i>σ</i><sub>d</sub>', 'depth noise at 0.5 m', '深度雜訊（0.5 m 處）'],
  'views.k': ['<i>k</i>', 'number of views', '視角數'],
  'mask.erodePx': ['<i>m</i><sub>i</sub>', 'mask erosion', '遮罩侵蝕'],
  'detect.threshold': ['<i>τ</i>', 'box threshold', '偵測門檻'],
  'camera.fx': ['<i>f</i><sub>x</sub>', 'focal length', '焦距'],
  'handeye.errMm': ['Γ<sup>c</sup><sub>b</sub>', 'hand–eye error', '手眼誤差'],
  'icp.maxIters': ['<i>n</i>', 'ICP iteration limit', 'ICP 迭代上限'],
  'match.strict': ['<i>N</i>', 'object must be a part in the scene (1 = yes, 0 = subject is enough)', '受詞必須是場景裡的零件（1 是；0 只要主詞對得到）'],
  speed: ['×', 'playback speed', '播放速度'],
};
const decimals = (step) => (String(step).split('.')[1] || '').length;

let knobSeq = 0;
/** One slider row: name and symbol | track | value and unit (+ reset). */
function makeKnob({ sym, en, zh, min, max, step, value, unit, scale = 1, digits, def, onInput }) {
  const id = 'knob-' + ++knobSeq;
  const d = digits ?? decimals(step * scale);
  const el = document.createElement('div');
  el.className = 'knob';
  el.innerHTML = `<label class="knob-name" for="${id}"><span class="knob-sym">${sym}</span><span class="knob-txt">${T(en, zh)}</span></label>`
    + `<input type="range" id="${id}" min="${min}" max="${max}" step="${step}" value="${value}">`
    + `<span class="knob-read"><output for="${id}"></output><span class="knob-unit">${esc(unit)}</span>`
    + `<button type="button" class="knob-reset" title="Reset"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 8a5 5 0 1 0 1.6-3.7M3 2.5v3h3" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="vh">${T('Reset', '重設')}</span></button></span>`;
  const input = el.querySelector('input'), out = el.querySelector('output'), reset = el.querySelector('.knob-reset');
  const show = (v) => {
    const s = num(v * scale, d);
    out.textContent = s;
    input.setAttribute('aria-valuetext', unit ? `${s} ${unit}` : s);
    el.classList.toggle('is-changed', def != null && Math.abs(v - def) > 1e-9);
  };
  show(+value);
  input.addEventListener('input', () => { show(+input.value); onInput(+input.value); });
  reset.addEventListener('click', () => { if (def == null) return; input.value = def; show(+def); onInput(+def); });
  if (def == null) reset.hidden = true;
  return {
    el, input,
    set(v) { if (document.activeElement === input && input.matches(':active')) return; input.value = v; show(+input.value); },
    get value() { return +input.value; },
    disable(b) { input.disabled = b; reset.disabled = b; },
  };
}

// ───────────────────────────────────────────────────────────── sweep chart (pure: data in, SVG markup out)

const SHAPES = [
  (x, y) => `<circle cx="${x}" cy="${y}" r="4"/>`,
  (x, y) => `<rect x="${x - 3.6}" y="${y - 3.6}" width="7.2" height="7.2"/>`,
  (x, y) => `<path d="M${x} ${y - 4.6}L${x + 4.4} ${y + 3.4}H${x - 4.4}z"/>`,
  (x, y) => `<path d="M${x} ${y - 4.8}L${x + 4.8} ${y}L${x} ${y + 4.8}L${x - 4.8} ${y}z"/>`,
  (x, y) => `<path d="M${x - 4} ${y - 4}L${x + 4} ${y + 4}M${x - 4} ${y + 4}L${x + 4} ${y - 4}" fill="none"/>`,
];
export function sweepSvg(sw, current) {
  const W = 600, H = 262, m = { l: 40, r: 34, t: 30, b: 44 };
  const rows = [...sw.rows].sort((a, b) => a.value - b.value);
  const x0 = rows[0].value, x1 = rows[rows.length - 1].value, n = sw.trials;
  const X = (v) => m.l + ((v - x0) / (x1 - x0 || 1)) * (W - m.l - m.r);
  const Y = (k) => m.t + (1 - k / n) * (H - m.t - m.b);
  let o = `<svg class="sweep-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Successes out of ${n} per step against ${esc(sw.param)}">`;
  for (let k = 0; k <= n; k += n > 10 ? Math.ceil(n / 5) : 2) o += `<line class="sw-grid" x1="${m.l}" y1="${Y(k)}" x2="${W - m.r}" y2="${Y(k)}"/><text class="sw-tick" x="${m.l - 8}" y="${Y(k) + 4}" text-anchor="end">${k}</text>`;
  for (const r of rows) o += `<text class="sw-tick" x="${X(r.value)}" y="${H - m.b + 18}" text-anchor="middle">${minus(fmt(r.value, decimals(r.value) ? 1 : 0))}</text>`;
  o += `<text class="sw-axis" x="${(m.l + W - m.r) / 2}" y="${H - 6}" text-anchor="middle">${esc(sw.param)} (${esc(sw.unit || '')})</text>`;
  o += `<text class="sw-axis" x="8" y="15">successes out of ${n}, per step</text>`;
  if (current != null && current >= x0 && current <= x1) o += `<line class="sw-now" x1="${X(current)}" y1="${m.t}" x2="${X(current)}" y2="${H - m.b}"/>`;
  const ends = [];
  (sw.steps || []).forEach((name, i) => {
    const key = matchPart(name) || 'x';
    const pts = rows.map((r) => [X(r.value), Y(r.success[i])]);
    o += `<g class="sw-series" data-part="${key}"><polyline points="${pts.map((p) => p.map((v) => v.toFixed(1)).join(',')).join(' ')}"/>${pts.map((p) => SHAPES[i % SHAPES.length](+p[0].toFixed(1), +p[1].toFixed(1))).join('')}</g>`;
    ends.push({ key, y: pts[pts.length - 1][1], short: PART_INFO[key]?.short ?? String(i + 1) });
  });
  if (rows.every((r) => Number.isFinite(r.all))) {
    o += `<polyline class="sw-all" points="${rows.map((r) => `${X(r.value).toFixed(1)},${Y(r.all).toFixed(1)}`).join(' ')}"/>`;
    ends.push({ key: 'all', y: Y(rows[rows.length - 1].all), short: 'all' });
  }
  ends.sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  for (const e of ends) o += `<text class="sw-end" data-part="${e.key}" x="${W - m.r + 8}" y="${e.y + 4}">${esc(e.short)}</text>`;
  return o + '</svg>';
}

// ───────────────────────────────────────────────────────────── markup

function skeleton() {
  const cams = CAMERAS.map((c) => `<button type="button" class="hud-btn" data-cam="${c}">${T(...CAMERA_NAME[c])}</button>`).join('');
  const camOpts = CAMERAS.map((c) => `<option value="${c}">${CAMERA_NAME[c][0]} · ${CAMERA_NAME[c][1]}</option>`).join('');
  const tabs = [
    ['plan', 'Plan', '計劃'], ['steps', 'Steps', '步驟'], ['params', 'Parameters', '參數'],
    ['telemetry', 'Telemetry', '遙測'], ['manual', 'Manual', '手動'], ['sweep', 'Sweep', '批次'],
  ];
  return `
<div class="lab-view">
  <div class="lab-canvas" tabindex="0" data-keys="own" role="img" aria-label="3D lab: xArm6 with a wrist camera at a table with a gearbox"></div>
  <div class="lab-fallback" hidden></div>
  <div class="lab-hud">
    <div class="hud-tl">${tag('Demo')}<span class="hud-line">${T('computation is real, data is synthetic', '計算為實算，資料為合成')}</span><span class="hud-line hud-tip">${T('drag a gear to move it', '拖曳齒輪可以搬動')}</span></div>
    <div class="hud-tr">
      <div class="hud-cams" role="group" aria-label="Camera preset">${cams}</div>
      <label class="hud-sel hud-cam-sel"><span class="vh">${T('Camera', '鏡頭')}</span><select data-hud="cam">${camOpts}</select></label>
      <button type="button" class="hud-btn hud-orbit" data-hud="orbit" aria-pressed="false" title="Turntable on or off (O)"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v2.6h-2.6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="orbit-on">${T('Turning', '轉動中')}</span><span class="orbit-off">${T('Turn', '轉動')}</span></button>
      <button type="button" class="hud-btn" data-hud="labels" aria-pressed="true">${T('Labels', '標籤')}</button>
      <label class="hud-sel"><span class="vh">${T('Quality', '畫質')}</span><select data-hud="quality"><option value="auto">auto</option><option value="high">high</option><option value="medium">medium</option><option value="low">low</option></select></label>
      <button type="button" class="hud-btn hud-icon" data-hud="full" aria-pressed="false"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg><span class="vh">${T('Full screen', '全螢幕')}</span></button>
    </div>
    <div class="hud-bl">
      <span class="hud-stepno">–</span>
      <span class="hud-triple">${T('no step yet', '還沒開始')}</span>
      <span class="status" data-status="idle">${T('idle', '待命')}</span>
    </div>
    <div class="hud-br"><span class="hud-log"></span><span class="hud-fps"></span></div>
  </div>
</div>
<div class="lab-resizer" role="separator" aria-orientation="horizontal" tabindex="0" aria-label="Height of the 3D view"><span class="vh">${T('Drag to change the height of the 3D view. Double-click to reset.', '拖曳調整 3D 畫面的高度，雙擊還原。')}</span></div>
<div class="lab-strip" tabindex="0" aria-label="Formula against measurement">
  <div class="strip-cell" data-cell="eq5">
    <header><b>Eq. (4)(5)</b><span>${T('one pixel → point in the world', '一個像素 → 世界座標裡的點')}</span></header>
    <dl>
      <div><dt>${T('formula', '公式算的')}</dt><dd><output data-k="f">–</output></dd></div>
      <div><dt>${T('scene', '場景量到的')}</dt><dd><output data-k="m">–</output></dd></div>
      <div class="is-delta"><dt>Δ</dt><dd><output data-k="d">–</output></dd></div>
    </dl>
  </div>
  <div class="strip-cell" data-cell="icp">
    <header><b>ICP [32]</b><span>${T('now → remembered pose', '現在 → 記憶中的位姿')}</span></header>
    <dl>
      <div><dt>${T('iteration', '迭代')}</dt><dd><output data-k="iter">–</output></dd></div>
      <div><dt>rmse</dt><dd><output data-k="rmse">–</output></dd></div>
      <div><dt>${T('turn, vertical axis', '繞垂直軸轉')}</dt><dd><output data-k="th">–</output></dd></div>
    </dl>
  </div>
  <div class="strip-cell" data-cell="step">
    <header><b>${T('Step result', '這一步的結果')}</b><span>${T('measured | limit', '量到的｜門檻')}</span></header>
    <dl>
      <div><dt>${T('position', '位置')}</dt><dd><output data-k="pos">–</output><i>&lt; ${fmt(CFG.SUCCESS.posMm, 1)} mm</i></dd></div>
      <div><dt>${T('height', '高度')}</dt><dd><output data-k="hgt">–</output><i>&lt; ${fmt(CFG.SUCCESS.heightMm, 1)} mm</i></dd></div>
      <div><dt>${T('tilt', '傾角')}</dt><dd><output data-k="tilt">–</output><i>&lt; ${fmt(CFG.SUCCESS.tiltDeg, 1)}°</i></dd></div>
    </dl>
  </div>
</div>
<div class="lab-dash">
  <div class="dash-tabs" role="tablist" aria-label="Lab panels">
    ${tabs.map(([id, en, zh], i) => `<button type="button" role="tab" id="labtab-${id}" data-tab="${id}" aria-controls="labpanel-${id}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${T(en, zh)}</button>`).join('')}
  </div>
  <div class="dash-body">

    <section class="panel" id="labpanel-plan" data-panel="plan" role="tabpanel" aria-labelledby="labtab-plan">
      <header class="panel-head"><h3 class="panel-name">Plan</h3><span class="panel-sub">${T('where the steps come from', '步驟從哪來')}</span><span class="panel-ref">Eq. (1)–(3) · Fig. 7</span><span data-role="plan-tag">${tag('Paper')}</span></header>
      <div class="plan-pick">
        <label><span>${T('Model', '模型')}</span><select data-pick="model"></select></label>
        <label><span>Base Searcher</span><select data-pick="variant"></select></label>
        <label><span>${T('Run', '第幾次')}</span><select data-pick="run"></select></label>
      </div>
      <div class="plan-go">
        <button type="button" class="btn btn-primary" data-go="run">Run</button>
        <button type="button" class="btn" data-go="step">Step</button>
        <button type="button" class="btn" data-go="pause" aria-pressed="false">Pause</button>
        <button type="button" class="btn" data-go="reset">Reset</button>
        <span class="plan-count" data-role="plan-count"></span>
      </div>
      <div class="table-wrap" tabindex="0"><table class="lab-table plan-table">
        <thead><tr><th>#</th><th>${T('subject', '主詞')}</th><th>predicate</th><th>${T('object', '受詞')}</th><th>${T('parts in the scene?', '場景裡有這些零件？')}</th><th>${T('relation in the Fig. 5 list?', '關係詞在圖 5 清單內？')}</th></tr></thead>
        <tbody></tbody>
      </table></div>
      <details class="plan-raw" hidden><summary>${T('Raw reply of the model', '模型的原始回覆')}</summary><pre></pre></details>
      <details class="lab-subs"><summary>${T('What stands in for what in this lab', '這個實驗室用什麼代替什麼')}</summary>
        <ul>
          <li>${T('Object-ID image from the renderer, in place of Grounding DINO + Grounded SAM 2 masks.', '用繪圖器的物件 ID 圖，代替 Grounding DINO＋Grounded SAM 2 的遮罩。')}</li>
          <li>${T('A geometric top-down grasp rule, in place of AnyGrasp.', '用由上往下的幾何夾取規則，代替 AnyGrasp。')}</li>
          <li>${T('Damped least-squares IK, where the paper writes inverse dynamics.', '用阻尼最小平方 IK；論文寫的是 inverse dynamics。')}</li>
          <li>${T('The gearbox is our own design; the paper does not publish its parts.', '齒輪箱是我們自己設計的；論文沒有公開零件。')}</li>
        </ul>
      </details>
      <p class="panel-src" data-role="plan-src"></p>
    </section>

    <section class="panel" id="labpanel-steps" data-panel="steps" role="tabpanel" aria-labelledby="labtab-steps" hidden>
      <header class="panel-head"><h3 class="panel-name">Steps</h3><span class="panel-sub">${T('what happened to each part', '每個零件的結果')}</span><span class="panel-ref">§4.2 · Table 3</span>${tag('Demo')}</header>
      <div class="table-wrap" tabindex="0"><table class="lab-table steps-table">
        <colgroup><col class="c-n"><col class="c-tri"><col class="c-st"><col class="c-num"><col class="c-num"><col class="c-num"><col class="c-k"><col class="c-ci"></colgroup>
        <thead>
          <tr><th rowspan="2">#</th><th rowspan="2">triple</th><th colspan="4" class="th-group">${T('This lab', '這個實驗室')} ${tag('Demo')}</th><th colspan="2" class="th-group is-paper">Table 3 ${tag('Paper')}</th></tr>
          <tr><th>${T('status, and why it failed', '狀態與失敗原因')}</th><th>${T('position', '位置')}<small>mm</small></th><th>${T('height', '高度')}<small>mm</small></th><th>${T('tilt', '傾角')}<small>°</small></th><th class="is-paper">${T('successes', '成功次數')}<small>/ 10</small></th><th class="is-paper">95% CI ${tag('Derived')}</th></tr>
        </thead>
        <tbody></tbody>
      </table></div>
      <p class="panel-note">${tag('Paper')} ${T('Table 3 counts memory and perception: an accurate 3D object instance with movement and rotation values. It does not say whether the part ended up seated.', '表 3 量的是記憶與感知：有沒有產生準確的 3D object instance 與移動、旋轉值。它沒有說零件最後有沒有裝上去。')}</p>
      <p class="panel-note">${tag('Demo')} ${T(`Here a step succeeds when, after release, the part rests within ${fmt(CFG.SUCCESS.posMm, 1)} mm of its seat, within ${fmt(CFG.SUCCESS.heightMm, 1)} mm in height, and tilted less than ${fmt(CFG.SUCCESS.tiltDeg, 1)}°. The two columns measure different things.`, `這裡的成功是：鬆開後零件離座位水平 ${fmt(CFG.SUCCESS.posMm, 1)} mm 內、高度差 ${fmt(CFG.SUCCESS.heightMm, 1)} mm 內、傾角小於 ${fmt(CFG.SUCCESS.tiltDeg, 1)}°。兩邊量的不是同一件事。`)}</p>
      <p class="panel-src">${T(`Rigid-body physics decides each result; nothing is drawn at random. Seed ${CFG.SEED} fixes the sensor noise, so a run repeats exactly.`, `每一步的結果由剛體物理決定，不擲骰子。感測雜訊的亂數種子是 ${CFG.SEED}，同一設定重跑結果相同。`)}</p>
    </section>

    <section class="panel" id="labpanel-params" data-panel="params" role="tabpanel" aria-labelledby="labtab-params" hidden>
      <header class="panel-head"><h3 class="panel-name">Parameters</h3><span class="panel-sub">${T('change a number, watch the formula', '改一個數，看公式跟著變')}</span><span class="panel-ref">Eq. (4) (6) (7) · ICP [32]</span>${tag('Demo')}</header>
      <div class="param-groups"></div>
      <p class="panel-src">${T(`Depth noise: Gaussian per pixel, σ(d) = σ_d · (d / ${fmt(CFG.DEPTH_NOISE.d0, 1)} m)², seed ${CFG.SEED}. Detector score: ${fmt(CFG.DETECTOR.base, 2)} − ${fmt(CFG.DETECTOR.occlusionPenalty, 1)} × hidden fraction − ${fmt(CFG.DETECTOR.sizePenalty, 1)} / √(mask pixels). These are settings of the lab, not values from the paper.`, `深度雜訊：逐像素高斯，σ(d) = σ_d · (d / ${fmt(CFG.DEPTH_NOISE.d0, 1)} m)²，種子 ${CFG.SEED}。偵測分數：${fmt(CFG.DETECTOR.base, 2)} − ${fmt(CFG.DETECTOR.occlusionPenalty, 1)} × 被遮住的比例 − ${fmt(CFG.DETECTOR.sizePenalty, 1)} / √(遮罩像素數)。這些是實驗室的設定，不是論文的數值。`)}</p>
    </section>

    <section class="panel" id="labpanel-telemetry" data-panel="telemetry" role="tabpanel" aria-labelledby="labtab-telemetry" hidden>
      <header class="panel-head"><h3 class="panel-name">Telemetry</h3><span class="panel-sub">${T('what the arm is doing now', '手臂現在的狀態')}</span><span class="panel-ref">A<sub>t</sub> ∈ ℝ<sup>7</sup> · §3.2</span>${tag('Demo')}</header>
      <div class="meters">
        <div class="meter-group" data-g="q"><h4>${T('Joint angles', '關節角')}</h4><div class="meter-row">${[1, 2, 3, 4, 5, 6].map((i) => `<div class="meter"><small>q${i}</small><output data-t="q${i - 1}">–</output><i>°</i></div>`).join('')}</div></div>
        <div class="meter-group" data-g="tcp"><h4>${T('TCP position (world, y up)', 'TCP 位置（世界座標，y 向上）')}</h4><div class="meter-row">${['x', 'y', 'z'].map((a, i) => `<div class="meter"><small>${a}</small><output data-t="p${i}">–</output><i>mm</i></div>`).join('')}</div></div>
        <div class="meter-group" data-g="rpy"><h4>${T('TCP orientation', 'TCP 姿態')}</h4><div class="meter-row">${['rx', 'ry', 'rz'].map((a, i) => `<div class="meter"><small>${a}</small><output data-t="r${i}">–</output><i>°</i></div>`).join('')}</div></div>
        <div class="meter-group" data-g="grip"><h4>${T('Gripper', '夾爪')}</h4><div class="meter-row">
          <div class="meter"><small>${T('opening', '開口')}</small><output data-t="gw">–</output><i>mm</i></div>
          <div class="meter is-lamp"><small>${T('left pad', '左指')}</small><output data-t="cl">–</output></div>
          <div class="meter is-lamp"><small>${T('right pad', '右指')}</small><output data-t="cr">–</output></div>
          <div class="meter is-lamp"><small>${T('holding', '夾住')}</small><output data-t="hold">–</output></div>
        </div></div>
        <div class="meter-group is-wide" data-g="A"><h4>A<sub>t</sub> ${T('= one control step: 3 translations, 3 Euler angles, gripper', '＝一個控制步：3 個平移、3 個歐拉角、夾爪')}</h4><div class="meter-row">
          ${['dx', 'dy', 'dz'].map((a, i) => `<div class="meter is-t"><small>${a}</small><output data-t="A${i}">–</output><i>mm</i></div>`).join('')}
          ${['rx', 'ry', 'rz'].map((a, i) => `<div class="meter is-r"><small>${a}</small><output data-t="A${i + 3}">–</output><i>°</i></div>`).join('')}
          <div class="meter is-s"><small>s</small><output data-t="A6">–</output><i></i></div>
        </div></div>
        <div class="meter-group" data-g="fps"><h4>${T('Rendering', '繪圖')}</h4><div class="meter-row"><div class="meter"><small>${T('frame rate', '畫面更新率')}</small><output data-t="fps">–</output><i>fps</i></div></div></div>
      </div>
      <p class="panel-src">${T('Events carry metres and radians; this panel shows mm and degrees. A_t follows the paper: T[dx, dy, dz] + R[rx, ry, rz] (Euler) + s_t.', '事件用公尺與弧度；這個面板換成 mm 與度。A_t 照論文：T[dx, dy, dz]＋R[rx, ry, rz]（歐拉角）＋s_t。')}</p>
    </section>

    <section class="panel" id="labpanel-manual" data-panel="manual" role="tabpanel" aria-labelledby="labtab-manual" hidden>
      <header class="panel-head"><h3 class="panel-name">Manual</h3><span class="panel-sub">${T('move the arm yourself', '自己動手臂')}</span><span class="panel-ref">xArm6 · FK / IK</span>${tag('Demo')}</header>
      <div class="manual-go">
        <button type="button" class="btn" data-manual="home">Home</button>
        <button type="button" class="btn" data-manual="gizmo" aria-pressed="false">${T('Drag the TCP', '拖曳 TCP')}</button>
      </div>
      <div class="manual-knobs"></div>
      <p class="panel-note"><kbd>A</kbd><kbd>D</kbd> x · <kbd>W</kbd><kbd>S</kbd> z · <kbd>Q</kbd><kbd>E</kbd> y ${T('(down, up)', '（下、上）')} · <kbd>Z</kbd><kbd>X</kbd> ${T('close, open the gripper', '夾爪合、開')} · ${T('5 mm a press, 1 mm with Shift. Click the 3D view first.', '按一下 5 mm，加 Shift 是 1 mm。先點一下 3D 畫面。')}</p>
      <p class="panel-src">${T('Joint limits from xarm_ros (xarm6_default_kinematics.yaml). Jogging solves IK by damped least squares; the paper writes inverse dynamics.', '關節限位取自 xarm_ros（xarm6_default_kinematics.yaml）。點動用阻尼最小平方解 IK；論文寫的是 inverse dynamics。')}</p>
    </section>

    <section class="panel" id="labpanel-sweep" data-panel="sweep" role="tabpanel" aria-labelledby="labtab-sweep" hidden>
      <header class="panel-head"><h3 class="panel-name">Sweep</h3><span class="panel-sub">${T('more noise, fewer successes', '雜訊變大，成功變少')}</span><span class="panel-ref">${T('compare with Table 3', '對照表 3')}</span>${tag('Demo')}</header>
      <div class="sweep-chart"></div>
      <p class="sweep-legend"></p>
      <p class="panel-src" data-role="sweep-src"></p>
    </section>
  </div>
</div>
<p class="vh" aria-live="polite" data-role="live"></p>`;
}

// ───────────────────────────────────────────────────────────── mount

export async function mount(el, ctx = {}) {
  const bus = ctx.bus || { on() {}, emit() {} };
  const bind = (k, v) => { try { ctx.bind?.(k, v); } catch (e) { console.warn('[labpanel] bind', k, e); } };
  const emit = (t, d) => { try { bus.emit?.(t, d); } catch (e) { console.warn('[labpanel] bus', t, e); } };

  const root = document.createElement('div');
  root.className = 'labpanel';
  root.dataset.state = 'loading';
  root.innerHTML = skeleton();
  for (const p of root.querySelectorAll('.panel')) {
    const body = document.createElement('div');
    body.className = 'panel-body';
    const kids = [...p.children].filter((c) => !c.classList.contains('panel-head') && !(c.classList.contains('panel-src') && c === p.lastElementChild));
    p.firstElementChild.after(body);
    body.append(...kids);
  }
  el.replaceChildren(root);
  const $ = (s, r = root) => r.querySelector(s);
  const $$ = (s, r = root) => [...r.querySelectorAll(s)];

  const view = $('.lab-view'), canvasHost = $('.lab-canvas'), fallback = $('.lab-fallback');

  // ── height of the 3D view: drag the bar under it, or focus the bar and use the arrow keys
  {
    const bar = $('.lab-resizer');
    const KEY = 'msgraph.labH';
    const clampH = (h) => Math.max(200, Math.min(root.clientHeight - 150, h));
    const setH = (h, save = true) => {
      if (h == null) { view.style.flex = ''; try { localStorage.removeItem(KEY); } catch { /* private mode */ } }
      else {
        const v = clampH(h);
        view.style.flex = `0 0 ${Math.round(v)}px`;
        if (save) { try { localStorage.setItem(KEY, String(Math.round((v / Math.max(1, root.clientHeight)) * 1000) / 1000)); } catch { /* private mode */ } }
      }
      call((l) => l.resize?.());
    };
    let drag = null;
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, y: e.clientY, h: view.getBoundingClientRect().height };
      bar.setPointerCapture(e.pointerId); bar.classList.add('is-drag'); e.preventDefault();
    });
    bar.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) setH(drag.h + e.clientY - drag.y, false); });
    const end = (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      setH(drag.h + e.clientY - drag.y);
      drag = null; bar.classList.remove('is-drag');
      try { bar.releasePointerCapture(e.pointerId); } catch { /* released */ }
    };
    bar.addEventListener('pointerup', end); bar.addEventListener('pointercancel', end);
    bar.addEventListener('dblclick', () => setH(null));
    bar.addEventListener('keydown', (e) => {
      const h = view.getBoundingClientRect().height;
      if (e.key === 'ArrowUp') setH(h - 24); else if (e.key === 'ArrowDown') setH(h + 24); else if (e.key === 'Enter') setH(null); else return;
      e.preventDefault(); e.stopPropagation();
    });
    let saved = NaN;
    try { saved = parseFloat(localStorage.getItem(KEY)); } catch { /* private mode */ }
    if (saved > 0.15 && saved < 0.9) requestAnimationFrame(() => { if (root.clientHeight) setH(saved * root.clientHeight, false); });
  }
  const live = $('[data-role="live"]');
  const say = (text) => { live.textContent = text; try { ctx.setStatus?.(text); } catch { /* optional */ } };

  let lab = null;
  const params = Object.fromEntries(Object.entries(CFG.PARAMS).map(([k, p]) => [k, p.v]));
  const state = { plans: [], plan: null, steps: [], paused: false, shown: true, labels: true, tele: null, planEvt: null, sweep: null, paper: null };

  const report = (e) => {
    const msg = e?.message || String(e);
    console.warn('[labpanel]', msg);
    $('.hud-log').textContent = msg;
  };
  /** Call into the lab; a missing lab, a missing method or a thrown error never escapes. */
  const call = (fn) => {
    if (!lab) return undefined;
    try {
      const r = fn(lab);
      if (r && typeof r.catch === 'function') r.catch(report);
      return r;
    } catch (e) { report(e); return undefined; }
  };

  // ── tabs
  const tabs = $$('.dash-tabs [role="tab"]');
  const panels = Object.fromEntries($$('.panel').map((p) => [p.dataset.panel, p]));
  let activeTab = 'plan';
  const dashBody = $('.dash-body');
  function showTab(id, focus = false) {
    const btn = tabs.find((t) => t.dataset.tab === id);
    if (!btn || btn.hidden) return;
    if (activeTab !== id) dashBody.scrollTop = 0;
    activeTab = id;
    for (const t of tabs) { const on = t === btn; t.setAttribute('aria-selected', on); t.tabIndex = on ? 0 : -1; }
    for (const [k, p] of Object.entries(panels)) p.hidden = k !== id;
    if (focus) btn.focus();
    if (id === 'telemetry' && state.tele) paintTelemetry(state.tele);
  }
  $('.dash-tabs').addEventListener('click', (e) => { const b = e.target.closest('[role="tab"]'); if (b) showTab(b.dataset.tab); });
  $('.dash-tabs').addEventListener('keydown', (e) => {
    const vis = tabs.filter((t) => !t.hidden);
    const i = vis.findIndex((t) => t.dataset.tab === activeTab);
    const to = e.key === 'ArrowRight' ? vis[(i + 1) % vis.length] : e.key === 'ArrowLeft' ? vis[(i - 1 + vis.length) % vis.length] : e.key === 'Home' ? vis[0] : e.key === 'End' ? vis[vis.length - 1] : null;
    if (to) { e.preventDefault(); e.stopPropagation(); showTab(to.dataset.tab, true); }
  });
  tabs.find((t) => t.dataset.tab === 'sweep').hidden = true;

  // ── HUD
  const hud = { stepno: $('.hud-stepno'), triple: $('.hud-triple'), status: $('.lab-hud .status'), fps: $('.hud-fps'), log: $('.hud-log') };
  function setCamera(name) {
    call((l) => l.camera(name));
    for (const b of $$('[data-cam]')) b.setAttribute('aria-pressed', b.dataset.cam === name);
    const sel = $('[data-hud="cam"]');
    if ([...sel.options].some((o) => o.value === name)) sel.value = name;
  }
  function setLabels(on) {
    state.labels = on;
    $('[data-hud="labels"]').setAttribute('aria-pressed', on);
    call((l) => l.setLabels(on));
  }
  function toggleFull() {
    const btn = $('[data-hud="full"]');
    if (document.fullscreenElement === root) { document.exitFullscreen?.(); return; }
    if (root.classList.contains('is-max')) { root.classList.remove('is-max'); btn.setAttribute('aria-pressed', false); resizeSoon(); return; }
    if (root.requestFullscreen) root.requestFullscreen().catch(() => { root.classList.add('is-max'); btn.setAttribute('aria-pressed', true); resizeSoon(); });
    else { root.classList.add('is-max'); btn.setAttribute('aria-pressed', true); resizeSoon(); }
  }
  const onFsChange = () => { $('[data-hud="full"]').setAttribute('aria-pressed', document.fullscreenElement === root); resizeSoon(); };
  document.addEventListener('fullscreenchange', onFsChange);
  $('.lab-hud').addEventListener('click', (e) => {
    const cam = e.target.closest('[data-cam]');
    if (cam) return setCamera(cam.dataset.cam);
    const b = e.target.closest('[data-hud]');
    if (!b || b.tagName === 'SELECT') return;
    if (b.dataset.hud === 'labels') setLabels(!state.labels);
    if (b.dataset.hud === 'orbit') { const on = call((l) => l.orbit?.(!l.orbit?.())); paintOrbit(!!on); }
    if (b.dataset.hud === 'full') toggleFull();
  });
  $('[data-hud="cam"]').addEventListener('change', (e) => setCamera(e.target.value));
  function paintOrbit(on) { $('[data-hud="orbit"]').setAttribute('aria-pressed', String(!!on)); }
  canvasHost.addEventListener('keydown', (e) => {
    if ((e.key === 'o' || e.key === 'O') && !e.ctrlKey && !e.metaKey && !e.altKey) { e.preventDefault(); e.stopPropagation(); paintOrbit(call((l) => l.orbit?.(!l.orbit?.()))); }
  });
  $('[data-hud="quality"]').addEventListener('change', (e) => call((l) => l.setQuality(e.target.value)));
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && root.classList.contains('is-max')) { e.stopPropagation(); toggleFull(); }
  });
  let resizeTimer = 0;
  function resizeSoon() { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => call((l) => l.resize?.()), 60); }
  const ro = 'ResizeObserver' in window ? new ResizeObserver(resizeSoon) : null;
  ro?.observe(canvasHost);

  function setStatus(elm, status) {
    const s = STATUS[status] ? status : 'idle';
    elm.dataset.status = s;
    elm.innerHTML = T(STATUS[s][0], STATUS[s][1]);
  }
  const tripleHtml = (t) => (Array.isArray(t) ? `<span class="tri">⟨${chip(matchPart(t[0]))}${esc(t[0])}, <em>${esc(t[1])}</em>, ${chip(matchPart(t[2]))}${esc(t[2])}⟩</span>` : esc(t ?? ''));

  const tripleRows = (t) => `<span class="tri2"><span>${chip(matchPart(t[0]))}${esc(t[0])}</span><span><em>${esc(t[1])}</em> → ${chip(matchPart(t[2]))}${esc(t[2])}</span></span>`;

  // ── strip
  const strip = Object.fromEntries($$('.strip-cell').map((c) => [c.dataset.cell, Object.fromEntries([...c.querySelectorAll('output')].map((o) => [o.dataset.k, o]))]));
  const put = (o, text) => {
    if (o.textContent === text) return;
    o.textContent = text;
    o.classList.remove('is-flash'); void o.offsetWidth; o.classList.add('is-flash');
  };
  const lim = (o, bad) => o.closest('div').classList.toggle('is-over', !!bad);

  // ── plan
  const pick = { model: $('[data-pick="model"]'), variant: $('[data-pick="variant"]'), run: $('[data-pick="run"]') };
  const VARIANT_LABEL = { with_base: 'with', without_base: 'without' };
  const MODEL_LABEL = { paper: 'Paper, Fig. 7' };
  function fillPickers() {
    const p = state.plan;
    const models = [...new Set(state.plans.map((x) => x.model))];
    pick.model.innerHTML = models.map((m) => `<option value="${esc(m)}">${esc(MODEL_LABEL[m] ?? m)}</option>`).join('');
    pick.model.value = p.model;
    const ofModel = state.plans.filter((x) => x.model === p.model);
    const variants = [...new Set(ofModel.map((x) => x.variant))].filter((v) => v != null);
    pick.variant.innerHTML = variants.length ? variants.map((v) => `<option value="${esc(v)}">${esc(VARIANT_LABEL[v] ?? v)}</option>`).join('') : '<option value="">–</option>';
    pick.variant.disabled = variants.length < 1;
    if (p.variant != null) pick.variant.value = p.variant;
    const runs = ofModel.filter((x) => x.variant === p.variant).map((x) => x.run).filter((r) => r != null);
    pick.run.innerHTML = runs.length ? runs.map((r) => `<option value="${esc(r)}">${esc(r)}</option>`).join('') : '<option value="">–</option>';
    pick.run.disabled = runs.length < 1;
    if (p.run != null) pick.run.value = String(p.run);
  }
  function choose(model, variant, run) {
    const ofModel = state.plans.filter((x) => x.model === model);
    let c = ofModel.filter((x) => variant == null || variant === '' || x.variant === variant);
    if (!c.length) c = ofModel;
    const exact = c.find((x) => String(x.run) === String(run));
    loadPlan((exact || c[0] || state.plans[0]).id);
  }
  pick.model.addEventListener('change', () => choose(pick.model.value, null, null));
  pick.variant.addEventListener('change', () => choose(pick.model.value, pick.variant.value, pick.run.value));
  pick.run.addEventListener('change', () => choose(pick.model.value, pick.variant.value, pick.run.value));

  const planBody = $('.plan-table tbody'), stepsBody = $('.steps-table tbody');
  function table3For(triple) {
    const key = matchPart(triple[0]);
    const row = key && state.paper?.table3?.find((r) => matchPart(r.prompt) === key);
    if (!row) return null;
    const [lo, hi] = clopperPearson(row.success, 10);
    return { k: row.success, lo, hi };
  }
  function renderPlan() {
    const p = state.plan;
    const yes = (ok, y, n) => `<span class="mark ${ok ? 'is-yes' : 'is-no'}">${ok ? '✓' : '✕'} ${ok ? y : n}</span>`;
    planBody.innerHTML = p.triples.map((t, i) => {
      const s = matchPart(t[0]), o = matchPart(t[2]), rel = relationInList(t[1]);
      const missing = [!s && t[0], !o && t[2]].filter(Boolean);
      return `<tr><td class="n">${i + 1}</td><td>${chip(s)}${esc(t[0])}</td><td><em>${esc(t[1])}</em></td><td>${chip(o)}${esc(t[2])}</td>`
        + `<td class="chk">${yes(!missing.length, T('both found', '兩個都有'), T('not found: ', '找不到：') + esc(missing.join(', ')))}</td>`
        + `<td class="chk">${yes(rel, T('in the list', '在清單內'), T('not in the list', '不在清單內'))}</td></tr>`;
    }).join('');
    const isPaper = p.source === 'paper';
    $('[data-role="plan-tag"]').innerHTML = tag(isPaper ? 'Paper' : 'Local run');
    const bits = isPaper
      ? T('The five triples printed in Fig. 7 (p.7). The paper does not show the model output for this gearbox.', '圖 7（p.7）印出的五條 triple。論文沒有印這個齒輪箱的模型輸出。')
      : T(`${p.label || p.id}. Model called ${p.utc || 'at an unrecorded time'}${p.image ? ', on ' + p.image : ''}. This is our own run, not a result of the paper.`, `${p.label || p.id}。呼叫時間：${p.utc || '沒有紀錄'}${p.image ? '，輸入圖：' + p.image : ''}。這是我們自己跑的，不是論文的結果。`);
    $('[data-role="plan-src"]').innerHTML = bits + (state.plansNote ? ' ' + esc(state.plansNote) : '');
    const raw = $('.plan-raw');
    raw.hidden = !p.raw;
    raw.querySelector('pre').textContent = p.raw || '';
    renderSteps();
    renderCount();
  }
  function renderCount() {
    const e = state.planEvt, n = state.plan.triples.length;
    $('[data-role="plan-count"]').innerHTML = e
      ? `${T('done', '完成')} <b>${e.done}/${e.n}</b> · ${T('success', '成功')} <b>${e.success}</b> · ${T('fail', '失敗')} <b>${e.fail}</b>`
      : `${n} ${T('steps', '步')}`;
  }
  function renderSteps() {
    const p = state.plan;
    stepsBody.innerHTML = p.triples.map((t, i) => {
      const t3 = table3For(t);
      return `<tr data-i="${i}"><td class="n">${i + 1}</td><td>${tripleRows(t)}</td>`
        + `<td><span class="status" data-status="idle">${T('idle', '待命')}</span><span class="why" data-c="why"></span></td><td class="num" data-c="pos">–</td><td class="num" data-c="hgt">–</td><td class="num" data-c="tilt">–</td>`
        + (t3 ? `<td class="num is-paper">${t3.k}</td><td class="num is-paper">${fmt(t3.lo * 100, 0)}–${fmt(t3.hi * 100, 0)}%</td>` : `<td class="is-paper" colspan="2">${T('no row in Table 3', '表 3 沒有這一列')}</td>`)
        + '</tr>';
    }).join('');
    state.steps.forEach((s, i) => { if (s) paintStep(i, s); });
  }
  function paintStep(i, s) {
    const tr = stepsBody.querySelector(`tr[data-i="${i}"]`);
    if (!tr) return;
    setStatus(tr.querySelector('.status'), s.status);
    tr.dataset.status = s.status;
    const e = s.error || {};
    const cell = (c, v, d, limit) => { const td = tr.querySelector(`[data-c="${c}"]`); td.textContent = Number.isFinite(v) ? num(v, d) : '–'; td.classList.toggle('is-over', Number.isFinite(v) && Math.abs(v) >= limit); };
    cell('pos', e.pos_mm, 2, CFG.SUCCESS.posMm); cell('hgt', e.height_mm, 2, CFG.SUCCESS.heightMm); cell('tilt', e.tilt_deg, 2, CFG.SUCCESS.tiltDeg);
    tr.querySelector('[data-c="why"]').innerHTML = s.reason ? T(s.reason, REASON_ZH[s.reason] || s.reason) : '';
    for (const r of stepsBody.children) r.classList.toggle('is-current', r === tr && !['success', 'fail', 'skipped'].includes(s.status));
  }
  function loadPlan(id) {
    const p = state.plans.find((x) => x.id === id);
    if (!p) { report(new Error('no plan with id ' + id)); return false; }
    state.plan = p; state.steps = []; state.planEvt = null;
    hud.stepno.textContent = '–'; hud.triple.innerHTML = T('no step yet', '還沒開始'); setStatus(hud.status, 'idle');
    fillPickers(); renderPlan();
    call((l) => l.loadPlan({ id: p.id, model: p.model, variant: p.variant, run: p.run, triples: p.triples, source: p.source }));
    bind('plan.id', p.id); bind('plan.n', p.triples.length);
    emit('lab:planloaded', { id: p.id, triples: p.triples, source: p.source });
    return true;
  }

  const goBtn = Object.fromEntries($$('[data-go]').map((b) => [b.dataset.go, b]));
  function setPaused(p) {
    state.paused = p;
    goBtn.pause.setAttribute('aria-pressed', p);
    goBtn.pause.textContent = p ? 'Resume' : 'Pause';
    call((l) => (p ? l.pause() : l.resume()));
  }
  function doReset() {
    state.steps = []; state.planEvt = null;
    call((l) => l.reset({ seed: CFG.SEED }));
    if (state.paused) setPaused(false);
    renderSteps(); renderCount();
    hud.stepno.textContent = '–'; hud.triple.innerHTML = T('no step yet', '還沒開始'); setStatus(hud.status, 'idle');
    for (const cell of Object.values(strip)) for (const o of Object.values(cell)) { o.textContent = '–'; o.closest('div').classList.remove('is-over'); }
    emit('lab:reset', {});
    say('Lab reset');
  }
  const doRun = () => { if (state.paused) setPaused(false); showTab('steps'); return call((l) => l.run()); };
  const doStep = () => { if (state.paused) setPaused(false); showTab('steps'); return call((l) => l.step()); };
  $('.plan-go').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    if (b.dataset.go === 'run') doRun();
    else if (b.dataset.go === 'step') doStep();
    else if (b.dataset.go === 'pause') setPaused(!state.paused);
    else if (b.dataset.go === 'reset') doReset();
  });

  // ── parameters
  const knobs = {};
  const groupsEl = $('.param-groups');
  const known = new Set(PARAM_GROUPS.flatMap((g) => g.keys));
  const extra = Object.keys(CFG.PARAMS).filter((k) => !known.has(k));
  const groups = extra.length ? [...PARAM_GROUPS, { id: 'other', ref: 'other', en: 'Other', zh: '其他', keys: extra }] : PARAM_GROUPS;
  function setParam(path, value, { fromKnob = false } = {}) {
    const def = CFG.PARAMS[path];
    if (!def || !Number.isFinite(value)) { report(new Error('unknown parameter or value: ' + path)); return false; }
    const v = Math.min(def.max, Math.max(def.min, value));
    params[path] = v;
    if (!fromKnob) knobs[path]?.set(v);
    call((l) => l.setParam(path, v));
    bind('param.' + path, v);
    emit('lab:param', { path, value: v, params: { ...params } });
    if (state.sweep?.param === path) paintSweep();
    return true;
  }
  for (const g of groups) {
    const keys = g.keys.filter((k) => CFG.PARAMS[k]);
    if (!keys.length) continue;
    const fs = document.createElement('fieldset');
    fs.className = 'param-group';
    fs.innerHTML = `<legend><b>${esc(g.ref)}</b><span>${T(g.en, g.zh)}</span></legend>`;
    for (const k of keys) {
      const p = CFG.PARAMS[k];
      const [sym, en, zh] = PARAM_LABEL[k] || ['', k, k];
      const inMetres = p.unit === 'm';
      const knob = makeKnob({ sym, en, zh, min: p.min, max: p.max, step: p.step, value: p.v, def: p.v, unit: inMetres ? 'mm' : p.unit === 'x' ? '×' : p.unit, scale: inMetres ? 1000 : 1, digits: inMetres ? 0 : undefined, onInput: (v) => setParam(k, v, { fromKnob: true }) });
      knob.el.dataset.path = k;
      knob.el.title = p.ref;
      knobs[k] = knob;
      fs.appendChild(knob.el);
    }
    groupsEl.appendChild(fs);
  }

  // ── telemetry
  const tele = Object.fromEntries($$('[data-t]').map((o) => [o.dataset.t, o]));
  const setT = (k, s) => { const o = tele[k]; if (o && o.textContent !== s) o.textContent = s; };
  const lamp = (k, on) => { const o = tele[k]; if (!o) return; const s = on ? 'yes' : 'no'; if (o.dataset.on !== s) { o.dataset.on = s; o.innerHTML = on ? T('yes', '有') : T('no', '沒有'); } };
  function paintTelemetry(d) {
    d.q?.forEach((v, i) => setT('q' + i, num(v * DEG, 1)));
    d.tcp?.p?.forEach((v, i) => setT('p' + i, num(v * 1000, 1)));
    d.tcp?.rpy?.forEach((v, i) => setT('r' + i, num(v * DEG, 1)));
    if (d.grip) { setT('gw', num(d.grip.width * 1000, 1)); lamp('cl', d.grip.contactL); lamp('cr', d.grip.contactR); lamp('hold', d.grip.holding); }
    if (d.A) { for (let i = 0; i < 3; i++) setT('A' + i, num(d.A[i] * 1000, 2)); for (let i = 3; i < 6; i++) setT('A' + i, num(d.A[i] * DEG, 2)); setT('A6', num(d.A[6], 2)); }
    if (Number.isFinite(d.fps)) setT('fps', num(d.fps, 0));
  }

  // ── manual
  const manualEl = $('.manual-knobs');
  const jointKnobs = JOINTS.map((j, i) => {
    const k = makeKnob({ sym: `q<sub>${i + 1}</sub>`, en: 'joint ' + (i + 1), zh: '第 ' + (i + 1) + ' 軸', min: +(j.lo * DEG).toFixed(1), max: +(j.hi * DEG).toFixed(1), step: 0.5, value: +(HOME[i] * DEG).toFixed(1), def: +(HOME[i] * DEG).toFixed(1), unit: '°', digits: 1, onInput: (deg) => call((l) => l.manual.setJoint(i, deg / DEG)) });
    manualEl.appendChild(k.el);
    return k;
  });
  const gripMax = CFG.ROBOT.gripper.strokeMax * 1000;
  const gripKnob = makeKnob({ sym: '<i>s</i>', en: 'gripper opening', zh: '夾爪開口', min: 0, max: gripMax, step: 1, value: gripMax, def: gripMax, unit: 'mm', digits: 0, onInput: (mm) => call((l) => l.manual.setGripper(mm / 1000)) });
  manualEl.appendChild(gripKnob.el);
  function goHome() {
    HOME.forEach((q, i) => { call((l) => l.manual.setJoint(i, q)); jointKnobs[i].set(+(q * DEG).toFixed(1)); });
  }
  $('.manual-go').addEventListener('click', (e) => {
    const b = e.target.closest('[data-manual]');
    if (!b) return;
    if (b.dataset.manual === 'home') goHome();
    if (b.dataset.manual === 'gizmo') { const on = b.getAttribute('aria-pressed') !== 'true'; b.setAttribute('aria-pressed', on); call((l) => l.manual.enableGizmo(on)); }
  });
  const JOG = { a: ['dx', -1], d: ['dx', 1], w: ['dz', -1], s: ['dz', 1], q: ['dy', -1], e: ['dy', 1] };
  canvasHost.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const key = e.key.toLowerCase();
    const step = (e.shiftKey ? 1 : 5) / 1000;
    if (JOG[key]) {
      const [axis, sign] = JOG[key];
      call((l) => l.manual.jog({ dx: 0, dy: 0, dz: 0, drx: 0, dry: 0, drz: 0, [axis]: sign * step }));
    } else if (key === 'z' || key === 'x') {
      const w = Math.min(gripMax, Math.max(0, (state.tele?.grip?.width ?? CFG.ROBOT.gripper.strokeMax) * 1000 + (key === 'x' ? 5 : -5)));
      call((l) => l.manual.setGripper(w / 1000));
    } else return;
    e.preventDefault(); e.stopPropagation();
  });

  // ── sweep
  function paintSweep() {
    const sw = state.sweep;
    if (!sw) return;
    $('.sweep-chart').innerHTML = sweepSvg(sw, params[sw.param]);
  }
  function setupSweep(sw) {
    if (!sw || !Array.isArray(sw.rows) || sw.rows.length < 2 || !sw.trials) return;
    state.sweep = sw;
    tabs.find((t) => t.dataset.tab === 'sweep').hidden = false;
    paintSweep();
    $('.sweep-legend').innerHTML = (sw.steps || []).map((name) => { const k = matchPart(name); return `<span class="lg">${chip(k)}${esc(name)}</span>`; }).join('')
      + (sw.rows.every((r) => Number.isFinite(r.all)) ? `<span class="lg"><span class="lg-all"></span>${T('all five in one run', '五步一次做完')}</span>` : '')
      + `<span class="lg"><span class="lg-now"></span>${T('current slider value', '滑桿目前的值')}</span>`;
    const seeds = Array.isArray(sw.seeds) ? sw.seeds : [];
    $('[data-role="sweep-src"]').innerHTML = T(
      `Teaching simulation: ${sw.trials} trials per value, ${seeds.length || 'unknown number of'} seeds${seeds.length ? ' (' + seeds.slice(0, 12).join(', ') + (seeds.length > 12 ? ', …' : '') + ')' : ''}. Generated ${sw.generated || 'at an unrecorded time'}. Perception is the oracle: the true pose, the hand-eye error applied geometrically, depth noise from an error model fitted to the image pipeline (config.ORACLE). Not the paper's Table 3: that table has no noise setting and counts perception, not seating.`,
      `教學模擬：每個值試 ${sw.trials} 次，種子 ${seeds.length || '數目不明'} 個${seeds.length ? '（' + seeds.slice(0, 12).join('、') + (seeds.length > 12 ? '、…' : '') + '）' : ''}。產生時間：${sw.generated || '沒有紀錄'}。感知用 oracle：真實位姿，手眼誤差照幾何算，深度雜訊來自對影像流程擬合的誤差模型（config.ORACLE）。這不是論文的表 3：表 3 沒有雜訊設定，量的是感知，不是有沒有裝上去。`)
      + (sw.note ? ' ' + esc(sw.note) : '');
  }

  // ── lab events
  let lastBind = 0;
  const on = {
    ready(d) {
      root.dataset.state = 'ready';
      if (d?.quality) { const sel = $('[data-hud="quality"]'); if (!sel.dataset.touched && [...sel.options].some((o) => o.value === d.quality)) sel.title = 'running at ' + d.quality; }
    },
    telemetry(d) {
      state.tele = d;
      if (Number.isFinite(d.fps)) hud.fps.textContent = num(d.fps, 0) + ' fps';
      if (activeTab === 'telemetry' && state.shown) paintTelemetry(d);
      if (activeTab === 'manual' && state.shown) {
        d.q?.forEach((v, i) => jointKnobs[i]?.set(+(v * DEG).toFixed(1)));
        if (d.grip) gripKnob.set(Math.round(d.grip.width * 1000));
      }
      const now = performance.now();
      if (now - lastBind < 90) return;     // at most about 10 writes a second to the article
      lastBind = now;
      d.q?.forEach((v, i) => bind('telemetry.q.' + i, v));
      if (d.tcp) { bind('telemetry.tcp.p', d.tcp.p); bind('telemetry.tcp.rpy', d.tcp.rpy); }
      if (d.grip) bind('telemetry.grip.width', d.grip.width);
      if (d.A) bind('telemetry.A', d.A);
    },
    waypoints(d) {
      bind('waypoints.P', d.P); bind('waypoints.T', d.T); bind('waypoints.coeffs', d.coeffs); bind('waypoints.index', d.index);
      d.points?.forEach((p, i) => bind('waypoints.points.' + i, p));
    },
    capture(d) {
      const hasPixel = d.K && d.pixel && d.camToWorld;
      const Pc = hasPixel ? backproject(d.K, d.pixel.u, d.pixel.v, d.pixel.d) : d.P_cam;
      const Pw = hasPixel ? transformPoint(d.camToWorld, Pc) : d.P_world;
      const delta = Pw && d.check ? Math.hypot(Pw[0] - d.check[0], Pw[1] - d.check[1], Pw[2] - d.check[2]) * 1000 : null;
      bind('capture.K', d.K); bind('capture.camToWorld', d.camToWorld); bind('capture.view', d.view); bind('capture.k', d.k);
      if (d.pixel) { bind('capture.pixel.u', d.pixel.u); bind('capture.pixel.v', d.pixel.v); bind('capture.pixel.d', d.pixel.d); }
      bind('capture.P_cam', d.P_cam ?? Pc); bind('capture.P_world', d.P_world ?? Pw); bind('capture.check', d.check); bind('capture.delta_mm', delta);
      if (Pw) put(strip.eq5.f, formatBind(Pw, { unit: 'm', digits: 4 }));
      if (d.check) put(strip.eq5.m, formatBind(d.check, { unit: 'm', digits: 4 }));
      if (delta != null) put(strip.eq5.d, num(delta, 3) + ' mm');
    },
    cloud(d) {
      const key = matchPart(d.part) || d.part;
      bind(`cloud.${key}.nPoints`, d.nPoints); bind(`cloud.${key}.centroid`, d.centroid);
    },
    icp(d) {
      bind('icp.iter', d.iter); bind('icp.rmse', d.rmse); bind('icp.T_rou', d.T_rou); bind('icp.R', d.R); bind('icp.T', d.T); bind('icp.converged', d.converged);
      put(strip.icp.iter, `${d.iter} / ${params['icp.maxIters']}${d.converged ? ' ✓' : ''}`);
      if (Number.isFinite(d.rmse)) put(strip.icp.rmse, num(d.rmse * 1000, 2) + ' mm');
      if (d.R) put(strip.icp.th, num(yawAboutY(d.R) * DEG, 2) + '°');
    },
    step(d) {
      const prev = state.steps[d.index] || {};
      const s = { ...prev, ...d };
      state.steps[d.index] = s;
      const n = state.plan?.triples.length ?? 0;
      const triple = d.triple ?? state.plan?.triples[d.index];
      hud.stepno.textContent = `Step ${d.index + 1}/${n}`;
      hud.triple.innerHTML = tripleHtml(triple);
      setStatus(hud.status, d.status);
      paintStep(d.index, s);
      const e = d.error;
      bind('step.index', d.index + 1); bind('step.triple', Array.isArray(triple) ? `⟨${triple.join(', ')}⟩` : triple); bind('step.status', d.status); bind('step.reason', d.reason || '');
      if (e) {
        bind('step.error.pos_mm', e.pos_mm); bind('step.error.height_mm', e.height_mm); bind('step.error.tilt_deg', e.tilt_deg);
        if (Number.isFinite(e.pos_mm)) { put(strip.step.pos, num(e.pos_mm, 2) + ' mm'); lim(strip.step.pos, e.pos_mm >= CFG.SUCCESS.posMm); }
        if (Number.isFinite(e.height_mm)) { put(strip.step.hgt, num(e.height_mm, 2) + ' mm'); lim(strip.step.hgt, Math.abs(e.height_mm) >= CFG.SUCCESS.heightMm); }
        if (Number.isFinite(e.tilt_deg)) { put(strip.step.tilt, num(e.tilt_deg, 2) + '°'); lim(strip.step.tilt, e.tilt_deg >= CFG.SUCCESS.tiltDeg); }
      }
      if (['success', 'fail', 'skipped'].includes(d.status)) {
        const text = `Step ${d.index + 1} of ${n}: ${d.status}${d.reason ? ', ' + d.reason : ''}`;
        say(text);
        canvasHost.setAttribute('aria-label', '3D lab. ' + text);
      }
    },
    plan(d) {
      state.planEvt = d;
      renderCount();
      bind('plan.id', d.id); bind('plan.n', d.n); bind('plan.done', d.done); bind('plan.success', d.success); bind('plan.fail', d.fail);
    },
    log(d) { hud.log.textContent = d?.text ?? ''; hud.log.dataset.level = d?.level ?? 'info'; },
  };

  // ── data, then the lab
  const [paper, plansJson, sweepJson] = await Promise.all([ctx.paper ?? fetchJson('data/paper.json'), fetchJson('data/lab/plans.json'), fetchJson('data/lab/sweep.json')]);
  state.paper = paper;
  state.plansNote = plansJson?.note || '';
  const paperPlan = { id: 'paper', label: 'Paper, Fig. 7', model: 'paper', variant: null, run: null, source: 'paper', image: null, utc: null, triples: CFG.PAPER_PLAN, raw: null };
  const extraPlans = (plansJson?.plans || []).filter((p) => p && p.id !== 'paper' && Array.isArray(p.triples) && p.triples.every((t) => Array.isArray(t) && t.length === 3));
  state.plans = [paperPlan, ...extraPlans];
  state.plan = paperPlan;
  fillPickers(); renderPlan();
  setupSweep(sweepJson);

  function showFallback(err) {
    root.dataset.state = 'fallback';
    canvasHost.hidden = true;
    fallback.hidden = false;
    fallback.innerHTML = `<div class="fb-box"><p class="fb-title">${tag('Demo')} ${T('The 3D lab could not start on this device.', '這台裝置開不了 3D 實驗室。')}</p>`
      + `<p class="fb-why">${T('Reason', '原因')}: <code>${esc(err?.message || err)}</code></p>`
      + `<p>${T('The plan table, the paper numbers and the formulas still work. A recorded run is shown here when the file exists.', '計劃表、論文數字與公式仍然可用。有錄好的畫面時會顯示在這裡。')}</p>`
      + `<figure class="fb-media"><video muted playsinline controls preload="none" poster="${assetUrl('media/fallback/lab.jpg')}"><source src="${assetUrl('media/fallback/lab.mp4')}" type="video/mp4"></video><figcaption>${T('Recorded run of the same lab (media/fallback/lab.mp4)', '同一個實驗室的錄影（media/fallback/lab.mp4）')}</figcaption></figure></div>`;
    const media = fallback.querySelector('.fb-media'), video = media.querySelector('video');
    const probe = new Image();
    probe.onerror = () => { media.classList.add('is-missing'); video.remove(); media.querySelector('figcaption').innerHTML = T('No recording yet: media/fallback/lab.mp4 and lab.jpg are not in this copy.', '還沒有錄影：這一份裡沒有 media/fallback/lab.mp4 與 lab.jpg。'); };
    probe.src = assetUrl('media/fallback/lab.jpg');
    for (const b of $$('.lab-hud button, .lab-hud select, .plan-go button, .manual-go button')) if (b.dataset.hud !== 'full') b.disabled = true;
    for (const k of [...Object.values(knobs), ...jointKnobs, gripKnob]) k.disable(true);
    say('3D lab unavailable: ' + (err?.message || err));
  }

  try {
    let factory = ctx.createLab;
    if (!factory) {
      const probe = document.createElement('canvas');
      if (!probe.getContext('webgl2')) throw new Error('WebGL2 is not available');
      factory = (await import('../lab/index.js')).createLab;
      if (typeof factory !== 'function') throw new Error('js/lab/index.js has no createLab()');
    }
    const reduced = !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    lab = await factory(canvasHost, { quality: 'auto', seed: CFG.SEED, reducedMotion: reduced });
    for (const type of LAB_EVENTS) {
      lab.on?.(type, (d) => {
        try { on[type]?.(d); } catch (e) { report(e); }
        emit('lab:' + type, d);
      });
    }
    root.dataset.state = 'ready';
    try { window.__labDebug = lab.debug; window.__lab = lab; } catch { /* tools only */ }
    lab.onOrbit?.((on) => paintOrbit(on));
    const p0 = call((l) => l.getParams?.());
    if (p0 && typeof p0 === 'object') for (const [k, v] of Object.entries(p0)) if (k in params && Number.isFinite(v)) { params[k] = v; knobs[k]?.set(v); }
    for (const [k, v] of Object.entries(params)) bind('param.' + k, v);
    call((l) => l.loadPlan({ id: paperPlan.id, model: paperPlan.model, variant: null, run: null, triples: paperPlan.triples, source: 'paper' }));
    bind('plan.id', paperPlan.id); bind('plan.n', paperPlan.triples.length);
    const st0 = call((l) => l.getState?.());
    if (st0?.q) { state.tele = st0; }
    setCamera('hero');
  } catch (e) {
    lab = null;
    showFallback(e);
    for (const [k, v] of Object.entries(params)) bind('param.' + k, v);
  }

  // ── actions from the article:  data-act="lab:<action>[:args]"
  async function act(action, args, opts = {}) {
    const parts = String(action ?? '').replace(/^lab:/, '').split(':');
    if (Array.isArray(args)) parts.push(...args.map(String));
    else if (args != null && args !== '') parts.push(...String(args).split(':'));
    const [name, ...rest] = parts;
    // The article scrolled to a block (auto): only change what is shown. A step that is running is never interrupted.
    const running = !!state.tele?.running;
    if (opts.auto && running && !['tab', 'view', 'camera', 'labels'].includes(name)) return false;
    switch (name) {
      case 'tab': if (!rest[0]) return false; showTab(rest[0]); return true;
      case 'view': {                       // lab:view:<camera>[:<panel>]  camera and inner panel, nothing else
        if (rest[0]) setCamera(rest[0]);
        if (rest[1]) showTab(rest[1]);
        return true;
      }
      case 'reset': doReset(); return true;
      case 'step': await doStep(); return true;
      case 'pause': setPaused(!state.paused); return true;
      case 'resume': setPaused(false); return true;
      case 'camera': if (!rest[0]) return false; setCamera(rest[0]); return true;
      case 'plan': { const ok = loadPlan(rest.join(':')); if (ok) showTab('plan'); return ok; }
      case 'param': {
        const ok = setParam(rest[0], parseFloat(rest[1]));
        if (ok) { showTab('params'); knobs[rest[0]]?.el.scrollIntoView?.({ block: 'nearest' }); }
        return ok;
      }
      case 'labels': setLabels(true); await call((l) => l.act('labels', rest)); return true;
      case 'run': if (state.paused) setPaused(false); showTab('steps'); await call((l) => l.act('run', rest)); return true;
      default:
        if (!DEMO_ACTS.includes(name)) { report(new Error('unknown lab action: ' + name)); return false; }
        if (state.paused) setPaused(false);
        if (name === 'waypoints' || name === 'fuse' || name === 'backproject' || name === 'icp') showTab('params');
        await call((l) => l.act(name, rest));
        return true;
    }
  }

  return {
    act,
    onShow() { state.shown = true; call((l) => l.setPaused(false)); call((l) => l.resize?.()); },
    onHide() { state.shown = false; call((l) => l.setPaused(true)); },
    dispose() {
      ro?.disconnect(); document.removeEventListener('fullscreenchange', onFsChange);
      call((l) => l.dispose()); lab = null; root.remove();
    },
    get lab() { return lab; },
    showTab,
  };
}
