// lightbox.js — press a paper figure to see it large; Esc or the close button returns focus to the figure.
// Also wires the keyboard-help dialog. Both use <dialog>, so focus is trapped and restored by the browser.

import { $, $$, L, esc } from './dom.js';

export function createLightbox() {
  const canModal = typeof HTMLDialogElement !== 'undefined' && 'showModal' in HTMLDialogElement.prototype;
  let dlg = null;
  let scale = 1.0;
  let panX = 0;
  let panY = 0;
  let isDragging = false;
  let startX = 0;
  let startY = 0;
  let panStartX = 0;
  let panStartY = 0;

  function updateTransform(instant = false) {
    if (!dlg) return;
    const big = $('img', dlg);
    const wrap = $('.zoom-pan-wrap', dlg);
    const resetBtn = $('[data-zoom-reset]', dlg);
    if (!big) return;

    if (scale <= 1.0) {
      scale = 1.0;
      panX = 0;
      panY = 0;
      wrap?.classList.remove('is-zoomed');
    } else {
      wrap?.classList.add('is-zoomed');
    }

    big.style.transition = instant ? 'none' : 'transform 120ms ease-out';
    big.style.transform = scale > 1.0
      ? `translate3d(${panX}px, ${panY}px, 0) scale(${scale})`
      : 'none';

    if (resetBtn) {
      resetBtn.textContent = `${Math.round(scale * 100)}%`;
      resetBtn.setAttribute('aria-label', `Zoom level ${Math.round(scale * 100)}%, click to reset / 目前縮放 ${Math.round(scale * 100)}%，點擊重設 100%`);
    }
  }

  function setScale(newScale, instant = false) {
    scale = Math.min(4.0, Math.max(1.0, Math.round(newScale * 100) / 100));
    if (scale === 1.0) {
      panX = 0;
      panY = 0;
    }
    updateTransform(instant);
  }

  function zoomBy(factor) {
    setScale(scale * factor);
  }

  function build() {
    dlg = document.createElement('dialog');
    dlg.className = 'zoom-dialog on-bay';
    dlg.setAttribute('aria-labelledby', 'zoom-title');
    dlg.innerHTML = `<div class="dialog-head">`
      + `<h2 id="zoom-title"></h2>`
      + `<div class="zoom-toolbar" role="toolbar" aria-label="${L('Zoom controls', '縮放控制')}">`
      + `<button type="button" class="zoom-btn icon-btn" data-zoom-out aria-label="${L('Zoom out', '縮小')}" title="Zoom out (−)"><span aria-hidden="true">−</span></button>`
      + `<button type="button" class="zoom-btn text-btn" data-zoom-reset aria-label="${L('Reset zoom 100%', '還原 100%')}" title="Reset zoom (100%)">100%</button>`
      + `<button type="button" class="zoom-btn icon-btn" data-zoom-in aria-label="${L('Zoom in', '放大')}" title="Zoom in (+)"><span aria-hidden="true">+</span></button>`
      + `<button type="button" class="icon-btn" data-close><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>`
      + `<span class="vh">${L('Close', '關閉')}</span></button>`
      + `</div>`
      + `</div>`
      + `<div class="dialog-body">`
      + `<figure class="zoom-viewport">`
      + `<div class="zoom-pan-wrap">`
      + `<img alt="" draggable="false">`
      + `</div>`
      + `<figcaption></figcaption>`
      + `</figure>`
      + `</div>`;
    document.body.append(dlg);
    wireZoom(dlg);
  }

  function wireZoom(d) {
    const wrap = $('.zoom-pan-wrap', d);
    const big = $('img', d);

    d.addEventListener('click', (e) => {
      if (e.target.closest('[data-zoom-in]')) {
        zoomBy(1.33);
      } else if (e.target.closest('[data-zoom-out]')) {
        zoomBy(0.75);
      } else if (e.target.closest('[data-zoom-reset]')) {
        setScale(1.0);
      } else if (e.target === d || e.target.closest('[data-close]')) {
        d.close();
      }
    });

    d.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') {
        e.preventDefault();
        zoomBy(1.25);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        zoomBy(0.8);
      } else if (e.key === '0') {
        e.preventDefault();
        setScale(1.0);
      }
    });

    if (wrap) {
      wrap.addEventListener('wheel', (e) => {
        e.preventDefault();
        const factor = e.deltaY < 0 ? 1.2 : 0.833;
        zoomBy(factor);
      }, { passive: false });

      wrap.addEventListener('pointerdown', (e) => {
        if (scale <= 1.0 || e.button !== 0) return;
        isDragging = true;
        startX = e.clientX;
        startY = e.clientY;
        panStartX = panX;
        panStartY = panY;
        wrap.classList.add('is-panning');
        wrap.setPointerCapture(e.pointerId);
        e.preventDefault();
      });

      wrap.addEventListener('pointermove', (e) => {
        if (!isDragging) return;
        panX = panStartX + (e.clientX - startX);
        panY = panStartY + (e.clientY - startY);
        updateTransform(true);
      });

      const stopDrag = (e) => {
        if (!isDragging) return;
        isDragging = false;
        wrap.classList.remove('is-panning');
        try { wrap.releasePointerCapture(e.pointerId); } catch (_) {}
        updateTransform(false);
      };

      wrap.addEventListener('pointerup', stopDrag);
      wrap.addEventListener('pointercancel', stopDrag);

      big?.addEventListener('dblclick', (e) => {
        e.preventDefault();
        setScale(scale > 1.0 ? 1.0 : 2.0);
      });
    }
  }

  function show(img, trigger) {
    if (!canModal) { window.open(img.currentSrc || img.src, '_self'); return; }
    if (!dlg) build();

    scale = 1.0;
    panX = 0;
    panY = 0;

    const fig = img.closest('figure');
    const n = fig?.dataset.fig;
    const refTitle = img.closest('.m3-ref')?.querySelector('.m3-ref-title')?.innerHTML;
    const rdHead = img.closest('.rd')?.querySelector('.rd-head')?.innerText;

    let titleHtml = L('Figure', '圖');
    if (refTitle) {
      titleHtml = refTitle;
    } else if (n) {
      titleHtml = `${L('Figure', '圖')} ${esc(n)}`;
    } else if (rdHead) {
      titleHtml = esc(rdHead.trim());
    }
    $('#zoom-title', dlg).innerHTML = titleHtml;

    const big = $('img', dlg);
    big.src = img.currentSrc || img.src;
    big.alt = img.alt || '';

    const cap = fig?.querySelector('figcaption')?.innerHTML
      || img.closest('.rd')?.querySelector('figcaption')?.innerHTML
      || (refTitle ? '' : (img.alt ? esc(img.alt) : ''));
    $('figcaption', dlg).innerHTML = cap;

    updateTransform();

    dlg.addEventListener('close', () => trigger?.focus({ preventScroll: true }), { once: true });
    dlg.showModal();
  }

  for (const img of $$('.fig img, .fig-crops img, .rd-photo, img[data-zoom]')) {
    if (img.closest('.fig-zoom, .m3-ref-zoom')) continue;
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'fig-zoom';
    const n = img.closest('figure')?.dataset.fig;
    b.innerHTML = `<span class="vh">${L(n ? `Enlarge figure ${n}` : 'Enlarge the figure', n ? `放大圖 ${n}` : '放大這張圖')}</span>`;
    img.replaceWith(b);
    b.prepend(img);
  }

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('.fig-zoom, .m3-ref-zoom, [data-zoom]');
    if (!trigger) return;
    if (trigger.closest('.zoom-dialog')) return;
    const img = trigger.querySelector('img') || (trigger.tagName === 'IMG' ? trigger : null);
    if (img) {
      e.preventDefault();
      show(img, trigger);
    }
  });

  const keys = $('#keys-dialog');
  if (keys && canModal) {
    keys.addEventListener('click', (e) => {
      if (e.target === keys || e.target.closest('[data-close]')) keys.close();
    });
    $('#keys-open')?.addEventListener('click', () => keys.showModal());
  } else {
    $('#keys-open')?.setAttribute('hidden', '');
  }

  return {
    anyOpen: () => !!document.querySelector('dialog[open]'),
    showKeys: () => { if (keys && canModal && !keys.open) keys.showModal(); },
  };
}
