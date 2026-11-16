// figs.js: the interactive parts of the redrawn paper figures.
//   Fig. 5  a row of buttons switches between all six prompts and one at a time; the ten relation words the
//           Triple Extractor allows are listed under the cards.
//   Fig. 2  pressing an agent box (not its name, which opens the glossary) shows that agent's prompt in Fig. 5.
//           Fig. 5 prints no prompt for the three Analysis agents, so those boxes only say so.
// Words inside the figures (agent names, ticks of Fig. 6) open the usual boxes through pop.js.

import * as prefs from './prefs.js';

const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const bi = (en, zh) => `<span class="en">${en}</span><span class="zh">${zh}</span>`;

// the prompt cards of Fig. 5, by their printed title
const CARD_KEY = {
  'Image Narrator': 'img', 'Relation Narrator': 'rel', 'Base Searcher': 'base', 'Action Narrator': 'act',
  'Five policies': 'tri', 'Three policies': 'tri3',   // which agent gets these two is our reading (Triple Extractor)
};
// the ten relation words printed in the five-policy prompt of Fig. 5 (bottom right), in printed order
const WORDS = ['attached to', 'wrapping', 'inside', 'screw', 'hanging from', 'goes through', 'inserted into', 'meshed with', 'below', 'above'];
const WORD_ZH = { 'attached to': '裝在', wrapping: '包住', inside: '在內', screw: '旋上', 'hanging from': '掛在', 'goes through': '穿過', 'inserted into': '插入', 'meshed with': '咬合', below: '在下', above: '在上' };

export function createFigs() {
  const fig5 = document.querySelector('.rd-fig5');
  let select = null;
  if (fig5) select = initFig5(fig5);
  for (const f of $$('.rd-fig6')) initFold(f);
  for (const row of $$('.fig-crops .fig-row')) initCropRow(row);
  for (const box of $$('.rd-agent[data-agent]')) initAgent(box, select);
  // the Summary box of Fig. 2: our reading is that the three-policy prompt of Fig. 5 belongs to it
  for (const box of $$('.rd-out-sum')) { box.dataset.agent = 'tri3'; initAgent(box, select); }
  return { select };
}

function initFig5(fig) {
  const cards = $$('.rd-prompt', fig);
  for (const c of cards) {
    const key = CARD_KEY[c.querySelector('header b .en')?.textContent.trim() || c.querySelector('header b')?.textContent.trim()];
    if (key) c.dataset.key = key;
  }
  const bar = document.createElement('div');
  bar.className = 'rd-switch'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Prompts of Fig. 5／圖 5 的 prompt');
  const btn = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.key = key; b.innerHTML = label;
    b.setAttribute('aria-pressed', String(key === 'all'));
    b.addEventListener('click', () => select(key));
    bar.append(b);
  };
  btn('all', bi('All six', '六份全部'));
  for (const c of cards) if (c.dataset.key) btn(c.dataset.key, c.querySelector('header b').innerHTML);
  fig.querySelector('.rd-prompts')?.before(bar);

  const words = document.createElement('div');
  words.className = 'rd-words';
  words.innerHTML = `<p>${bi('The ten relation words the five-policy prompt allows, in printed order:', '五條規則的 prompt 允許的十個關係詞，照印刷順序：')}</p>`
    + `<ul class="rd-words-list">${WORDS.map((w) => `<li><code lang="en">${w}</code><span class="zh" lang="zh-Hant">${WORD_ZH[w]}</span></li>`).join('')}</ul>`;
  fig.querySelector('.rd-prompts')?.after(words);

  function select(key, { scroll = false } = {}) {
    const only = key && key !== 'all' ? key : '';
    if (only) fig.dataset.only = only; else delete fig.dataset.only;
    for (const c of cards) c.classList.toggle('is-on', !only || c.dataset.key === only);
    for (const b of $$('button', bar)) b.setAttribute('aria-pressed', String(b.dataset.key === (only || 'all')));
    if (scroll) {
      const target = only ? cards.find((c) => c.dataset.key === only) : fig;
      target?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      target?.classList.add('is-flash');
      setTimeout(() => target?.classList.remove('is-flash'), 1200);
    }
  }
  return select;
}

// Crops in a row share one height and fill the row, each frame exactly the size of its picture (figs.css).
// The width and height the build writes on every local JPEG give the aspect ratio before the file arrives.
function initCropRow(row) {
  for (const img of $$(':scope > img', row)) {
    const w = +img.getAttribute('width') || img.naturalWidth, h = +img.getAttribute('height') || img.naturalHeight;
    if (!w || !h) continue;
    const cell = document.createElement('span');
    cell.className = 'crop';
    cell.style.setProperty('--ar', (w / h).toFixed(4));
    cell.style.setProperty('--w', `${w}px`);
    img.replaceWith(cell);
    cell.append(img);
  }
}

// Fig. 6: the four triple lists fold to their first lines, like the formula drawers. The title, the tick legend,
// the drawing and the 3D model stay in view; one bar (or the "+N more" line under any list) opens all four.
// Folded by default; the "Formula details" setting (eqopen) opens and folds them together with the drawers.
const FOLD_SHOW = 3;
let foldSeq = 0;
function initFold(fig) {
  const lists = $$('.rd-tri', fig);
  if (!lists.length) return;
  const total = lists.reduce((a, l) => a + l.children.length, 0);
  const hidden = lists.reduce((a, l) => a + Math.max(0, l.children.length - FOLD_SHOW), 0);
  if (!hidden) return;
  for (const l of lists) if (!l.id) l.id = `rd-tri-${++foldSeq}`;
  const ids = lists.map((l) => l.id).join(' ');
  const toggles = [];
  for (const l of lists) {
    const n = l.children.length - FOLD_SHOW;
    if (n <= 0) continue;
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'rd-more';
    more.setAttribute('aria-controls', l.id);
    more.dataset.closedHtml = bi(`${n} more line${n === 1 ? '' : 's'}`, `還有 ${n} 條`);
    more.dataset.openHtml = bi('Show fewer', '收合');
    l.after(more);
    toggles.push(more);
  }
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.className = 'rd-fold-bar';
  bar.setAttribute('aria-controls', ids);
  bar.innerHTML = `<span class="rd-fold-title">${bi(`All ${total} triples · ${lists.length} lists`, `全部 ${total} 條 triple · ${lists.length} 份清單`)}</span>`
    + `<span class="rd-fold-hint">${bi('<span data-open="Collapse" data-closed="Expand">Expand</span>', '<span data-open="收合" data-closed="展開">展開</span>')}</span>`;
  (fig.querySelector('.rd-fig6-grid') || lists[lists.length - 1]).after(bar);
  toggles.push(bar);
  const set = (open) => {
    fig.classList.toggle('is-folded', !open);
    for (const t of toggles) t.setAttribute('aria-expanded', String(open));
    for (const s of $$('[data-open]', bar)) s.textContent = open ? s.dataset.open : s.dataset.closed;
    for (const t of toggles) if (t !== bar) t.innerHTML = open ? t.dataset.openHtml : t.dataset.closedHtml;
  };
  for (const t of toggles) {
    t.addEventListener('click', () => {
      const open = fig.classList.contains('is-folded');
      set(open);
      // folding from far below would leave the reader past the figure: bring the pressed control back
      if (!open) t.scrollIntoView({ block: 'nearest' });
    });
  }
  set(String(prefs.get?.('eqopen') ?? '0') === '1');
  prefs.on?.('eqopen', (v) => set(String(v) === '1'));
}

function initAgent(box, select) {
  const key = box.dataset.agent;
  const analysis = /^an\d$/.test(key);
  if (analysis || !select) {
    box.title = analysis ? 'Fig. 5 prints no prompt for the Analysis agents.' : '';
    return;
  }
  box.classList.add('is-link');
  box.tabIndex = 0;
  box.setAttribute('role', 'button');
  const name = (box.querySelector('.rd-agent-name, .rd-out-h')?.textContent || key).replace(/\s*(VLM|LLM)\s*$/, '').trim();
  box.setAttribute('aria-label', `${name}: show its prompt in Fig. 5`);
  const go = (e) => {
    if (e.target.closest('.term, .gl, [data-sym], [data-el], a, button')) return;   // words keep their own boxes
    select(key, { scroll: true });
  };
  box.addEventListener('click', go);
  box.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(e); } });
}
