// split.js — the bar between the article and the stage. Drag it, or focus it and use the arrow keys;
// double-click puts the default back. The share is kept in prefs ('split'), CSS reads it as --split.

import { $ } from './dom.js';
import * as prefs from './prefs.js';

export function createSplit({ onChange } = {}) {
  const bar = $('#splitter');
  const layout = $('#layout');
  if (!bar || !layout) return null;
  const root = document.documentElement;
  const swapped = () => root.dataset.swap === '1';

  function paint() {
    bar.setAttribute('aria-valuenow', String(Math.round(prefs.get('split') * 100)));
    onChange?.();
  }
  /** Share of the article for a pointer at clientX. */
  function shareAt(x) {
    const r = layout.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(layout).paddingLeft) || 0;
    const left = r.left + pad, width = r.width - pad;
    const f = (x - left) / Math.max(1, width);
    return swapped() ? 1 - f : f;
  }

  let dragging = false, raf = 0, pendingX = 0;
  const flush = () => { raf = 0; prefs.set('split', shareAt(pendingX), { persist: false }); paint(); };
  bar.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    dragging = true;
    bar.setPointerCapture(e.pointerId);
    bar.classList.add('is-drag');
    root.classList.add('is-splitting');
    e.preventDefault();
  });
  bar.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    pendingX = e.clientX;
    if (!raf) raf = requestAnimationFrame(flush);
  });
  const end = (e) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* already released */ }
    bar.classList.remove('is-drag');
    root.classList.remove('is-splitting');
    prefs.set('split', prefs.get('split'));           // persist once, at the end
    window.dispatchEvent(new Event('resize'));        // canvases and formulas refit
    paint();
  };
  bar.addEventListener('pointerup', end);
  bar.addEventListener('pointercancel', end);
  bar.addEventListener('dblclick', () => { prefs.set('split', prefs.DEFAULTS.split); window.dispatchEvent(new Event('resize')); paint(); });
  bar.addEventListener('keydown', (e) => {
    const dir = swapped() ? -1 : 1;
    let v = prefs.get('split');
    if (e.key === 'ArrowLeft') v -= 0.02 * dir;
    else if (e.key === 'ArrowRight') v += 0.02 * dir;
    else if (e.key === 'Home') v = prefs.SPLIT_MIN;
    else if (e.key === 'End') v = prefs.SPLIT_MAX;
    else if (e.key === 'Enter') v = prefs.DEFAULTS.split;
    else return;
    e.preventDefault(); e.stopPropagation();
    prefs.set('split', v);
    window.dispatchEvent(new Event('resize'));
    paint();
  });
  prefs.on('split', paint);
  prefs.on('swap', () => { window.dispatchEvent(new Event('resize')); paint(); });
  paint();
  return { paint };
}
