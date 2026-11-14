// nav.js — which knowledge point is on screen, and everything that follows it:
// the KP index, the route in the top bar, the progress line, the URL hash, and how the stage follows the article.
//
// How the stage follows (prefs 'sync', html[data-sync]):
//   off      scrolling never touches the stage
//   kp       a new section runs its data-enter (or shows its data-stage view)
//   precise  the same, and inside a section every block with data-cue runs its cue when it reaches the reading line
// Buttons in the article always work, whatever the mode.

import { $, $$, pad2 } from './dom.js';

export function createNav({ stage, bus }) {
  const root = document.documentElement;
  const mainline = $('#mainline');
  const stageEl = $('#stage');
  const cover = $('#cover');
  const rail = $('#rail');
  const kpOpen = $('#kp-open');
  const scrim = $('#rail-scrim');
  const timeline = $('#timeline');
  const mqOne = window.matchMedia('(max-width: 1099.98px)');

  const kps = $$('section.kp').map((el, i) => ({
    el, i,
    id: el.id,
    no: el.dataset.kp ?? String(i),
    min: parseFloat(el.dataset.min) || 0,
    view: el.dataset.stage || '',
    pipe: el.dataset.pipe || '',
    enter: el.dataset.enter || '',
  }));
  const links = new Map($$('#rail-list a[href^="#"]').map((a) => [a.getAttribute('href').slice(1), a]));
  const pipeItems = $$('.pipe li[data-pipe]');
  const pipeEl = $('.pipe');
  const ind = pipeEl ? Object.assign(document.createElement('span'), { className: 'pipe-ind' }) : null;
  if (ind) { ind.setAttribute('aria-hidden', 'true'); pipeEl.append(ind); }
  /** Move the bar under the current station. */
  function placeIndicator() {
    if (!ind) return;
    const li = pipeEl.querySelector('li.is-current');
    pipeEl.classList.toggle('has-current', !!li);
    if (!li) return;
    const b = li.querySelector('.pipe-btn') || li;
    const r = b.getBoundingClientRect(), pr = pipeEl.getBoundingClientRect();
    const label = b.querySelector('.pipe-label');
    const lr = label ? label.getBoundingClientRect() : r;
    ind.style.setProperty('--ind-x', `${Math.round(lr.left - pr.left + pipeEl.scrollLeft)}px`);
    ind.style.setProperty('--ind-w', `${Math.round(lr.width)}px`);
    if (pipeEl.scrollWidth > pipeEl.clientWidth) li.scrollIntoView({ block: 'nearest', inline: 'center' });
  }
  const pipeOrder = pipeItems.map((li) => li.dataset.pipe);
  const cues = $$('#article [data-cue]');
  const listeners = new Set();
  let current = -1;
  let lock = 0;              // ignore the scroll spy until this time (programmatic jumps)
  let io = null, cueIo = null, coverIo = null;
  let lastCueEl = null;
  let shownOnce = false;
  // After a jump the page may still grow above the target (formulas, lazy figures, fonts). WebKit does not
  // anchor the scroll position, so for a short while we put the target back under the header ourselves.
  let settleKp = null, settleUntil = 0;
  const cancelSettle = () => { settleUntil = 0; };
  for (const type of ['wheel', 'touchstart', 'pointerdown', 'keydown']) {
    window.addEventListener(type, cancelSettle, { passive: true, capture: true });
  }
  const mode = () => root.dataset.sync || 'kp';
  const atCover = () => root.dataset.at === 'cover';

  // ── progress: one equal segment per knowledge point ──
  if (timeline) timeline.innerHTML = kps.map(() => '<i></i>').join('');
  const segs = timeline ? $$('i', timeline) : [];

  // ── sticky offsets, measured: CSS reads them as variables ──
  function measure() {
    const mh = Math.round(mainline?.getBoundingClientRect().height || 0);
    root.style.setProperty('--mainline-h', `${mh}px`);
    let top = mh;
    if (mqOne.matches && stage.size() !== 'full') top += Math.round(stageEl.getBoundingClientRect().height);
    root.style.setProperty('--sticky-top', `${top}px`);
    return top;
  }

  // ── scroll spy: a one-pixel line a little below the sticky header; what crosses it is current ──
  function spy() {
    io?.disconnect(); cueIo?.disconnect(); coverIo?.disconnect();
    if (!('IntersectionObserver' in window) || !kps.length) return;
    const top = measure();
    const vh = Math.max(200, window.innerHeight || 0);      // a hidden tab can report 0
    const line = Math.max(1, Math.round(Math.min(vh - 80, top + Math.max(48, (vh - top) * 0.22))));
    const margin = `-${line}px 0px -${Math.max(0, vh - line - 1)}px 0px`;
    io = new IntersectionObserver((entries) => {
      if (performance.now() < lock) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const k = kps.find((x) => x.el === e.target);
        if (k) setCurrent(k.i, { by: 'scroll' });
      }
    }, { rootMargin: margin, threshold: 0 });
    kps.forEach((k) => io.observe(k.el));

    cueIo = new IntersectionObserver((entries) => {
      if (performance.now() < lock || mode() !== 'precise') return;
      for (const e of entries) {
        if (!e.isIntersecting || e.target === lastCueEl) continue;
        runCue(e.target);
      }
    }, { rootMargin: margin, threshold: 0 });
    cues.forEach((el) => cueIo.observe(el));

    if (cover) {
      coverIo = new IntersectionObserver(([e]) => {
        const at = e.isIntersecting ? 'cover' : 'report';
        if (root.dataset.at === at) return;
        root.dataset.at = at;
        bus.emit('at', { at });
        if (at === 'cover') {
          try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// */ }
        } else if (current >= 0) writeHash(kps[current]);
      }, { rootMargin: `-${Math.round(vh * 0.55)}px 0px 0px 0px`, threshold: 0 });
      coverIo.observe(cover);
    }
  }

  function runCue(el) {
    lastCueEl = el;
    const act = el.dataset.cue;
    if (!act) return;
    el.classList.add('is-cue');
    setTimeout(() => el.classList.remove('is-cue'), 900);
    stage.run(act, { auto: true });
    bus.emit('cue', { act, el });
  }

  function writeHash(k) {
    if (!k || atCover() || location.hash === `#${k.id}`) return;
    try { history.replaceState(null, '', `#${k.id}`); } catch { /* file:// in some browsers */ }
  }

  function follow(k, by) {
    const m = mode();
    if (m === 'off' && by === 'scroll') {
      if (!shownOnce) { shownOnce = true; stage.show(k.view || 'lab'); }     // something must be on the stage
      return;
    }
    shownOnce = true;
    lastCueEl = null;
    if (k.enter) stage.run(k.enter, { auto: true });
    else if (k.view) stage.show(k.view);
  }

  function setCurrent(i, { by = 'code', force = false } = {}) {
    if (i < 0 || i >= kps.length || (i === current && !force)) return;
    const prev = current;
    current = i;
    const k = kps[i];

    for (const [id, a] of links) {
      const j = kps.findIndex((x) => x.id === id);
      if (j === i) a.setAttribute('aria-current', 'true'); else a.removeAttribute('aria-current');
      a.classList.toggle('is-done', j >= 0 && j < i);
    }
    if (railOpen()) links.get(k.id)?.scrollIntoView({ block: 'nearest' });

    const p = pipeOrder.indexOf(k.pipe);
    pipeItems.forEach((li, j) => {
      li.classList.toggle('is-current', j === p);
      li.classList.toggle('is-done', p >= 0 && j < p);
      const b = li.querySelector('button');
      if (b) { if (j === p) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); }
    });
    segs.forEach((s, j) => { s.classList.toggle('is-done', j < i); s.classList.toggle('is-current', j === i); });
    placeIndicator();

    const kpB = $('#hud-kp b'), kpOf = $('#hud-kp .hud-kp-of');
    if (kpB) kpB.textContent = pad2(k.no);
    if (kpOf) kpOf.textContent = `/ ${pad2(kps[kps.length - 1].no)}`;
    const prevB = $('#hud-prev'), nextB = $('#hud-next');
    if (prevB) prevB.disabled = i === 0 && atCover();
    if (nextB) nextB.disabled = i === kps.length - 1;

    kps.forEach((x) => x.el.classList.toggle('is-current', x.i === i));
    k.el.classList.add('is-entering');
    setTimeout(() => k.el.classList.remove('is-entering'), 600);

    writeHash(k);
    follow(k, by);
    bus.emit('kp:enter', { id: k.id, index: i, kp: k.no, prev: prev >= 0 ? kps[prev].id : null, by });
    for (const fn of listeners) fn(k, prev >= 0 ? kps[prev] : null);
  }

  /** Jump to a KP. Instant: a long smooth scroll would fire every data-enter on the way. */
  function go(i, { by = 'key', focus = false, settle = 1500 } = {}) {
    if (i < 0 && cover) { toCover(); return; }
    i = Math.max(0, Math.min(kps.length - 1, i));
    const k = kps[i];
    if (!k) return;
    measure();
    lock = performance.now() + 350;
    root.dataset.at = 'report';
    k.el.scrollIntoView({ block: 'start', behavior: 'auto' });
    settleKp = k; settleUntil = performance.now() + settle;
    setCurrent(i, { by, force: true });
    if (focus) {
      const h = k.el.querySelector('h2');
      if (h) { h.tabIndex = -1; h.focus({ preventScroll: true }); }
    }
  }
  const goId = (id, opts) => { const j = kps.findIndex((x) => x.id === id); if (j >= 0) { go(j, opts); return true; } return false; };
  function toCover() {
    if (!cover) return;
    cancelSettle();
    lock = performance.now() + 350;
    window.scrollTo({ top: 0, behavior: 'auto' });
    root.dataset.at = 'cover';
    try { history.replaceState(null, '', location.pathname + location.search); } catch { /* file:// */ }
  }

  // ── the KP list ──
  function setRail(open, { focus = true } = {}) {
    const was = root.dataset.rail === 'open';
    root.dataset.rail = open ? 'open' : 'closed';
    kpOpen?.setAttribute('aria-expanded', String(open));
    if (scrim) scrim.hidden = !(open && mqOne.matches);
    if (open && !was) {
      const a = links.get(kps[current]?.id) || $('#rail-list a');
      if (focus) a?.focus({ preventScroll: true });
      a?.scrollIntoView({ block: 'nearest' });
    } else if (!open && was && focus && rail.contains(document.activeElement)) {
      kpOpen?.focus({ preventScroll: true });
    }
  }
  const railOpen = () => root.dataset.rail === 'open';
  kpOpen?.addEventListener('click', () => setRail(!railOpen()));
  scrim?.addEventListener('click', () => setRail(false));
  document.addEventListener('pointerdown', (e) => {
    if (railOpen() && !rail.contains(e.target) && !kpOpen?.contains(e.target)) setRail(false, { focus: false });
  });
  $('#rail-list')?.addEventListener('click', (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a) return;
    e.preventDefault();
    const id = a.getAttribute('href').slice(1);
    setRail(false, { focus: false });
    a.blur();
    goId(id, { by: 'link', focus: true });
  });

  // ── the route and the previous / next buttons ──
  pipeItems.forEach((li) => {
    const b = li.querySelector('button');
    const target = kps.find((k) => k.pipe === li.dataset.pipe);
    if (!b) return;
    if (!target) { b.disabled = true; return; }
    b.addEventListener('click', () => go(target.i, { by: 'link', focus: true }));
  });
  const prev = () => (atCover() ? undefined : current <= 0 && cover && window.scrollY > 0 && kps[0].el.getBoundingClientRect().top > -40 ? toCover() : go(current - 1, { by: 'key' }));
  const next = () => (atCover() ? go(0, { by: 'key' }) : go(current + 1, { by: 'key' }));
  $('#hud-prev')?.addEventListener('click', prev);
  $('#hud-next')?.addEventListener('click', next);

  // in-page links to a KP (hand-offs, cross references, the cover's start button) and back to the cover
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#kp"], a[href="#cover"]');
    if (!a || a.closest('#rail-list')) return;
    if (a.getAttribute('href') === '#cover') { e.preventDefault(); toCover(); return; }
    if (goId(a.getAttribute('href').slice(1), { by: 'link', focus: true })) e.preventDefault();
  });
  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && kps[current]?.id !== id) goId(id, { by: 'link' });
  });

  // ── keep measurements and the spy line right ──
  let raf = 0;
  const relayout = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => { spy(); placeIndicator(); }); };
  window.addEventListener('resize', relayout, { passive: true });
  window.addEventListener('orientationchange', relayout, { passive: true });
  stage.onSize(relayout);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(relayout);
    if (mainline) ro.observe(mainline);
    const article = $('#article');
    if (article) {
      new ResizeObserver(() => {
        if (!settleKp || performance.now() > settleUntil) return;
        const top = measure();
        if (Math.abs(settleKp.el.getBoundingClientRect().top - top - 16) < 2) return;
        lock = performance.now() + 350;
        settleKp.el.scrollIntoView({ block: 'start', behavior: 'auto' });
      }).observe(article);
    }
  }

  function start() {
    spy();
    const id = location.hash.slice(1);
    const at = kps.findIndex((k) => k.id === id);
    if (at >= 0) go(at, { by: 'link', settle: 4000 });
    else if (!cover && kps.length) setCurrent(0, { by: 'link', force: true });
    else if (!kps.length) stage.show('lab');
    // with a cover and no hash: nothing is current until the first section reaches the reading line
  }

  return {
    kps,
    get current() { return current; },
    get currentKp() { return kps[current] || null; },
    go, goId, next, prev, toCover, atCover,
    setRail, railOpen, toggleRail: () => setRail(!railOpen()),
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    relayout, start,
  };
}
