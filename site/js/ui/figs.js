// figs.js: the interactive parts of the redrawn paper figures.
//   Fig. 5  a row of buttons switches between all six prompts and one at a time; the ten relation words the
//           Triple Extractor allows are listed under the cards.
//   Fig. 2  pressing an agent box (not its name, which opens the glossary) shows that agent's prompt in Fig. 5.
//           Fig. 5 prints no prompt for the three Analysis agents, so those boxes only say so.
// Words inside the figures (agent names, ticks of Fig. 6) open the usual boxes through pop.js.

const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const bi = (en, zh) => `<span class="en">${en}</span><span class="zh">${zh}</span>`;

// the prompt cards of Fig. 5, by their printed title
const CARD_KEY = {
  'Image Narrator': 'img', 'Relation Narrator': 'rel', 'Base Searcher': 'base', 'Action Narrator': 'act',
  'Five policies': 'tri', 'Three policies': 'tri3',   // which agent gets these two is our reading (Triple Extractor)
};
// the ten relation words printed in the five-policy prompt of Fig. 5 (bottom right), in printed order
const WORDS = ['attached to', 'wrapping', 'inside', 'screw', 'hanging from', 'goes through', 'inserted into', 'meshed with', 'below', 'above'];

export function createFigs() {
  const fig5 = document.querySelector('.rd-fig5');
  let select = null;
  if (fig5) select = initFig5(fig5);
  for (const box of $$('.rd-agent[data-agent]')) initAgent(box, select);
  // the Summary box of Fig. 2: our reading is that the three-policy prompt of Fig. 5 belongs to it
  for (const box of $$('.rd-out-sum')) { box.dataset.agent = 'tri3'; initAgent(box, select); }
  return { select };
}

function initFig5(fig) {
  const cards = $$('.rd-prompt', fig);
  for (const c of cards) {
    const key = CARD_KEY[c.querySelector('header b')?.textContent.trim()];
    if (key) c.dataset.key = key;
  }
  const bar = document.createElement('div');
  bar.className = 'rd-switch'; bar.setAttribute('role', 'group'); bar.setAttribute('aria-label', 'Prompts of Fig. 5');
  const btn = (key, label) => {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.key = key; b.innerHTML = label;
    b.setAttribute('aria-pressed', String(key === 'all'));
    b.addEventListener('click', () => select(key));
    bar.append(b);
  };
  btn('all', bi('All six', '六份全部'));
  for (const c of cards) if (c.dataset.key) btn(c.dataset.key, c.querySelector('header b').textContent);
  fig.querySelector('.rd-prompts')?.before(bar);

  const words = document.createElement('div');
  words.className = 'rd-words';
  words.innerHTML = `<p>${bi('The ten relation words the five-policy prompt allows, in printed order:', '五條規則的 prompt 允許的十個關係詞，照印刷順序：')}</p>`
    + `<ul class="rd-words-list">${WORDS.map((w) => `<li><code>${w}</code></li>`).join('')}</ul>`;
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
