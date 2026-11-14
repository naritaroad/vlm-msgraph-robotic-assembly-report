// settings.js — the button in the bottom left corner and the panel that opens above it.
// Every switch on the page lives here; each one is a segmented control bound to a key of prefs.js.

import { $, $$, L } from './dom.js';
import * as prefs from './prefs.js';

const SYNC_NAME = { off: ['Off', '不同步'], kp: ['By section', '同步'], precise: ['By block', '精準同步'] };
const SYNC_HELP = {
  off: ['Off: scrolling the article leaves the stage alone. Buttons in the article still work.', '不同步：捲動文章不會動舞台。文章裡的按鈕照常有用。'],
  kp: ['By section: the stage changes when you reach a new section.', '同步：捲到新的一節，舞台才換。'],
  precise: ['By block: the stage changes with the paragraph you are reading. Its view, its inner panel and the 3D camera all follow.', '精準同步：舞台跟著你讀到的那一段換，分頁、裡面的小頁、3D 鏡頭都會跟。'],
};

export function createSettings({ onPrint } = {}) {
  const btn = $('#settings-btn');
  const panel = $('#settings');
  if (!btn || !panel) return null;
  const groups = $$('.seg[data-set]', panel);

  function paint() {
    for (const g of groups) {
      const key = g.dataset.set;
      const now = String(prefs.get(key));
      for (const b of $$('button', g)) {
        const on = b.dataset.v === now;
        b.setAttribute('aria-checked', String(on));
        b.tabIndex = on ? 0 : -1;
      }
    }
    const mode = prefs.get('sync');
    const help = $('[data-help="sync"]', panel);
    if (help) help.innerHTML = L(...SYNC_HELP[mode]);
    for (const el of $$('.sync-now')) el.innerHTML = L(...SYNC_NAME[mode]);
    for (const b of $$('[data-cycle="sync"]')) b.title = SYNC_HELP[mode][prefs.lang() === 'zh' ? 1 : 0];
  }

  for (const g of groups) {
    const key = g.dataset.set;
    g.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-v]');
      if (b) prefs.set(key, b.dataset.v);
    });
    g.addEventListener('keydown', (e) => {
      const list = $$('button', g);
      const i = list.indexOf(document.activeElement);
      const to = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? list[(i + 1) % list.length]
        : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? list[(i - 1 + list.length) % list.length] : null;
      if (!to) return;
      e.preventDefault(); e.stopPropagation();
      prefs.set(key, to.dataset.v);
      to.focus();
    });
    prefs.on(key, paint);
  }
  prefs.on('lang', paint);

  for (const b of $$('[data-cycle]')) b.addEventListener('click', () => prefs.cycle(b.dataset.cycle));

  panel.addEventListener('click', (e) => {
    const b = e.target.closest('[data-do]');
    if (!b) return;
    if (b.dataset.do === 'split-reset') prefs.set('split', prefs.DEFAULTS.split);
    if (b.dataset.do === 'defaults') { prefs.resetAll(); paint(); }
    if (b.dataset.do === 'print') { setOpen(false); (onPrint || (() => window.print()))(); }
  });

  const isOpen = () => !panel.hidden;
  function setOpen(open, { focus = true } = {}) {
    if (open === isOpen()) return;
    panel.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open) { paint(); if (focus) (panel.querySelector('[aria-checked="true"]') || panel).focus?.({ preventScroll: true }); }
    else if (focus && panel.contains(document.activeElement)) btn.focus({ preventScroll: true });
  }
  btn.addEventListener('click', () => setOpen(!isOpen()));
  document.addEventListener('pointerdown', (e) => {
    if (isOpen() && !panel.contains(e.target) && !btn.contains(e.target)) setOpen(false, { focus: false });
  });

  paint();
  return { open: () => setOpen(true), close: () => { if (!isOpen()) return false; setOpen(false); return true; }, toggle: () => setOpen(!isOpen()), isOpen, paint };
}
