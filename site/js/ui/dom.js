// dom.js — small helpers shared by the ui modules.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

/** Two-language HTML for text made in JS. Same markup as the content: span.en + span.zh. */
export const L = (en, zh) =>
  `<span class="en" lang="en">${esc(en)}</span><span class="zh" lang="zh-Hant">${esc(zh ?? en)}</span>`;

/** Accepts 'text' or { en, zh } and returns HTML. */
export const text2 = (t) => (t && typeof t === 'object' ? L(t.en ?? '', t.zh ?? t.en ?? '') : esc(t));

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** True when a single-key shortcut must not fire: the user is typing or operating a control that uses the key. */
export function isTyping(target) {
  if (!(target instanceof Element)) return false;
  return !!target.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="slider"], [role="textbox"], [data-keys="own"]');
}

export function readJSON(id) {
  const el = document.getElementById(id);
  if (!el) return null;
  try { return JSON.parse(el.textContent); } catch { return null; }
}

export async function fetchJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

export const pad2 = (n) => String(n).padStart(2, '0');
export const clock = (sec) => { const s = Math.max(0, Math.round(sec)); return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`; };
