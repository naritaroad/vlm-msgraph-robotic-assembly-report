// math.js — render every [data-tex] with the local KaTeX, tag the symbols inside so each one can be pressed
// for its explanation (pop.js), and keep formula blocks inside their column.
//
// Tagging: before rendering, every symbol the glossary knows is wrapped as \htmlData{sym=<key>}{…}; KaTeX turns
// that into <span data-sym="key">. Which symbols are known where comes from data/symbols.json: a symbol written
// with one or two plain letters (K, R, T, k …) is only tagged inside the knowledge point that defines it,
// because the same letter means different things in different sections.
//
// Fit order for .eq-body (docs/design.md, "no sideways scroll bar for the page"):
//   1. the block's own font size, 1.25 × body;
//   2. shrink the font, down to MIN_SCALE;
//   3. last resort: the block itself scrolls sideways, with a fade on the right edge and keyboard focus.

const MIN_SCALE = 0.68;
const TRUSTED = new Set(['\\htmlClass', '\\htmlData']);
export const KATEX_TRUST = (c) => TRUSTED.has(c.command);
const OPTS = { throwOnError: false, strict: false, output: 'htmlAndMathml', trust: KATEX_TRUST };

const isDisplay = (el) => el.matches('.eq-body, .eq-inline, [data-display]');

// ───────────────────────────── symbol tagging

let SYMBOLS = {};                    // key → entry
let BY_KP = {};                      // 'kp07' → [key, …]
const formCache = new Map();         // kp id → [{ key, form, cls }], longest form first

const NO_WRAP = /^\\(?:bigcup|bigcap|sum|prod|min|max|int|lim|frac|begin|end|left|right)\b/;
const isShort = (form) => !form.startsWith('\\') && form.replace(/[{}\s]/g, '').length <= 2 && !/[_^]/.test(form);

export function setSymbols(data) {
  SYMBOLS = {}; BY_KP = {};
  for (const [k, v] of Object.entries(data || {})) {
    if (k === '_kp') BY_KP = v || {};
    else if (v && typeof v === 'object') SYMBOLS[k] = v;
  }
  formCache.clear();
}
export const getSymbol = (key) => SYMBOLS[key] || null;

function formsFor(kp) {
  if (formCache.has(kp)) return formCache.get(kp);
  const local = new Set(BY_KP[kp] || []);
  const order = [...local, ...Object.keys(SYMBOLS).filter((k) => !local.has(k))];
  const seen = new Set();
  const list = [];
  for (const key of order) {
    const e = SYMBOLS[key];
    if (!e || e.notag) continue;
    const forms = [e.tex, ...(Array.isArray(e.alt) ? e.alt : [])].filter(Boolean);
    const bare = e.tex && e.tex.endsWith('(u,v)') ? e.tex.slice(0, -5) : null;   // P_t(u,v) is also written P_t
    if (bare) forms.push(bare);
    for (const form of forms) {
      if (NO_WRAP.test(form) || seen.has(form)) continue;
      if (isShort(form) && !local.has(key)) continue;                           // ambiguous outside its own section
      seen.add(form);
      list.push({ key, form, cls: e.cls || '' });
    }
  }
  list.sort((a, b) => b.form.length - a.form.length);
  formCache.set(kp, list);
  return list;
}

const isNumber = (form) => /^[\d.,\s()\-]+$/.test(form);
const isLetter = (c) => !!c && /[A-Za-z]/.test(c);
const isDigit = (c) => !!c && /[0-9.]/.test(c);
function boundaryOk(str, i, end, form) {
  const prev = str[i - 1], next = str[end], first = form[0], last = form[form.length - 1];
  if (prev === '_' || prev === '^' || prev === '\\') return false;       // a bare script argument cannot take a macro
  if (isLetter(first) && isLetter(prev)) return false;
  if (isLetter(last) && isLetter(next)) return false;
  if (isDigit(first) && isDigit(prev)) return false;
  if (isDigit(last) && (isDigit(next) && !(next === '.' && !isDigit(str[end + 1])))) return false;
  if (isShort(form) && next === '_') return false;                        // K_x is not K
  return true;
}
// text and names that must never be read as symbols
const PROTECT = /\\(?:text|textbf|textit|mathrm|operatorname|begin|end|htmlClass|htmlData|scriptsize|rlap|xrightarrow)\s*(?:\[[^\]]*\])?\{[^{}]*\}|\\[A-Za-z]+|\\./g;

const ATTRS = /\\html(?:Data|Class|Id|Style)\s*\{[^{}]*\}/g;

function protect(segs, re = PROTECT) {
  const out = [];
  for (const s of segs) {
    if (!s.raw) { out.push(s); continue; }
    let last = 0;
    for (const m of s.t.matchAll(re)) {
      if (m.index > last) out.push({ t: s.t.slice(last, m.index), raw: true });
      out.push({ t: m[0], raw: false });
      last = m.index + m[0].length;
    }
    if (last < s.t.length) out.push({ t: s.t.slice(last), raw: true });
  }
  return out;
}

/** TeX with every known symbol wrapped in \htmlData{sym=key}{…}. kp is the id of the section the formula is in. */
export function tagTex(tex, kp = '', { numbers = true } = {}) {
  const list = formsFor(kp);
  if (!list.length || !tex) return tex;
  let segs = protect([{ t: String(tex), raw: true }], ATTRS);     // never look inside \htmlData{…} attributes
  let guarded = false;
  for (const { key, form, cls } of list) {
    if (isNumber(form) && (!numbers || form.length < 2)) continue;   // live rows carry their own numbers; a lone digit is too ambiguous
    if (!guarded && isShort(form)) { segs = protect(segs); guarded = true; }
    const next = [];
    for (const seg of segs) {
      if (!seg.raw || seg.t.indexOf(form) < 0) { next.push(seg); continue; }
      const str = seg.t;
      let from = 0, last = 0, i;
      while ((i = str.indexOf(form, from)) >= 0) {
        const end = i + form.length;
        if (boundaryOk(str, i, end, form)) {
          if (i > last) next.push({ t: str.slice(last, i), raw: true });
          const inner = `\\htmlData{sym=${key}}{${form}}`;
          next.push({ t: cls === 'rel' ? `\\mathrel{${inner}}` : cls === 'bin' ? `\\mathbin{${inner}}` : inner, raw: false });
          last = end;
        }
        from = end;
      }
      if (last < str.length) next.push({ t: str.slice(last), raw: true });
    }
    segs = next;
  }
  return segs.map((s) => s.t).join('');
}

// ───────────────────────────── element tagging
//
// After the symbols, every smaller piece gets its own handle, so a person can press just that piece:
//   sub / sup   the content of a subscript or superscript            P_{t}, I^{rgb}, K^{-1}, [u,v,1]^{\top}
//   limit       the limits of a big operator                         \bigcup_{i=1}^{\kappa}
//   note        the label under or over a brace                      \underbrace{…}_{K^{-1}}
//   arg         one argument of a function                           d_t(u, v) → u, v
//   item        one element of a tuple, set or list                  (s, p, o), \{R, T\}, \langle w_0, … \rangle
// Each piece becomes \htmlData{el=<role>,n=<index>}{…}; the index points into ELEMENTS, which keeps its TeX, so the
// explanation box can show the piece on its own (and tag the symbols inside it again: boxes inside boxes).

const ELEMENTS = [];
const elementIndex = new Map();
export const getElement = (n) => ELEMENTS[n] || null;
function register(role, tex) {
  const k = role + '\u0000' + tex;
  if (elementIndex.has(k)) return elementIndex.get(k);
  const n = ELEMENTS.push({ role, tex }) - 1;
  elementIndex.set(k, n);
  return n;
}
const BIGOPS = new Set(['bigcup', 'bigcap', 'sum', 'prod', 'min', 'max', 'lim', 'int', 'argmin', 'argmax', 'inf', 'sup']);
const BRACES = new Set(['underbrace', 'overbrace', 'underset', 'overset', 'xrightarrow']);
const RAWGROUP = new Set(['text', 'textbf', 'textit', 'mathrm', 'operatorname', 'mathit', 'texttt', 'textrm', 'scriptsize', 'rlap', 'llap']);
const SPACE = /^(?:\s|\\[ ,;:!]|\\quad|\\qquad)+|(?:\s|\\[ ,;:!]|\\quad|\\qquad)+$/g;

/** End index (exclusive) of the brace group that starts at s[i] === '{'. */
function groupEnd(s, i) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') { j++; continue; }
    if (c === '{') d++;
    else if (c === '}') { d--; if (d === 0) return j + 1; }
  }
  return s.length;
}
/** Does `close` occur at brace depth 0 before the current group ends? (A delimiter split by tagging is not a tuple.) */
function closes(s, i, close) {
  let d = 0;
  for (let j = i; j < s.length; j++) {
    if (d === 0 && s.startsWith(close, j)) return true;
    const c = s[j];
    if (c === '\\') { if (d === 0 && s.startsWith(close, j)) return true; j++; continue; }
    if (c === '{') d++;
    else if (c === '}') { if (d === 0) return false; d--; }
  }
  return false;
}
const DELIM = { '(': ')', '[': ']', '\\{': '\\}', '\\lbrace': '\\rbrace', '\\langle': '\\rangle', '.': '.', '|': '|', '\\|': '\\|', '\\lvert': '\\rvert', '\\lVert': '\\rVert' };

function wrapEl(role, core) {
  const body = core.trim();
  if (!body || body.startsWith('\\htmlData{el=')) return core;
  const lead = core.match(/^(?:\s|\\[ ,;:!])*/)[0], trail = core.match(/(?:\s|\\[ ,;:!])*$/)[0];
  const inner = core.slice(lead.length, core.length - trail.length);
  if (!inner) return core;
  return `${lead}\\htmlData{el=${role},n=${register(role, inner)}}{${inner}}${trail}`;
}

/**
 * Walk TeX from s[i] until `closer` (or the end). Returns [processed, nextIndex, items|null, bad].
 * `tuple` is true when the region was opened by a delimiter, so top-level commas split items.
 */
function walk(s, i, closer, tuple) {
  let out = '', cur = '', bad = false;
  const items = [];
  let scriptRole = null;                     // 'limit' after a big operator, 'note' after a brace
  const flush = (x) => { cur += x; };
  while (i < s.length) {
    if (closer && s.startsWith(closer, i)) break;
    const c = s[i];
    if (c === '\\') {
      const m = /^\\([A-Za-z]+)/.exec(s.slice(i, i + 40));
      if (!m) {                                // \{ \} \\ \, \  etc.
        const two = s.slice(i, i + 2);
        if (two === '\\{' && closes(s, i + 2, '\\}')) {
          const [inner, j] = walk(s, i + 2, '\\}', true);
          flush('\\{' + inner + '\\}'); i = j + 2; scriptRole = null; continue;
        }
        if (two === '\\\\') {
          bad = true; flush(two); i += 2;
          if (s[i] === '[') { const e = s.indexOf(']', i); flush(s.slice(i, e + 1)); i = e + 1; }
          continue;
        }
        flush(two); i += 2; continue;
      }
      const name = m[1];
      const after = i + m[0].length;
      if (name === 'htmlData' || name === 'htmlClass' || name === 'htmlId' || name === 'htmlStyle') {
        const aEnd = groupEnd(s, after);
        flush(s.slice(i, aEnd));
        if (s[aEnd] === '{') {
          const [inner, j] = walk(s, aEnd + 1, '}', false);
          flush('{' + inner + '}'); i = j + 1;
        } else i = aEnd;
        continue;
      }
      if (RAWGROUP.has(name)) {
        let j = after;
        while (s[j] === ' ') j++;
        if (s[j] === '{') { const e = groupEnd(s, j); flush(s.slice(i, e)); i = e; } else { flush(m[0]); i = after; }
        continue;
      }
      if (name === 'begin' || name === 'end') {
        bad = true;
        const e = s[after] === '{' ? groupEnd(s, after) : after;
        flush(s.slice(i, e)); i = e;
        if (name === 'begin' && s[i] === '{') { const e2 = groupEnd(s, i); flush(s.slice(i, e2)); i = e2; }   // column spec
        continue;
      }
      if (name === 'left') {                    // \left( … \right): the tuple ends at \right
        const dm = /^(\\[A-Za-z]+|\\.|.)/.exec(s.slice(after, after + 12));
        const open = dm ? dm[0] : '';
        const prev = cur.replace(/\s+$/, '').slice(-1);
        if (open && closes(s, after + open.length, '\\right')) {
          const role = open === '(' && /[A-Za-z0-9}]/.test(prev) ? 'arg' : (open === '|' || open === '\\|' || open === '\\lvert' || open === '\\lVert' || open === '.') ? false : 'item';
          const [inner, j] = walk(s, after + open.length, '\\right', role);
          const cm = /^\\right(\\[A-Za-z]+|\\.|.)/.exec(s.slice(j, j + 14));
          const shut = cm ? cm[0] : '\\right';
          flush('\\left' + open + inner + shut); i = j + shut.length; scriptRole = null; continue;
        }
        flush(m[0]); i = after; continue;
      }
      if (name === 'langle' && closes(s, after, '\\rangle')) {
        const [inner, j] = walk(s, after, '\\rangle', true);
        flush('\\langle' + inner + '\\rangle'); i = j + '\\rangle'.length; scriptRole = null; continue;
      }
      if (/^(?:big|Big|bigg|Bigg)l?$/.test(name)) {   // \big[ … \big] (or \bigl … \bigr): a sized tuple
        const dm = /^\s*(\\langle|\\\{|[([])/.exec(s.slice(after, after + 10));
        if (dm) {
          const open = dm[1], close = { '(': ')', '[': ']', '\\{': '\\}', '\\langle': '\\rangle' }[open];
          const base = name.replace(/l$/, '');
          const shut = [`\\${base}r${close}`, `\\${base}${close}`].find((x) => closes(s, after + dm[0].length, x));
          if (shut) {
            const [inner, j] = walk(s, after + dm[0].length, shut, true);
            flush(s.slice(i, after + dm[0].length) + inner + shut); i = j + shut.length; scriptRole = null; continue;
          }
        }
      }
      if (BIGOPS.has(name)) scriptRole = 'limit';
      else if (BRACES.has(name)) scriptRole = 'note';
      flush(m[0]); i = after; continue;
    }
    if (c === '&') { bad = true; flush(c); i++; continue; }
    if (c === '{') {
      const [inner, j] = walk(s, i + 1, '}', false);
      flush('{' + inner + '}'); i = j + 1; continue;
    }
    if ((c === '(' || (c === '[' && !/\\\\\s*$/.test(cur) && !/\\sqrt\s*$/.test(cur))) && closes(s, i + 1, c === '(' ? ')' : ']')) {
      const close = c === '(' ? ')' : ']';
      const prev = cur.replace(/\s+$/, '').slice(-1);
      const role = /[A-Za-z0-9}]/.test(prev) && c === '(' ? 'arg' : 'item';
      const [inner, j] = walk(s, i + 1, close, role);
      flush(c + inner + close); i = j + 1; scriptRole = null; continue;
    }
    if (c === '_' || c === '^') {
      const role = scriptRole || (c === '_' ? 'sub' : 'sup');
      let j = i + 1;
      while (s[j] === ' ') j++;
      let content, end;
      if (s[j] === '{') {
        const [inner, k] = walk(s, j + 1, '}', false);
        content = inner; end = k + 1;
      } else if (s[j] === '\\') {
        const m = /^\\([A-Za-z]+|.)/.exec(s.slice(j, j + 40));
        content = m[0]; end = j + m[0].length;
      } else { content = s[j] || ''; end = j + 1; }
      flush(c + '{' + wrapEl(role, content) + '}');
      i = end; continue;
    }
    if (c === ',' && tuple) { items.push(cur); cur = ''; i++; continue; }
    flush(c); i++;
  }
  if (tuple && items.length && !bad) {
    items.push(cur);
    const role = tuple === true ? 'item' : tuple;
    out = items.map((x) => wrapEl(role, x)).join(',');
  } else {
    out = items.length ? items.join(',') + ',' + cur : cur;
  }
  return [out, i, null, bad];
}

/** Give subscripts, superscripts, limits, arguments and tuple elements their own handles. */
export function tagElements(tex) {
  if (!tex) return tex;
  try { return walk(String(tex), 0, null, false)[0]; } catch (e) { console.warn('[math] tagElements', e.message); return tex; }
}

/** Key of the symbol written exactly like `tex` in section `kp`, or ''. */
export function symbolByTex(tex, kp = '') {
  const norm = (x) => String(x).replace(/\s+/g, '').replace(/\\[ ,;:!]/g, '');
  const want = norm(tex);
  for (const { key, form } of formsFor(kp)) if (norm(form) === want) return key;
  return '';
}

/** Wrap a number that stands for a symbol: pressing it opens that symbol's card with the current value. */
export const valTex = (key, tex) => `\\htmlData{sym=${key}, val=1}{${tex}}`;

// ───────────────────────────── typesetting

export const kpOf = (el) => el?.closest?.('section.kp')?.id || el?.closest?.('[data-kp-scope]')?.dataset.kpScope || '';

export function renderTex(el, tex, katex = window.katex, { display = isDisplay(el), kp = kpOf(el), tag = true, numbers = true } = {}) {
  if (!katex) { el.textContent = tex; return false; }
  const src = tag && !el.closest('[data-notag]') ? tagElements(tagTex(tex, kp, { numbers })) : tex;
  if (el.__tex === src) return true;
  try {
    katex.render(src, el, { ...OPTS, displayMode: display });
  } catch (e) {
    try { katex.render(tex, el, { ...OPTS, displayMode: display }); } catch { el.textContent = tex; console.warn('[math]', tex, e.message); return false; }
  }
  el.__tex = src;
  el.classList.add('is-typeset');
  return true;
}

export function typeset(root = document, katex = window.katex) {
  const list = [...(root.matches?.('[data-tex]') ? [root] : []), ...root.querySelectorAll('[data-tex]')];
  for (const el of list) renderTex(el, el.dataset.tex, katex);
  for (const el of list) if (el.matches('.eq-body, .eq-inline')) watch(el);
}

/** Typeset everything again, e.g. after the symbol table arrived. */
export function retypeset(root = document, katex = window.katex) {
  for (const el of root.querySelectorAll('[data-tex]')) el.__tex = null;
  typeset(root, katex);
}

const widths = new WeakMap();
let ro = null;

function fit(el) {
  el.style.fontSize = '';
  el.classList.remove('is-scroll', 'at-end');
  el.removeAttribute('aria-label');
  const room = el.clientWidth;
  if (!room) return;
  const fig = el.closest?.('figure.eq');
  const faceKey = `${room}:${fig?.dataset.face || ''}`;
  let need = el.scrollWidth;
  let scale = need <= room + 1 ? 1 : Math.max(MIN_SCALE, Math.floor((room / need) * 100) / 100 - 0.01);
  if (el.__faceKey === faceKey && typeof el.__minScale === 'number') {
    scale = Math.min(scale, el.__minScale);
  } else {
    el.__faceKey = faceKey;
    el.__lockedH = 0;
  }
  el.__minScale = scale;
  if (scale < 1) {
    el.style.fontSize = `${parseFloat(getComputedStyle(el).fontSize) * scale}px`;
    need = el.scrollWidth;
  }
  const h = el.offsetHeight;
  if (h > 0) {
    el.__lockedH = Math.max(el.__lockedH || 0, h);
    el.style.minHeight = `${el.__lockedH}px`;
  }
  if (need <= room + 1) return;
  el.classList.add('is-scroll');
  el.tabIndex = 0;
  el.setAttribute('aria-label', document.documentElement.lang === 'zh-Hant' ? '公式，可左右捲動' : 'Formula, scrolls sideways');
}

function watch(el) {
  if (widths.has(el)) { fit(el); return; }
  widths.set(el, -1);
  el.addEventListener('scroll', () => {
    el.classList.toggle('at-end', el.scrollLeft + el.clientWidth >= el.scrollWidth - 2);
  }, { passive: true });
  if (!ro && 'ResizeObserver' in window) {
    ro = new ResizeObserver((entries) => {
      for (const e of entries) {
        const body = e.target;
        const w = Math.round(e.contentRect.width);
        if (widths.get(body) === w) continue;      // height-only changes come from our own font change
        widths.set(body, w);
        fit(body);
      }
    });
  }
  if (ro) ro.observe(el); else fit(el);
}

/** Refit everything, e.g. after the text size or the split changed. */
export function refit(root = document) {
  root.querySelectorAll('.eq-body, .eq-inline').forEach((el) => {
    if (widths.has(el)) {
      el.__faceKey = null;
      el.__minScale = null;
      el.__lockedH = 0;
      el.style.minHeight = '';
      fit(el);
    }
  });
}
/** Refit one block after its content changed. */
export function refitOne(el) { if (widths.has(el)) fit(el); else watch(el); }
