// prefs.js — every choice the page remembers, in one place (localStorage 'msgraph.prefs').
// The inline script in the page head applies the saved values before first paint; this module owns them afterwards.
//
//   lang   'en' | 'zh' | 'both'             html[data-lang]
//   theme  'system' | 'light' | 'dark'      html[data-theme] is always the resolved 'light' or 'dark'
//   swap   0 | 1                            1 = the stage is on the left            html[data-swap]
//   sync   'off' | 'kp' | 'precise'         how the stage follows the article       html[data-sync]
//   live   0 | 1                            formulas show live values               html[data-live]
//   big    0 | 1                            projector text size                     html[data-present]
//   timer  0 | 1                            the clock in the top bar
//   split  0.28 … 0.72                      share of the width the article takes    --split

const KEY = 'msgraph.prefs';
const root = document.documentElement;

export const DEFAULTS = Object.freeze({ lang: 'en', theme: 'system', swap: 0, sync: 'kp', live: 1, big: 0, timer: 0, split: 0.42 });
export const CHOICES = Object.freeze({
  lang: ['en', 'zh', 'both'], theme: ['system', 'light', 'dark'], swap: [0, 1],
  sync: ['off', 'kp', 'precise'], live: [0, 1], big: [0, 1], timer: [0, 1],
});
export const SPLIT_MIN = 0.28, SPLIT_MAX = 0.72;

function load() { try { return JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch { return {}; } }
function store(obj) { try { localStorage.setItem(KEY, JSON.stringify(obj)); } catch { /* private mode */ } }

function clean(key, v) {
  if (key === 'split') { const n = Number(v); return Number.isFinite(n) ? Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n)) : DEFAULTS.split; }
  const list = CHOICES[key];
  if (!list) return undefined;
  if (typeof list[0] === 'number') { const n = Number(v); return list.includes(n) ? n : DEFAULTS[key]; }
  return list.includes(v) ? v : DEFAULTS[key];
}

const state = { ...DEFAULTS };
{
  const saved = load();
  for (const k of Object.keys(DEFAULTS)) if (k in saved) state[k] = clean(k, saved[k]);
  const q = new URLSearchParams(location.search);
  for (const k of ['lang', 'theme', 'sync']) if (q.get(k)) state[k] = clean(k, q.get(k));
  if (q.get('swap') === '1') state.swap = 1;
}

const listeners = new Map();          // key → Set<fn>
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function apply(key) {
  const v = state[key];
  switch (key) {
    case 'lang': root.dataset.lang = v; root.lang = v === 'zh' ? 'zh-Hant' : 'en'; break;
    case 'theme': root.dataset.themePref = v; root.dataset.theme = v === 'system' ? (systemDark() ? 'dark' : 'light') : v; break;
    case 'swap': if (v) root.dataset.swap = '1'; else delete root.dataset.swap; break;
    case 'sync': root.dataset.sync = v; break;
    case 'live': root.dataset.live = String(v); break;
    case 'big': root.toggleAttribute('data-present', !!v); break;
    case 'split': root.style.setProperty('--split', String(v)); break;
    default:
  }
}

export const get = (key) => state[key];

export function set(key, value, { persist = true } = {}) {
  if (!(key in DEFAULTS)) return;
  const v = clean(key, value);
  const changed = state[key] !== v;
  state[key] = v;
  apply(key);
  if (persist) store({ ...load(), [key]: v });
  if (changed) for (const fn of listeners.get(key) || []) { try { fn(v, key); } catch (e) { console.error(e); } }
}

export function cycle(key) {
  const list = CHOICES[key];
  if (!list) return;
  set(key, list[(list.indexOf(state[key]) + 1) % list.length]);
}

export function on(key, fn) {
  if (!listeners.has(key)) listeners.set(key, new Set());
  listeners.get(key).add(fn);
  return () => listeners.get(key).delete(fn);
}

export function resetAll() {
  try { localStorage.removeItem(KEY); } catch { /* private mode */ }
  for (const k of Object.keys(DEFAULTS)) set(k, DEFAULTS[k], { persist: false });
}

// ── the older names, still used around the code ──
export const lang = () => state.lang;
export const setLang = (next, opts) => set('lang', next, opts);
export const cycleLang = () => cycle('lang');
export const onLang = (fn) => on('lang', fn);
/** The resolved theme: 'light' or 'dark'. */
export const theme = () => (root.dataset.theme === 'dark' ? 'dark' : 'light');
export const setTheme = (next, opts) => set('theme', next, opts);
/** The T key: flip to the other one and keep it, whatever the system says. */
export const toggleTheme = () => set('theme', theme() === 'dark' ? 'light' : 'dark');
const themeListeners = new Set();
export const onTheme = (fn) => { themeListeners.add(fn); return () => themeListeners.delete(fn); };

export function initPrefs() {
  for (const k of Object.keys(DEFAULTS)) apply(k);
  let last = theme();
  const tell = () => { const t = theme(); if (t !== last) { last = t; for (const fn of themeListeners) { try { fn(t); } catch (e) { console.error(e); } } } };
  on('theme', tell);
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => {
    if (state.theme === 'system') { apply('theme'); tell(); }
  });
}
