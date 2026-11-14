// autoterm.js — wrap glossary terms in text that is made at run time: the stage views, and the explanation boxes
// themselves (so a word inside a box opens a box of its own). The article is wrapped by tools/build.py instead.
//
// Same rules as the build: each term once per block and per language, longest match first, all-lowercase forms
// match case-insensitively, ASCII forms only on word boundaries. Never inside buttons, links, code, formulas,
// form controls, evidence tags or anything marked data-notag / .no-term.

const SKIP = 'button, a, code, kbd, pre, svg, script, style, textarea, input, select, option, label, summary, .katex, .tag, .loc, .term, .gl, [data-notag], .no-term, .eq-no, output, data, [contenteditable]';
const BLOCK = 'p, li, td, th, dd, dt, figcaption, h3, h4, blockquote, section, aside, div';

export function createAutoTerm(match = {}) {
  const forms = [];
  for (const [key, list] of Object.entries(match)) for (const f of list || []) if (f && f.trim()) forms.push([f, key]);
  forms.sort((a, b) => b[0].length - a[0].length || (a[0] < b[0] ? -1 : 1));
  const lookup = new Map();
  const alts = [];
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const [f, key] of forms) {
    const low = f.toLowerCase();
    if (lookup.has(low)) continue;
    lookup.set(low, key);
    const ascii = /^[\x20-\x7e]+$/.test(f);
    let body = esc(f);
    if (ascii) {
      const pre = /[A-Za-z0-9]/.test(f[0]) ? '(?<![A-Za-z0-9_\\-])' : '';
      const post = /[A-Za-z0-9]/.test(f[f.length - 1]) ? '(?![A-Za-z0-9_\\-])' : '';
      body = pre + body + post;
    }
    alts.push(body);
  }
  if (!alts.length) return { wrap() { return 0; } };
  // one case-insensitive pass; forms with capitals are checked for an exact case match afterwards
  const rx = new RegExp(alts.join('|'), 'giu');
  const caseSensitive = new Set(forms.filter(([f]) => /[A-Z]/.test(f)).map(([f]) => f.toLowerCase()));
  const seenByBlock = new WeakMap();

  function wrapText(node) {
    const text = node.nodeValue;
    if (!text || !text.trim()) return 0;
    const block = node.parentElement.closest(BLOCK) || node.parentElement;
    const langEl = node.parentElement.closest('.en, .zh');
    const scope = langEl && block.contains(langEl) ? langEl : block;
    let seen = seenByBlock.get(scope);
    if (!seen) { seen = new Set(); seenByBlock.set(scope, seen); }
    rx.lastIndex = 0;
    let m, last = 0, count = 0;
    const frag = document.createDocumentFragment();
    while ((m = rx.exec(text))) {
      const low = m[0].toLowerCase();
      const key = lookup.get(low);
      if (!key || seen.has(key)) continue;
      if (caseSensitive.has(low) && !forms.some(([f]) => f === m[0])) continue;
      seen.add(key);
      if (m.index > last) frag.append(text.slice(last, m.index));
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'term';
      b.dataset.term = key;
      b.setAttribute('aria-expanded', 'false');
      b.textContent = m[0];
      frag.append(b);
      last = m.index + m[0].length;
      count++;
    }
    if (!count) return 0;
    if (last < text.length) frag.append(text.slice(last));
    node.replaceWith(frag);
    return count;
  }

  /** Wrap terms in every text node under root that is not already wrapped or excluded. Returns how many. */
  function wrap(root) {
    if (!root) return 0;
    const nodes = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(n) {
        const p = n.parentElement;
        if (!p || p.closest(SKIP)) return NodeFilter.FILTER_REJECT;
        return n.nodeValue && n.nodeValue.trim().length > 1 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
      },
    });
    while (walker.nextNode()) nodes.push(walker.currentNode);
    let n = 0;
    for (const t of nodes) n += wrapText(t);
    return n;
  }

  /** Keep a live region wrapped as its content changes (debounced). Returns a stop function. */
  function watch(root, delay = 250) {
    let timer = 0;
    const run = () => { timer = 0; mo.disconnect(); wrap(root); mo.observe(root, { childList: true, subtree: true, characterData: true }); };
    const mo = new MutationObserver(() => { if (!timer) timer = setTimeout(run, delay); });
    run();
    return () => { clearTimeout(timer); mo.disconnect(); };
  }

  return { wrap, watch };
}
