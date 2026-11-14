// timer.js — an elapsed-time clock in the top bar, off unless the person turns it on in the settings.
// It shows time passed and nothing else: no planned minutes are printed on the public page.
// State survives a reload (sessionStorage).

import { $, clock } from './dom.js';
import { refit } from './math.js';
import * as prefs from './prefs.js';

const KEY = 'msgraph.timer';

export function createTimer({ nav }) {
  const btn = $('#hud-timer');
  const timeEl = $('.hud-time', btn);
  const resetBtn = $('#hud-reset');

  let st = { running: false, startedAt: 0, acc: 0 };
  try { st = { ...st, ...JSON.parse(sessionStorage.getItem(KEY) || '{}') }; } catch { /* no storage */ }
  const persist = () => { try { sessionStorage.setItem(KEY, JSON.stringify(st)); } catch { /* no storage */ } };
  const elapsed = () => (st.acc + (st.running ? Date.now() - st.startedAt : 0)) / 1000;

  let tick = 0;
  function paint() {
    const shown = !!prefs.get('timer');
    const t = elapsed();
    btn.hidden = !shown;
    timeEl.textContent = clock(t);
    btn.setAttribute('aria-pressed', String(st.running));
    resetBtn.hidden = !shown || st.running || t < 1;
  }
  function start() {
    if (st.running) return;
    st.running = true; st.startedAt = Date.now(); persist();
    clearInterval(tick); tick = setInterval(paint, 500); paint();
  }
  function pause() {
    if (!st.running) return;
    st.acc += Date.now() - st.startedAt; st.running = false; persist();
    clearInterval(tick); paint();
  }
  function reset() { st = { running: false, startedAt: 0, acc: 0 }; persist(); clearInterval(tick); paint(); }

  btn.addEventListener('click', () => (st.running ? pause() : start()));
  resetBtn.addEventListener('click', () => { reset(); btn.focus(); });
  if (st.running) tick = setInterval(paint, 500);
  prefs.on('timer', () => { paint(); nav.relayout(); });
  paint();

  // The text size changed: formulas refit, and the same KP stays under the header.
  prefs.on('big', () => {
    requestAnimationFrame(() => {
      refit();
      nav.relayout();
      if (!nav.atCover()) nav.currentKp?.el.scrollIntoView({ block: 'start', behavior: 'auto' });
    });
  });

  return {
    start, pause, reset, elapsed,
    toggle: () => (st.running ? pause() : start()),
    present: () => !!prefs.get('big'),
    togglePresent: () => prefs.cycle('big'),
  };
}
