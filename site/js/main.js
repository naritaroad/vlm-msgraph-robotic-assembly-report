// main.js — starts the main page. Each part is its own module in ./ui/; a part that fails logs its error
// and the rest of the page keeps working.
//
// Order matters in four places:
//   1. KaTeX (a classic deferred script) has run before this module, so window.katex exists;
//   2. the symbol table is in before formulas are typeset, so every symbol in them can be pressed;
//   3. the stage and its ctx exist before ./stage/formulas.js is imported and init(ctx) is called once;
//   4. formulas are typeset before the first jump to a #kpNN hash, so the jump lands in the right place.

import { $$, readJSON } from './ui/dom.js';
import * as prefs from './ui/prefs.js';
import { createBus, createBind, format } from './ui/bind.js';
import { typeset, refit, refitOne, tagTex, valTex, renderTex, getSymbol } from './ui/math.js';
import { createStage, parseAct } from './ui/stage.js';
import { createNav } from './ui/nav.js';
import { createTimer } from './ui/timer.js';
import { createPop } from './ui/pop.js';
import { createLightbox } from './ui/lightbox.js';
import { createSettings } from './ui/settings.js';
import { createSplit } from './ui/split.js';
import { initKeys } from './ui/keys.js';
import { createEnding } from './ui/ending.js';
import { createModelEmbeds } from './models/embed.js';
import { createFigs } from './ui/figs.js';

const info = readJSON('build-info') || {};
const katex = window.katex || null;
const attempt = (name, fn) => { try { return fn(); } catch (e) { console.error(`[main] ${name}`, e); return null; } };

attempt('prefs', prefs.initPrefs);
const bus = createBus();
const bind = attempt('bind', () => createBind(document)) || (() => {});
const pop = attempt('pop', () => createPop({ katex }));

// The stage views get a KaTeX that tags symbols and pieces too, so formulas on the stage open boxes like the article's.
const stageKatex = katex && { ...katex, render: (t, el, o = {}) => renderTex(el, t, katex, { display: !!o.displayMode, kp: '' }) };
const stage = attempt('stage', () => createStage({ bus, bind, lang: prefs.lang, katex: stageKatex || katex, info, paper: info.paper || null }));
// words on the stage open the same boxes as words in the article
if (pop) for (const pane of document.querySelectorAll('#stage .pane')) pop.watch(pane);
prefs.onLang((l) => { bus.emit('lang', l); refit(); });
prefs.onTheme((t) => bus.emit('theme', t));

// The cover's 3D loop is its own small scene; it never blocks the report below it.
attempt('cover', () => {
  import(new URL('./ui/cover.js', import.meta.url).href)
    .then((m) => m.createCover?.({ bus }))
    .then((c) => { window.__cover = c; })
    .catch((e) => console.warn('[main] cover.js not loaded:', e.message));
});

async function boot() {
  // symbols first (with a short timeout so a slow disk never blanks the formulas)
  if (pop) await Promise.race([pop.ready, new Promise((r) => setTimeout(r, 1500))]);
  attempt('math', () => typeset(document, katex));
  attempt('models', () => createModelEmbeds(document));   // frames now, so later layout does not shift
  attempt('figs', createFigs);
  if (!stage) return;

  // Not a view: fills every .eq-live[data-live] and .shapes. Skipped when the build says the file is absent.
  if (info.formulas !== false) {
    import(new URL('./stage/formulas.js', import.meta.url).href)
      .then((m) => m.init?.({ ...stage.ctx, tagTex, valTex, renderTex, refitOne, prefs, getSymbol }))
      .catch((e) => console.warn('[main] formulas.js not loaded:', e.message));
  }

  const nav = attempt('nav', () => createNav({ stage, bus }));
  if (nav) prefs.onLang(() => requestAnimationFrame(() => nav.relayout()));
  const timer = nav && attempt('timer', () => createTimer({ nav, info }));
  const lightbox = attempt('lightbox', createLightbox);
  const settings = attempt('settings', () => createSettings({}));
  attempt('split', () => createSplit({ onChange: () => { refit(); } }));
  attempt('ending', createEnding);
  if (nav && timer && lightbox) attempt('keys', () => initKeys({ nav, stage, timer, pop, lightbox, settings }));

  // Buttons in the article that drive the stage: data-act="component:action[:args]".
  attempt('acts', () => {
    const NAME = { lab: 'Lab', real: 'Real', graph: 'Graph', scores: 'Scores' };
    for (const b of $$('[data-act]')) {
      if (b.tagName === 'BUTTON') b.type = 'button';
      const { component } = parseAct(b.dataset.act);
      if (NAME[component] && b.classList.contains('act') && !b.querySelector('.act-dest')) {
        const chip = document.createElement('span');
        chip.className = 'act-dest';
        chip.textContent = NAME[component];
        b.append(chip);
      }
    }
    document.addEventListener('click', (e) => {
      const b = e.target.closest?.('[data-act]');
      if (!b) return;
      e.preventDefault();
      b.classList.remove('is-sent');
      void b.offsetWidth;
      b.classList.add('is-sent');
      stage.run(b.dataset.act, { user: true, trigger: b });
    });
  });

  // Fold each formula's .eq-live, dl.io, and table.sym into a collapsible <details class="eq-drawer">.
  attempt('eqDrawers', () => {
    const isOpen = String(prefs.get('eqopen') ?? '0') === '1';
    const drawers = [];
    for (const fig of $$('figure.eq')) {
      const live = fig.querySelector(':scope > .eq-live');
      const extras = [];
      let cur = fig.nextElementSibling;
      for (let step = 0; cur && step < 4; step++) {
        const next = cur.nextElementSibling;
        if (cur.matches('figure.eq, section, h2, h3, h4, article.flaw, aside.good, aside.whynot, ol.steps, div.do, div.pair')) break;
        if (cur.matches('dl.io, table.sym')) extras.push(cur);
        else if (cur.matches('.table-wrap') && cur.querySelector('table.sym')) extras.push(cur);
        cur = next;
      }
      if (!live && !extras.length) continue;
      const symTable = extras.find((x) => x.matches('table.sym')) || extras.find((x) => x.querySelector?.('table.sym'))?.querySelector('table.sym');
      const symCount = symTable ? symTable.querySelectorAll('tbody tr').length : 0;
      const hasIo = extras.some((x) => x.matches('dl.io'));
      const d = document.createElement('details');
      d.className = 'eq-drawer';
      d.open = isOpen;
      const sum = document.createElement('summary');
      sum.className = 'eq-drawer-bar';
      const labelEn = hasIo && symCount
        ? `Formula details · Purpose, I/O &amp; ${symCount} symbols`
        : symCount
          ? `Formula details · ${symCount} symbols &amp; values`
          : hasIo
            ? 'Formula details · Purpose &amp; I/O'
            : 'Formula details · Substituted values';
      const labelZh = hasIo && symCount
        ? `公式明細 · 用途、輸入輸出與 ${symCount} 個符號`
        : symCount
          ? `公式明細 · ${symCount} 個符號與數值`
          : hasIo
            ? '公式明細 · 用途與輸入輸出'
            : '公式明細 · 代入數值';
      sum.innerHTML = `<span class="eq-drawer-title"><span class="en">${labelEn}</span><span class="zh">${labelZh}</span></span>`
        + `<span class="eq-drawer-hint"><span class="en" data-open="Collapse" data-closed="Expand">Expand</span><span class="zh" data-open="收合" data-closed="展開">展開</span></span>`;
      const body = document.createElement('div');
      body.className = 'eq-drawer-body';
      if (live) body.append(live);
      for (const ex of extras) body.append(ex);
      d.append(sum, body);
      fig.append(d);
      drawers.push(d);
    }
    prefs.on('eqopen', (v) => {
      const open = String(v) === '1';
      for (const d of drawers) d.open = open;
    });
  });

  // A wide table scrolls inside its own box, never the page. The fade on the right says there is more.
  attempt('tables', () => {
    const mark = (w) => {
      const more = w.scrollWidth > w.clientWidth + 1;
      w.classList.toggle('is-scroll', more);
      w.classList.toggle('at-end', more && w.scrollLeft + w.clientWidth >= w.scrollWidth - 2);
      if (more) { w.tabIndex = 0; w.setAttribute('role', 'group'); w.setAttribute('aria-label', prefs.lang() === 'zh' ? '表格，可左右捲動' : 'Table, scrolls sideways'); }
      else { w.removeAttribute('tabindex'); w.removeAttribute('role'); w.removeAttribute('aria-label'); }
    };
    const wraps = $$('.kp table').filter((t) => !t.closest('.ptable, .table-wrap')).map((t) => {
      const w = document.createElement('div');
      w.className = 'table-wrap';
      t.replaceWith(w);
      w.append(t);
      return w;
    }).concat($$('.kp .ptable'));
    for (const w of wraps) {
      w.classList.add('table-wrap');
      w.addEventListener('scroll', () => mark(w), { passive: true });
    }
    const all = () => wraps.forEach(mark);
    if ('ResizeObserver' in window) { const ro = new ResizeObserver(all); wraps.forEach((w) => ro.observe(w)); } else all();
  });

  // Print the whole article: folded blocks open for the print and fold back afterwards.
  let folded = null;
  window.addEventListener('beforeprint', () => { folded = $$('details:not([open])'); folded.forEach((d) => { d.open = true; }); });
  window.addEventListener('afterprint', () => { folded?.forEach((d) => { d.open = false; }); folded = null; });

  // Public surface for the stage modules and for the console.
  window.Stage = Object.assign(stage, { format, typeset: (root) => typeset(root || document, katex), tagTex, nav, timer, prefs, pop, settings });

  nav?.start();
  // Fonts change formula widths; refit once they are in.
  document.fonts?.ready?.then(() => { refit(); nav?.relayout(); });
}
boot();
