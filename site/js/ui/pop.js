// pop.js — the explanation boxes. Glass layers above the page; they never push the text.
//
// What opens a box (anywhere: article, stage, or inside another box):
//   a term            .term[data-term]                       what the word means, and where the paper uses it
//   a symbol          [data-sym] in a formula, .sym-ref      what it stands for, shape, kind, where else it appears
//   a live number     [data-sym][data-val]                   the same card, plus the value now and where it comes from
//   a piece           [data-el] in a formula                 a subscript, superscript, limit, argument or tuple element
//   a formula         .eq-body, .eq-inline, .lv-math         purpose, input, output, the formula itself, its symbols
//
// Boxes stack. Pressing something inside a box opens a new box above it; pressing it again closes that box and
// the ones above. Esc closes the top box. Pressing outside every box closes them all. Each box follows its anchor
// while the page scrolls and closes when the anchor leaves the screen.

import { $$, L, esc, fetchJSON, readJSON } from './dom.js';
import { renderTex, getSymbol, setSymbols, getElement, symbolByTex, kpOf } from './math.js';
import { createAutoTerm } from './autoterm.js';

const KIND = { data: ['data', '資料'], setting: ['setting', '設定值'], computed: ['computed', '算出來的'], model: ['model output', '模型輸出'] };
const ROLE = {
  sub: ['Subscript', '下標', 'A subscript tells which one: a time step, an index, a frame or a name.', '下標說的是「哪一個」：哪個時間步、第幾個、哪個座標系或哪個名字。'],
  sup: ['Superscript', '上標', 'A superscript marks a version of the symbol: an inverse, a transpose, a frame or a model type.', '上標標出這個符號的某個版本：反矩陣、轉置、座標系或模型類型。'],
  limit: ['Limit of an operator', '運算子的範圍', 'The range a big operator runs over: from the lower limit to the upper one.', '大運算子要跑過的範圍：從下面的起點到上面的終點。'],
  note: ['Label under a brace', '括號下的標註', 'A label added under or over part of the formula to say what that part is. It is not part of the calculation.', '加在公式某一段上下的標註，說明那一段是什麼，不參與計算。'],
  arg: ['Argument', '引數', 'One input of a function: the function’s value depends on it.', '函數的一個輸入：函數的值跟著它變。'],
  item: ['Element', '元素', 'One element of a tuple, set or list. In a tuple the position matters; in a set it does not.', '一個有序組、集合或清單裡的一項。有序組看位置，集合不看。'],
};
// Common pieces that are not glossary symbols on their own.
const HINT = {
  '-1': ['inverse: the matrix that undoes this one', '反矩陣：把這個矩陣的作用倒回去的那個矩陣'],
  '\\top': ['transpose: rows become columns', '轉置：列變成行'],
  'T': ['transpose (when written as a superscript)', '轉置（寫成上標時）'],
  'w': ['world: the common coordinate frame', 'world：共同的座標系'],
  'c': ['camera', '相機'],
  'b': ['base: the robot base', 'base：機器人的基座'],
  'rgb': ['the colour image', '彩色影像'],
  'depth': ['the depth image', '深度影像'],
  'VLM': ['the step is done by a vision language model: it sees the picture', '這一步由 VLM 做：看得到圖'],
  'LLM': ['the step is done by a language model: text only', '這一步由 LLM 做：只有文字'],
  't': ['the time step: which assembly step', '時間步：第幾個組裝步驟'],
  'i': ['index of the item: which one', '第幾個'],
  'j': ['index of the view (camera pose)', '第幾個視角'],
  'k': ['number of views', '視角的數量'],
  's': ['assembled state', '組好的狀態'],
  'dis': ['disassembled state', '拆開的狀態'],
  'any': ['the output of AnyGrasp: all candidate grasps', 'AnyGrasp 的輸出：所有候選夾取姿態'],
  'grasp': ['the grasp kept for the target part', '留下來給目標零件的那個夾取姿態'],
  'obj': ['the target pose in the robot base frame', '在機器人基座座標裡的目標姿態'],
  'rou': ['rough: the first estimate, before ICP', 'rough：ICP 之前的粗估'],
  'nar1': ['the graph written by the stage-1 narrators', '階段 1 的 narrator 寫出的圖'],
  'gt': ['ground truth: the answer list', 'ground truth：標準答案'],
  '1': ['one; as a last coordinate it makes the vector homogeneous', '一；放在向量最後一格時，把它變成齊次座標'],
};
const MAX_LAYERS = 8;
const CLOSE = '<button type="button" class="pop-close"><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>'
  + `<span class="vh">${L('Close', '關閉')}</span></button>`;
const firstSentence = (s) => { const m = String(s || '').match(/^.*?[.。](?=\s|$)/); return m ? m[0] : String(s || ''); };

export function createPop({ katex } = {}) {
  const first = document.getElementById('pop');
  if (!first) return null;
  let terms = {};
  let forms = {};
  let auto = null;
  const layers = [];               // { box, anchor, kind, point, kp }
  // Chinese match forms with no English spelling of their own. The box still names the English word.
  const ORIG = { subject: 'subject', object: 'object' };

  const inlineGloss = readJSON('reader-gloss');
  const ready = (inlineGloss
    ? Promise.resolve([inlineGloss.terms, inlineGloss.symbols, inlineGloss.match])
    : Promise.all([
        fetchJSON('data/gloss.json').catch(() => ({})),
        fetchJSON('data/symbols.json').catch(() => ({})),
        fetchJSON('data/match.json').catch(() => ({})),
      ])
  ).then(([g, s, m]) => { terms = g || {}; forms = m || {}; setSymbols(s || {}); auto = createAutoTerm(m || {}); return true; });

  // ── content ──

  const tex = (t, kp) => `<span class="pop-tex" data-tex="${esc(t)}" data-kp-scope="${esc(kp || '')}"></span>`;
  const pageLang = () => document.documentElement.dataset.lang || 'en';

  // The English word, when the title the reader sees is only the Chinese click.
  function termOrig(key, entry) {
    const named = (entry && entry.name) || '';
    if (/[A-Za-z]/.test(named)) return named.trim();
    for (const f of forms[key] || []) if (/[A-Za-z]/.test(f)) return String(f).trim();
    return ORIG[key] || '';
  }
  function origLine(title, orig) {
    const lang = pageLang();
    if ((lang !== 'zh' && lang !== 'both') || !orig) return '';
    const t = title.trim().toLowerCase();
    const o = orig.trim().toLowerCase();
    if (!o || t === o || t.includes(o)) return '';
    return `<p class="pop-orig" lang="en">${esc(orig)}</p>`;
  }

  function termCard(el) {
    const key = el.dataset.term;
    const e = terms[key];
    const shown = el.textContent.trim();
    if (!e) return `<p class="pop-name">${esc(shown)}</p><p class="pop-def">${L('No entry for this one yet.', '這個詞還沒有說明。')}</p>`;
    const title = e.name || shown;
    const kicker = [L('Term', '詞'), e.src ? `<span>${esc(e.src)}</span>` : `<span class="tag" data-tag="External">External</span>`].join(' ');
    return `<p class="pop-kicker">${kicker}</p><p class="pop-name">${esc(title)}</p>${origLine(title, termOrig(key, e))}`
      + `<p class="pop-def">${L(e.en || '', e.zh || e.en || '')}</p>`
      + (e.paper ? `<p class="pop-def">${L(e.paper.en || '', e.paper.zh || e.paper.en || '')}</p>` : '');
  }

  function alsoIn(key, here) {
    const out = [];
    for (const fig of $$('figure.eq')) {
      if (fig === here || !fig.querySelector(`[data-sym="${CSS.escape(key)}"]`)) continue;
      if (!fig.id) fig.id = `eq-${fig.dataset.eq || out.length}-${Math.random().toString(36).slice(2, 6)}`;
      const no = fig.querySelector('.eq-no')?.textContent.trim() || 'Eq.';
      out.push(`<a href="#${fig.id}" data-goto="${fig.id}">${esc(no)}</a>`);
      if (out.length >= 6) break;
    }
    return out.length ? `<p class="pop-also">${L('Also in', '也出現在')} ${out.join(' · ')}</p>` : '';
  }

  function symbolCard(el, kp) {
    const key = el.dataset.sym;
    const e = getSymbol(key);
    const t = e?.tex || el.dataset.tex || key;
    const isVal = el.hasAttribute('data-val');
    const fig = el.closest('figure.eq');
    const meta = [];
    if (e?.shape) meta.push(`<span>${esc(e.shape)}</span>`);
    if (e?.kind) meta.push(`<span class="kind" data-kind="${esc(e.kind)}">${L(...(KIND[e.kind] || [e.kind, e.kind]))}</span>`);
    let h = `<p class="pop-kicker">${L(isVal ? 'Value of a symbol' : 'Symbol', isVal ? '符號的值' : '符號')} ${meta.join(' ')}</p>`
      + `<p class="pop-name">${tex(t, kp)}</p>`;
    h += e ? `<p class="pop-def">${L(e.en || '', e.zh || e.en || '')}</p>`
      : `<p class="pop-def">${L('No entry for this symbol yet.', '這個符號還沒有說明。')}</p>`;
    if (isVal) {
      const src = fig?.querySelector('.lv-src')?.innerHTML || L('the stage', '舞台');
      h += `<dl class="pop-now"><dt>${L('Now', '目前值')}</dt><dd>${esc(el.textContent.trim())}</dd><dt>${L('From', '來自')}</dt><dd>${src}</dd></dl>`;
    }
    if (e?.src) h += `<p class="pop-src">${esc(e.src)}</p>`;
    return h + alsoIn(key, fig);
  }

  function elementCard(el, kp) {
    const n = +el.dataset.n;
    const info = getElement(n) || { role: el.dataset.el, tex: el.textContent.trim() };
    const [en, zh, den, dzh] = ROLE[info.role] || ROLE.item;
    const piece = info.tex.trim();
    const owner = el.parentElement?.closest('[data-sym]');
    const ownerSym = owner ? getSymbol(owner.dataset.sym) : null;
    const key = symbolByTex(piece, kp);
    const sym = key ? getSymbol(key) : null;
    const norm = piece.replace(/\\(?:mathrm|text|mathit)\{([^}]*)\}/g, '$1').replace(/[{}\s]/g, '');
    const hint = HINT[norm];
    let h = `<p class="pop-kicker">${L(en, zh)}${ownerSym ? ` <span>${L('of', '屬於')} </span><span class="pop-tex-inline" data-tex="${esc(ownerSym.tex || owner.dataset.sym)}" data-kp-scope="${esc(kp)}"></span>` : ''}</p>`
      + `<p class="pop-name">${tex(piece, kp)}</p>`
      + (pageLang() === 'zh' ? `<p class="pop-orig" lang="en">${esc(en)}</p>` : '');
    if (sym) h += `<p class="pop-def">${L(sym.en || '', sym.zh || sym.en || '')}</p>`;
    else if (hint) h += `<p class="pop-def">${L(`Here: ${hint[0]}.`, `這裡：${hint[1]}。`)}</p>`;
    h += `<p class="pop-def pop-role">${L(den, dzh)}</p>`;
    if (ownerSym && !sym) h += `<p class="pop-def">${L(firstSentence(ownerSym.en), firstSentence(ownerSym.zh || ownerSym.en))}</p>`;
    const fig = el.closest('figure.eq');
    const no = fig?.querySelector('.eq-no')?.textContent.trim();
    if (no) h += `<p class="pop-src">${esc(no)}</p>`;
    return h;
  }

  function ioOf(fig) {
    const inside = fig.querySelector('dl.io');
    if (inside) return inside;
    let n = fig.nextElementSibling;
    for (let i = 0; n && i < 4; i++, n = n.nextElementSibling) {
      if (n.matches('dl.io')) return n;
      if (n.matches('figure.eq, section, h2, h3')) break;
    }
    return null;
  }

  function formulaCard(el, kp) {
    const fig = el.closest('figure.eq');
    const steps = el.closest('ol.steps');
    const no = fig?.querySelector('.eq-no')?.textContent.trim() || (steps?.dataset.eq ? `Eq. (${steps.dataset.eq})` : '');
    const tag = fig?.querySelector('figcaption .tag')?.outerHTML || '';
    const loc = fig?.querySelector('figcaption .loc')?.textContent.trim() || '';
    const face = fig?.dataset.face === 'values';
    const src = el.dataset.tex || fig?.querySelector('.eq-body')?.dataset.tex || '';
    let h = `<p class="pop-kicker">${L(steps ? 'A step of the calculation' : 'Formula', steps ? '計算的一步' : '公式')} ${tag}</p>`
      + `<p class="pop-name">${esc(no || (document.documentElement.lang === 'zh-Hant' ? '這一行' : 'This line'))}</p>`;
    if (src && !el.matches('.lv-math')) h += `<div class="pop-formula">${tex(src, kp)}</div>`;
    if (face) h += `<p class="pop-def">${L('The numbers are the current values from the stage; change a control there and they change here.', '式子裡的數字是舞台目前的值；動舞台的控制項，這裡跟著變。')}</p>`;
    const io = fig ? ioOf(fig) : null;
    if (io) {
      const rows = $$(':scope > div', io).slice(0, 5).map((d) => `<div><dt>${d.querySelector('dt')?.innerHTML || ''}</dt><dd>${d.querySelector('dd')?.innerHTML || ''}</dd></div>`);
      h += `<dl class="pop-io">${rows.join('')}</dl>`;
    } else if (steps) {
      const li = el.closest('li');
      const text = li ? [...li.childNodes].filter((x) => !(x.nodeType === 1 && x.matches('.eq-inline'))).map((x) => (x.nodeType === 1 ? x.outerHTML : esc(x.textContent))).join('') : '';
      if (text.trim()) h += `<p class="pop-def">${text}</p>`;
    }
    const keys = [...new Set($$('[data-sym]', el).map((s) => s.dataset.sym))];
    const rows = keys.map((k) => {
      const e = getSymbol(k);
      if (!e) return '';
      return `<div><dt>${tex(e.tex || k, kp)}</dt><dd>${L(firstSentence(e.en), firstSentence(e.zh || e.en))}</dd></div>`;
    }).filter(Boolean);
    if (rows.length) h += `<dl class="pop-syms">${rows.join('')}</dl>`;
    else if (!io && !steps) h += `<p class="pop-def">${L('Press a symbol or any small piece of the formula for what it stands for.', '點式子裡的符號或任何一小塊，看它代表什麼。')}</p>`;
    if (loc) h += `<p class="pop-src">${esc(loc)}</p>`;
    return h;
  }

  // ── layers ──

  function newBox(depth) {
    if (depth === 0) return first;
    const box = document.createElement('div');
    box.className = 'pop glass';
    box.setAttribute('role', 'dialog');
    box.hidden = true;
    document.body.append(box);
    return box;
  }

  function place(layer) {
    const { box, anchor, point } = layer;
    if (!anchor.isConnected) return false;
    const r = anchor.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    if (r.bottom < 0 || r.top > vh || r.width + r.height === 0) return false;
    const w = box.offsetWidth, h = box.offsetHeight;
    const px = point ? Math.min(r.right, Math.max(r.left, point.x)) : r.left + Math.min(r.width / 2, 60);
    const x = Math.round(Math.min(vw - w - 8, Math.max(8, px - 44)));
    const below = r.bottom + 10, above = r.top - 10 - h;
    const side = below + h <= vh - 8 || above < 8 ? 'below' : 'above';
    const y = Math.round(side === 'below' ? Math.min(below, Math.max(8, vh - h - 8)) : above);
    box.dataset.side = side;
    box.style.left = `${x}px`;
    box.style.top = `${y}px`;
    box.style.setProperty('--ax', `${Math.round(px - x - 6)}px`);
    return true;
  }
  function placeAll() {
    for (let i = 0; i < layers.length; i++) {
      if (!place(layers[i])) { closeFrom(i); return; }
    }
  }
  let raf = 0;
  const replace = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; placeAll(); }); };
  window.addEventListener('scroll', replace, { passive: true, capture: true });
  window.addEventListener('resize', replace, { passive: true });

  function unmark(layer) {
    layer.anchor.classList?.remove('is-open');
    if (layer.anchor.hasAttribute?.('aria-expanded')) layer.anchor.setAttribute('aria-expanded', 'false');
    for (const m of layer.marked || []) m.classList.remove('is-same');
  }

  /** Close layer i and every layer above it. */
  function closeFrom(i, { focus = false } = {}) {
    if (i < 0 || i >= layers.length) return false;
    const anchor = layers[i].anchor;
    while (layers.length > i) {
      const l = layers.pop();
      unmark(l);
      l.box.hidden = true;
      l.box.replaceChildren();
      if (l.box !== first) l.box.remove();
    }
    if (focus && anchor?.isConnected && typeof anchor.focus === 'function' && anchor.matches('button, [tabindex]')) anchor.focus({ preventScroll: true });
    return true;
  }
  const close = (o) => closeFrom(0, o);

  async function open(el, kind, at) {
    await ready;
    const existing = layers.findIndex((l) => l.anchor === el);
    if (existing >= 0) { closeFrom(existing); return; }
    const parent = layers.findIndex((l) => l.box.contains(el));
    if (parent >= 0) closeFrom(parent + 1); else close();
    if (layers.length >= MAX_LAYERS) closeFrom(layers.length - 1);
    const depth = layers.length;
    const kp = kpOf(el) || (parent >= 0 ? layers[parent].kp : '');
    const box = newBox(depth);
    const html = kind === 'term' ? termCard(el) : kind === 'symbol' ? symbolCard(el, kp) : kind === 'element' ? elementCard(el, kp) : formulaCard(el, kp);
    box.innerHTML = html + CLOSE;
    box.style.zIndex = String(75 + depth);
    box.dataset.depth = String(depth);
    for (const t of $$('[data-tex]', box)) renderTex(t, t.dataset.tex, katex, { display: t.matches('.pop-formula .pop-tex'), kp, tag: true });
    auto?.wrap(box);
    // a box does not link to itself: its own word inside its text goes back to plain text
    if (kind === 'term' && el.dataset.term) {
      for (const self of $$(`.term[data-term="${CSS.escape(el.dataset.term)}"]`, box)) self.replaceWith(document.createTextNode(self.textContent));
    }
    for (const b of $$('.term', box)) b.setAttribute('aria-expanded', 'false');
    box.hidden = false;
    box.style.animation = 'none'; void box.offsetWidth; box.style.animation = '';
    const layer = { box, anchor: el, kind, point: at || null, kp, marked: [] };
    layers.push(layer);
    if (el.hasAttribute('aria-expanded')) el.setAttribute('aria-expanded', 'true');
    el.classList.add('is-open');
    if (kind === 'symbol' && depth === 0) {
      const scope = el.closest('section.kp') || document;
      for (const s of $$(`[data-sym="${CSS.escape(el.dataset.sym)}"]`, scope)) if (s !== el) { s.classList.add('is-same'); layer.marked.push(s); }
    }
    if (!place(layer)) closeFrom(depth);
  }

  // ── events ──

  for (const b of $$('.term, .sym-ref, .gl')) {
    if (b.tagName === 'BUTTON') b.type = 'button';
    b.setAttribute('aria-expanded', 'false');
  }
  for (const b of $$('figure.eq .eq-body')) {
    b.tabIndex = 0;
    b.setAttribute('role', 'button');
    b.setAttribute('aria-haspopup', 'dialog');
  }

  function hit(target) {
    if (!(target instanceof Element)) return null;
    if (target.closest('.pop-close')) return { close: true, layer: layers.findIndex((l) => l.box.contains(target)) };
    const goto = target.closest('[data-goto]');
    if (goto) return { goto: goto.dataset.goto };
    const t = target.closest('.term, .gl');
    if (t) return { el: t, kind: 'term' };
    const piece = target.closest('[data-el], [data-sym], .sym-ref');
    if (piece) return { el: piece, kind: piece.hasAttribute('data-el') ? 'element' : 'symbol' };
    if (target.closest('button, a, input, select, label, summary')) return null;
    const f = target.closest('.eq-body, .eq-inline, .lv-math, .pop-formula');
    if (f && !f.closest('.pop')) return { el: f, kind: 'formula' };
    return null;
  }

  document.addEventListener('click', (e) => {
    const inBox = layers.some((l) => l.box.contains(e.target));
    const h = hit(e.target);
    if (!h) { if (!inBox && layers.length) close(); return; }
    if (h.close) { closeFrom(Math.max(0, h.layer), { focus: true }); return; }
    if (h.goto) {
      e.preventDefault();
      const fig = document.getElementById(h.goto);
      close();
      if (fig) { fig.scrollIntoView({ block: 'center', behavior: 'auto' }); fig.classList.add('is-flash'); setTimeout(() => fig.classList.remove('is-flash'), 1200); }
      return;
    }
    if (h.kind === 'formula' && String(window.getSelection?.() || '').length > 0) return;
    e.preventDefault();
    e.stopPropagation();
    open(h.el, h.kind, { x: e.clientX });
  }, true);
  document.addEventListener('keydown', (e) => {
    if ((e.key === 'Enter' || e.key === ' ') && e.target instanceof Element && e.target.matches('figure.eq .eq-body')) {
      e.preventDefault(); e.stopPropagation();
      open(e.target, 'formula');
    }
  }, true);

  return {
    ready,
    /** Close the top box. Returns true when something closed. */
    closeLast: () => closeFrom(layers.length - 1, { focus: true }),
    close,
    /** Wrap terms inside a region made at run time (the stage views), and keep it wrapped. */
    watch: (root) => ready.then(() => auto?.watch(root)),
    get openCount() { return layers.length; },
  };
}
