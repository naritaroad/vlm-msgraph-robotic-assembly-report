// stage.js — the stage side: view tabs, lazy mounting of the four view modules, action dispatch,
// stage size (dock / bar / full), the status line, and the Lab fallback.
//
// Contract with the view modules (site/js/stage/*.js, other owners):
//
//   export async function mount(el, ctx)  →  { act(action, args, { auto }), onShow(), onHide() }
//   auto is true when the article's scroll position asked for the action, not a person pressing a button.
//
//   ctx.bus.on(type, fn) / ctx.bus.emit(type, data)   one bus shared by every module
//   ctx.bind(key, value)                              writes every <output data-bind="key">
//   ctx.lang()                                        'en' | 'zh' | 'both'
//   ctx.katex                                         the KaTeX object
//   ctx.setStatus(text)                               writes .stage-status (text or { en, zh })
//
// A data-act of "lab:param:depth.sigmaMm:3" becomes  act('param', ['depth.sigmaMm', '3'])  on the lab module.
// The Space key sends act('primary', []) to the current view.

import { $, $$, L, text2, esc } from './dom.js';

const VIEWS = ['lab', 'real', 'graph', 'scores'];
const MODULE = { lab: 'labpanel.js', real: 'real.js', graph: 'graph.js', scores: 'scores.js' };
const NAME = { lab: 'Lab', real: 'Real', graph: 'Graph', scores: 'Scores' };
const BUSY_MS = 6000;

export function parseAct(str) {
  const [component, action = '', ...args] = String(str || '').trim().split(':');
  return { component, action, args };
}

export function createStage({ bus, bind, lang, katex, info = {}, paper = null }) {
  const root = document.documentElement;
  const stage = $('#stage');
  const statusEl = $('.stage-status', stage);
  const bar = $('.stage-bar', stage);
  const barTab = $('.stage-bar-tab', stage);
  const barStatus = $('.stage-bar-status', stage);
  const btnFull = $('#stage-full');
  const btnMin = $('#stage-min');
  const tabs = Object.fromEntries($$('[role="tab"]', stage).map((t) => [t.dataset.stage, t]));
  const panes = Object.fromEntries(VIEWS.map((v) => [v, $(`#pane-${v}`)]));
  const mqOne = window.matchMedia('(max-width: 1099.98px)');
  const mqPhone = window.matchMedia('(max-width: 767.98px)');
  const params = new URLSearchParams(location.search);

  const handles = {};        // view → handle | { missing: true }
  const loading = {};        // view → Promise
  let current = 'lab';
  let pending = null;        // last action asked for while the stage was a bar
  let lastInput = -1e9;
  let sizeBeforeFull = null;
  let returnFocus = null;
  const sizeListeners = new Set();

  // ── status ──
  function setStatus(text) {
    const html = text ? `<span>${text2(text)}</span>` : '';
    statusEl.innerHTML = html;
    barStatus.innerHTML = text ? text2(text) : '';
  }

  const ctx = Object.freeze({ bus, bind, lang, katex, setStatus, status: setStatus, paper });

  // ── panels for "loading" and "not available" ──
  function emptyPanel(state, view, detail) {
    const name = NAME[view];
    const msg = {
      loading: [L(`Loading ${name}`, `正在載入 ${name}`), ''],
      missing: [L(`${name} is not in this copy of the report.`, `這份報告還沒有 ${name} 分頁。`),
        `<p>${L('The other views and the article still work.', '其他分頁和文章照常可用。')}</p>`],
      error: [L(`${name} could not start.`, `${name} 沒有啟動。`),
        `<p><code>${esc(detail || '')}</code></p><p>${L('Reload the page to try again.', '重新整理頁面再試一次。')}</p>`],
    }[state];
    const div = document.createElement('div');
    div.className = 'pane-empty';
    div.dataset.state = state;
    div.innerHTML = `<section class="panel"><header class="panel-head"><h3 class="panel-name">${esc(name)}</h3>`
      + `<span class="panel-ref">${state === 'loading' ? 'loading' : 'not available'}</span></header>`
      + `<div class="panel-body"><p>${msg[0]}</p>${msg[1]}</div></section>`;
    return div;
  }

  // ── Lab fallback: no WebGL2, or ?nolab=1 ──
  function labOff() {
    if (params.has('nolab') && params.get('nolab') !== '0') return 'param';
    try {
      const c = document.createElement('canvas');
      if (!c.getContext('webgl2')) return 'webgl';
    } catch { return 'webgl'; }
    return '';
  }
  function fallbackFile(action) {
    const files = Array.isArray(info.fallback) ? info.fallback : [];
    const by = (re) => files.find((f) => re.test(f));
    const stem = (s) => s.replace(/[^a-z0-9_-]/gi, '');
    return (action && by(new RegExp(`/${stem(action)}\\.(mp4|webm)$`, 'i')))
      || (action && by(new RegExp(`/${stem(action)}\\.(jpe?g|png|webp)$`, 'i')))
      || by(/\/lab\.(mp4|webm)$/i) || by(/\.(mp4|webm)$/i) || by(/\/lab\.(jpe?g|png|webp)$/i) || by(/\.(jpe?g|png|webp)$/i) || '';
  }
  function mountFallback(pane, why) {
    const reason = why === 'param'
      ? L('The 3D lab is turned off for this visit (?nolab=1 in the address).', '這次開啟關掉了 3D 實驗室（網址有 ?nolab=1）。')
      : L('The 3D lab needs WebGL2, and this browser does not provide it.', '3D 實驗室需要 WebGL2，這個瀏覽器沒有提供。');
    const wrap = document.createElement('div');
    function media(action) {
      const f = fallbackFile(action);
      if (!f) return '';
      if (/\.(mp4|webm)$/i.test(f)) {
        const poster = (info.fallback || []).find((x) => x.replace(/\.\w+$/, '') === f.replace(/\.\w+$/, '') && /\.(jpe?g|png|webp)$/i.test(x));
        const vtt = (info.fallback || []).find((x) => x.replace(/\.\w+$/, '') === f.replace(/\.\w+$/, '') && /\.vtt$/i.test(x));
        return `<video src="${esc(f)}" controls muted playsinline preload="metadata"${poster ? ` poster="${esc(poster)}"` : ''}>`
          + (vtt ? `<track kind="captions" src="${esc(vtt)}" srclang="en" default>` : '') + '</video>';
      }
      return `<img src="${esc(f)}" alt="${lang() === 'zh' ? '3D 實驗室的錄製畫面' : 'Recorded frame of the 3D lab'}">`;
    }
    function render(action) {
      const m = media(action);
      const panel = `<section class="panel"><header class="panel-head"><h3 class="panel-name">Lab</h3>`
        + `<span class="panel-ref">${m ? 'recording' : 'not available'}</span><span class="tag" data-tag="Demo">Demo</span></header>`
        + `<div class="panel-body"><p>${reason}</p><p>${m
          ? L('This is a recording of the same lab. The buttons in the article do not move it.', '這是同一個實驗室的錄影。文章裡的按鈕不會讓它動。')
          : L('No recording is in this copy either. The Real, Graph and Scores views still work.', '這份報告也還沒有備援錄影。Real、Graph、Scores 分頁照常可用。')}</p></div></section>`;
      wrap.className = m ? 'fallback' : 'pane-empty';
      wrap.dataset.state = 'fallback';
      wrap.innerHTML = m ? `<div class="fallback-media">${m}</div>${panel}` : panel;
    }
    render('');
    pane.replaceChildren(wrap);
    return {
      fallback: true,
      act(action) {
        if (action && fallbackFile(action) !== fallbackFile('')) render(action);
        setStatus({ en: `Lab is off: lab:${action} not run`, zh: `Lab 沒有開：lab:${action} 沒有執行` });
      },
      onShow() {}, onHide() { wrap.querySelector('video')?.pause(); },
    };
  }

  // ── lazy mount ──
  function ensure(view) {
    if (handles[view]) return Promise.resolve(handles[view]);
    if (loading[view]) return loading[view];
    const pane = panes[view];
    const off = view === 'lab' ? labOff() : '';
    if (off) { handles[view] = mountFallback(pane, off); return Promise.resolve(handles[view]); }
    if (info.stage && info.stage[view] === false) {
      pane.replaceChildren(emptyPanel('missing', view));
      tabs[view]?.classList.add('is-missing');
      handles[view] = { missing: true };
      return Promise.resolve(handles[view]);
    }
    const veil = emptyPanel('loading', view);
    veil.style.cssText = 'position:absolute;inset:0;z-index:2;pointer-events:none';
    pane.replaceChildren(veil);
    loading[view] = import(new URL(`../stage/${MODULE[view]}`, import.meta.url).href)
      .then((mod) => mod.mount(pane, ctx))
      .then((h) => {
        veil.remove();
        handles[view] = h && typeof h === 'object' ? h : {};
        return handles[view];
      })
      .catch((e) => {
        console.error(`[stage] ${view}`, e);
        pane.replaceChildren(emptyPanel('error', view, e?.message || String(e)));
        handles[view] = { missing: true };
        return handles[view];
      })
      .finally(() => { delete loading[view]; });
    return loading[view];
  }

  const hidden = () => size() === 'bar';
  const call = (h, fn, ...a) => { try { return h?.[fn]?.(...a); } catch (e) { console.error(`[stage] ${fn}`, e); } };

  // ── tabs ──
  function select(view) {
    for (const v of VIEWS) {
      const on = v === view;
      tabs[v]?.setAttribute('aria-selected', String(on));
      if (tabs[v]) tabs[v].tabIndex = on ? 0 : -1;
      if (panes[v]) panes[v].hidden = !on;
    }
    barTab.textContent = NAME[view];
  }
  async function show(view, { focus = false } = {}) {
    if (!VIEWS.includes(view)) return null;
    const prev = current;
    if (prev !== view) {
      call(handles[prev], 'onHide');
      current = view;
      select(view);
      setStatus('');
      bus.emit('stage:show', { view, prev });
    }
    if (focus) tabs[view]?.focus();
    if (hidden()) return null;
    const h = await ensure(view);
    if (current === view && !hidden()) call(h, 'onShow');
    return h;
  }

  /** Run "component:action[:args]" on the stage. user = the person pressed something (opens a collapsed stage). */
  async function dispatch(component, action, args = [], { user = false, trigger = null, auto = false } = {}) {
    if (!VIEWS.includes(component)) {
      setStatus({ en: `No stage view called "${component}"`, zh: `沒有叫「${component}」的舞台分頁` });
      return false;
    }
    if (hidden()) {
      if (!user) { pending = { component, action, args }; if (current !== component) { current = component; select(component); } return false; }
      returnFocus = trigger;
      setSize(mqPhone.matches ? 'full' : 'dock');
    }
    pending = null;
    const h = await show(component);
    if (!h || h.missing || typeof h.act !== 'function') {
      if (h?.missing) setStatus({ en: `${NAME[component]} is not available: ${component}:${action} not run`, zh: `${NAME[component]} 還不能用：${component}:${action} 沒有執行` });
      return false;
    }
    try {
      await h.act(action, args.map(String), { auto });
      bus.emit('stage:act', { component, action, args, auto });
      return true;
    } catch (e) {
      console.error(`[stage] ${component}:${action}`, e);
      setStatus({ en: `${component}:${action} failed: ${e?.message || e}`, zh: `${component}:${action} 沒有成功：${e?.message || e}` });
      return false;
    }
  }
  const run = (str, opts) => { const a = parseAct(str); return dispatch(a.component, a.action, a.args, opts); };
  const primary = () => (hidden() ? false : dispatch(current, 'primary', []));

  // ── size: dock (default), bar (one row), full ──
  function size() {
    const s = root.dataset.stageSize || 'dock';
    if (s === 'bar' && !mqOne.matches) return 'dock';
    return s;
  }
  function setSize(next) {
    const prev = size();
    if (next === 'bar' && !mqOne.matches) next = 'dock';
    if (next === 'dock' && mqPhone.matches) next = 'bar';
    if (next === prev && root.dataset.stageSize === next) return;
    if (next === 'full' && prev !== 'full') sizeBeforeFull = prev;
    root.dataset.stageSize = next;
    bar.setAttribute('aria-expanded', String(next !== 'bar'));
    btnFull.setAttribute('aria-pressed', String(next === 'full'));
    for (const el of [$('#article'), $('#mainline'), $('#rail'), $('#cover'), $('#splitter')]) if (el) el.inert = next === 'full';
    if (next === 'bar') call(handles[current], 'onHide');
    else {
      ensure(current).then((h) => {
        if (hidden()) return;
        call(h, 'onShow');
        if (pending && pending.component === current) { const p = pending; pending = null; dispatch(p.component, p.action, p.args); }
      });
    }
    if (next === 'full') tabs[current]?.focus({ preventScroll: true });
    else if (prev === 'full') { (returnFocus?.isConnected ? returnFocus : next === 'bar' ? bar : btnFull)?.focus?.({ preventScroll: true }); returnFocus = null; }
    for (const fn of sizeListeners) fn(next, prev);
    bus.emit('stage:size', { size: next, prev });
  }
  function toggleFull() {
    if (size() === 'full') setSize(mqPhone.matches ? 'bar' : (sizeBeforeFull && sizeBeforeFull !== 'full' ? sizeBeforeFull : 'dock'));
    else { returnFocus = document.activeElement; setSize('full'); }
  }
  const exitFull = () => { if (size() === 'full') { toggleFull(); return true; } return false; };

  // ── wiring ──
  for (const v of VIEWS) {
    tabs[v]?.addEventListener('click', () => { touch(); show(v); });
  }
  $('.stage-tabs', stage)?.addEventListener('keydown', (e) => {
    const i = VIEWS.indexOf(document.activeElement?.dataset?.stage);
    if (i < 0) return;
    const to = e.key === 'ArrowRight' ? (i + 1) % 4 : e.key === 'ArrowLeft' ? (i + 3) % 4 : e.key === 'Home' ? 0 : e.key === 'End' ? 3 : -1;
    if (to < 0) return;
    e.preventDefault();
    e.stopPropagation();
    show(VIEWS[to], { focus: true });
  });
  bar.addEventListener('click', () => { returnFocus = bar; setSize(mqPhone.matches ? 'full' : 'dock'); });
  btnFull.addEventListener('click', toggleFull);
  btnMin.addEventListener('click', () => { setSize('bar'); bar.focus({ preventScroll: true }); });

  function touch() { lastInput = performance.now(); }
  for (const type of ['pointerdown', 'keydown', 'wheel', 'input', 'touchstart']) {
    stage.addEventListener(type, touch, { capture: true, passive: true });
  }
  /** True while the person is working on the stage: an automatic tab switch would take it away from them. */
  const busy = () => performance.now() - lastInput < BUSY_MS;

  const onMq = () => {
    const s = root.dataset.stageSize || 'dock';
    if (s === 'full') return;
    if (mqPhone.matches) setSize('bar');
    else if (!mqOne.matches && s === 'bar') setSize('dock');
    else if (mqOne.matches && !mqPhone.matches && s === 'bar' && !userShrunk) setSize('dock');
  };
  let userShrunk = false;
  btnMin.addEventListener('click', () => { userShrunk = true; });
  bar.addEventListener('click', () => { userShrunk = false; });
  mqOne.addEventListener?.('change', onMq);
  mqPhone.addEventListener?.('change', onMq);

  // first state
  select(current);
  if (mqPhone.matches) { root.dataset.stageSize = 'bar'; bar.setAttribute('aria-expanded', 'false'); }
  else { root.dataset.stageSize = 'dock'; bar.setAttribute('aria-expanded', 'true'); }
  // Nothing is mounted yet: the first show() (from the first knowledge point) decides which module loads.

  return {
    ctx, bus, bind, views: VIEWS,
    get current() { return current; },
    show, dispatch, run, primary, parse: parseAct, setStatus,
    size, setSize, toggleFull, exitFull, busy,
    onSize(fn) { sizeListeners.add(fn); return () => sizeListeners.delete(fn); },
  };
}
