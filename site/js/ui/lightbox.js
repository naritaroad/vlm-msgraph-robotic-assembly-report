// lightbox.js — press a paper figure to see it large; Esc or the close button returns focus to the figure.
// Also wires the keyboard-help dialog. Both use <dialog>, so focus is trapped and restored by the browser.

import { $, $$, L, esc } from './dom.js';

export function createLightbox() {
  const canModal = typeof HTMLDialogElement !== 'undefined' && 'showModal' in HTMLDialogElement.prototype;
  let dlg = null;

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'zoom-dialog on-bay';
    dlg.setAttribute('aria-labelledby', 'zoom-title');
    dlg.innerHTML = `<div class="dialog-head"><h2 id="zoom-title"></h2>`
      + `<button type="button" class="icon-btn" data-close><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`
      + `<span class="vh">${L('Close', '關閉')}</span></button></div>`
      + `<div class="dialog-body"><figure><img alt=""><figcaption></figcaption></figure></div>`;
    document.body.append(dlg);
    wire(dlg);
  }

  function wire(d) {
    d.addEventListener('click', (e) => {
      if (e.target === d || e.target.closest('[data-close]')) d.close();
    });
  }

  function show(img, trigger) {
    if (!canModal) { window.open(img.currentSrc || img.src, '_self'); return; }
    if (!dlg) build();
    const fig = img.closest('figure');
    const n = fig?.dataset.fig;
    $('#zoom-title', dlg).innerHTML = n ? `${L('Figure', '圖')} ${esc(n)}` : L('Figure', '圖');
    const big = $('img', dlg);
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || '';
    $('figcaption', dlg).innerHTML = fig?.querySelector('figcaption')?.innerHTML || '';
    dlg.addEventListener('close', () => trigger?.focus({ preventScroll: true }), { once: true });
    dlg.showModal();
  }

  for (const img of $$('.fig img, img[data-zoom]')) {
    if (img.closest('.fig-zoom')) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fig-zoom';
    const n = img.closest('figure')?.dataset.fig;
    b.innerHTML = `<span class="vh">${L(n ? `Enlarge figure ${n}` : 'Enlarge the figure', n ? `放大圖 ${n}` : '放大這張圖')}</span>`;
    img.replaceWith(b);
    b.prepend(img);
    b.addEventListener('click', () => show(img, b));
  }

  const keys = $('#keys-dialog');
  if (keys && canModal) {
    wire(keys);
    $('#keys-open')?.addEventListener('click', () => keys.showModal());
  } else {
    $('#keys-open')?.setAttribute('hidden', '');
  }

  return {
    anyOpen: () => !!document.querySelector('dialog[open]'),
    showKeys: () => { if (keys && canModal && !keys.open) keys.showModal(); },
  };
}
