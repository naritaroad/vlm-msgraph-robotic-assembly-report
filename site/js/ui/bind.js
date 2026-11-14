// bind.js — the event bus and the live-value bus.
//
//   bus.on(type, fn) → off()      bus.emit(type, data)
//   bind(key, value)              writes every <output data-bind="key"> on the page
//
// bind() also walks into arrays and plain objects, so bind('telemetry', { q: [..6], tcp: { p: [..3] } })
// fills telemetry.q.0 … telemetry.q.5, telemetry.tcp.p and so on (docs/content-guide.md §6).
// Internal units are metres and radians. data-unit="mm" multiplies by 1000 and data-unit="deg" by 180/π,
// except for keys that already end in _mm or _deg. data-digits sets the decimals.

import { esc, L } from './dom.js';

export function createBus() {
  const map = new Map();
  return {
    on(type, fn) {
      if (!map.has(type)) map.set(type, new Set());
      map.get(type).add(fn);
      return () => map.get(type)?.delete(fn);
    },
    off(type, fn) { map.get(type)?.delete(fn); },
    emit(type, data) {
      for (const fn of [...(map.get(type) || [])]) { try { fn(data, type); } catch (e) { console.error(`[bus] ${type}`, e); } }
      for (const fn of [...(map.get('*') || [])]) { try { fn(data, type); } catch (e) { console.error('[bus] *', e); } }
    },
  };
}

const DEG = 180 / Math.PI;
const MINUS = '−';

function num(x, k, d) {
  if (typeof x !== 'number' || !Number.isFinite(x)) return '–';
  const s = (x * k).toFixed(d);
  return (/^-0(\.0*)?$/.test(s) ? s.slice(1) : s).replace('-', MINUS);
}

/** HTML for one bound value. opts: { unit, digits, key, shape } */
export function format(value, { unit = '', digits, key = '', shape = '' } = {}) {
  if (value === null || value === undefined || value === '') return '';
  if (typeof value === 'boolean') return value ? L('yes', '是') : L('no', '否');
  if (typeof value === 'string') return esc(value);
  const pre = /_(mm|deg)$/.test(key);
  const k = pre ? 1 : unit === 'mm' ? 1000 : unit === 'deg' || unit === '°' ? DEG : 1;
  const sample = Array.isArray(value) ? value.flat()[0] : value;
  const hasDigits = digits !== undefined && digits !== null && digits !== '' && Number.isFinite(+digits);
  const d = hasDigits ? +digits
    : (unit === 'mm' || unit === 'deg' || unit === '°') ? 1
    : Number.isInteger(sample) ? 0 : unit === 'px' ? 1 : 3;
  const u = !unit ? '' : (unit === 'deg' || unit === '°') ? '<span class="u deg">°</span>' : `<span class="u">${esc(unit)}</span>`;
  if (typeof value === 'number') return num(value, k, d) + u;
  if (Array.isArray(value)) {
    if (!value.length) return '';
    if (value.every((x) => typeof x === 'string')) return '⟨' + value.map(esc).join(', ') + '⟩';
    let rows = null;
    if (Array.isArray(value[0])) rows = value;
    else if (shape === 'col') rows = value.map((x) => [x]);
    else if (value.length === 9 || value.length === 16) {
      const c = value.length === 9 ? 3 : 4;
      rows = Array.from({ length: c }, (_, r) => value.slice(r * c, r * c + c));
    }
    if (rows) {
      const cols = Math.max(...rows.map((r) => r.length));
      const cells = rows.map((r) => r.map((x) => `<span>${typeof x === 'number' ? num(x, k, d) : esc(x)}</span>`).join('')).join('');
      return `<span class="mx" style="--cols:${cols}">${cells}</span>${u}`;
    }
    return '(' + value.map((x) => (typeof x === 'number' ? num(x, k, d) : esc(x))).join(', ') + ')' + u;
  }
  return esc(String(value));
}

export function createBind(root = document) {
  const values = new Map();          // key → latest value
  const index = new Map();           // key → Set<output>
  const FLASH_GAP = 900;             // a value that updates many times a second does not flash every time

  function paint(el, key, value) {
    const html = format(value, { unit: el.dataset.unit || '', digits: el.dataset.digits, key, shape: el.dataset.shape || '' });
    if (el.__html === html) return;
    const first = el.__html === undefined;
    el.__html = html;
    el.innerHTML = html;
    const now = performance.now();
    if (!first && now - (el.__t || 0) > FLASH_GAP) {
      el.classList.add('is-fresh');
      setTimeout(() => el.classList.remove('is-fresh'), 320);
    }
    el.__t = now;
  }

  function add(el) {
    const key = el.dataset.bind;
    if (!key) return;
    if (!index.has(key)) index.set(key, new Set());
    index.get(key).add(el);
    // 15 updates a second would flood a screen reader; the stage status line is the live region.
    if (!el.hasAttribute('aria-live')) el.setAttribute('aria-live', 'off');
    if (values.has(key)) paint(el, key, values.get(key));
  }
  function scan(node = root) {
    if (!node || (node.nodeType !== 1 && node.nodeType !== 9)) return;
    if (node.matches?.('output[data-bind]')) add(node);
    node.querySelectorAll?.('output[data-bind]').forEach(add);
  }

  function set(key, value, depth) {
    values.set(key, value);
    const els = index.get(key);
    if (els) for (const el of els) { if (el.isConnected) paint(el, key, value); else els.delete(el); }
    if (depth > 4 || value === null || typeof value !== 'object') return;
    if (Array.isArray(value)) { if (value.length <= 64) value.forEach((v, i) => set(`${key}.${i}`, v, depth + 1)); return; }
    if (Object.getPrototypeOf(value) === Object.prototype) for (const k of Object.keys(value)) set(`${key}.${k}`, value[k], depth + 1);
  }

  const bind = (key, value) => { if (typeof key === 'string' && key) set(key, value, 0); };
  bind.get = (key) => values.get(key);
  bind.scan = scan;

  scan(root);
  if ('MutationObserver' in window) {
    new MutationObserver((muts) => {
      for (const m of muts) for (const n of m.addedNodes) scan(n);
    }).observe(document.body, { childList: true, subtree: true });
  }
  return bind;
}
