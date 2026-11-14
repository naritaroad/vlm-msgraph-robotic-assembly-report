// embed.js: turns each <div class="model3d" data-models="product1 product2 …"> in the article into an interactive
// 3D figure: model tabs (when there is more than one), Explode/Assemble and Reset buttons, the canvas, a line that
// names the picked part and lists its triples, and the caption from data-caption-en / data-caption-zh.
//
// The whole frame (tabs, buttons, stage, caption) is built at once so the page does not move when a model loads;
// the viewer and the models are loaded only when a slot comes near the screen. Without WebGL2 the stage shows a
// short note instead (.m3-off) and the buttons are hidden.

const T = {
  explode: ['Explode', '拆開'],
  assemble: ['Assemble', '組合'],
  reset: ['Reset', '還原'],
  hint: ['Drag to turn, press a part to see its name. Click once, then the wheel zooms; on a phone, pinch.', '拖曳旋轉，點零件看名稱。先點一下畫面，滾輪才會縮放；手機用雙指。'],
  loading: ['Loading the model…', '模型載入中…'],
  none: ['No triple in the figure names this part.', '圖上沒有 triple 提到這個零件。'],
  off: ['This browser cannot draw 3D (WebGL2 is off), so the model is not shown. The caption below says what it rebuilds.', '這個瀏覽器無法畫 3D（WebGL2 未開啟），模型不顯示；下方圖說寫了它重建的是什麼。'],
  models: ['3D models', '3D 模型'],
};

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (en, zh) => `<span class="en">${esc(en)}</span><span class="zh">${esc(zh)}</span>`;
const pair = (k) => bi(T[k][0], T[k][1]);
const pick2 = (v) => (v && typeof v === 'object' ? [v.en ?? '', v.zh ?? v.en ?? ''] : [v ?? '', v ?? '']);
// tab names come from the ids, so the tabs exist before the models load: product3 → Product3 (as printed in Fig. 4)
const tabName = (id) => id.replace(/^product(\d+)$/, 'Product$1');

let libs = null;
function loadLibs() {
  libs ||= Promise.all([import('./viewer.js'), import('./products.js')]);
  return libs;
}

/** Build the frame of one slot. Returns the controller that `load()` fills in later. */
function frame(slot) {
  const ids = (slot.dataset.models || '').split(/\s+/).filter(Boolean);
  if (!ids.length) return null;
  slot.innerHTML = '';
  slot.setAttribute('role', 'group');
  const bar = document.createElement('div'); bar.className = 'm3-bar';
  const stage = document.createElement('div'); stage.className = 'm3-stage';
  stage.innerHTML = `<div class="m3-off m3-wait">${pair('loading')}</div>`;
  const info = document.createElement('div'); info.className = 'm3-pick'; info.setAttribute('aria-live', 'polite');
  info.innerHTML = pair('hint');
  const cap = document.createElement('p'); cap.className = 'm3-cap';
  cap.innerHTML = bi(slot.dataset.captionEn || '', slot.dataset.captionZh || slot.dataset.captionEn || '');
  slot.append(bar, stage, info, cap);

  const st = { ids, current: ids[0], exploded: false, viewer: null, models: [] };
  let tabs = null;
  if (ids.length > 1) {
    tabs = document.createElement('div');
    tabs.className = 'm3-tabs'; tabs.setAttribute('role', 'group'); tabs.setAttribute('aria-label', T.models[0]);
    for (const id of ids) {
      const b = document.createElement('button');
      b.type = 'button'; b.dataset.model = id; b.textContent = tabName(id); b.disabled = true;
      b.setAttribute('aria-pressed', String(id === st.current));
      b.addEventListener('click', () => choose(id));
      tabs.append(b);
    }
    bar.append(tabs);
  }
  const btnX = document.createElement('button');
  btnX.type = 'button'; btnX.className = 'm3-btn'; btnX.dataset.m3 = 'explode'; btnX.disabled = true;
  const btnR = document.createElement('button');
  btnR.type = 'button'; btnR.className = 'm3-btn'; btnR.dataset.m3 = 'reset'; btnR.disabled = true; btnR.innerHTML = pair('reset');
  bar.append(btnX, btnR);
  const paintX = () => { btnX.innerHTML = pair(st.exploded ? 'assemble' : 'explode'); btnX.setAttribute('aria-pressed', String(st.exploded)); };
  paintX();

  btnX.addEventListener('click', () => { st.exploded = !st.exploded; paintX(); st.viewer?.explode(st.exploded ? 1 : 0); });
  btnR.addEventListener('click', () => { st.exploded = false; paintX(); st.viewer?.reset(); info.innerHTML = pair('hint'); });

  const label = (id) => {
    const m = st.models.find((x) => x.id === id);
    st.viewer?.canvas?.setAttribute('aria-label', `${m ? pick2(m.title)[0] : tabName(id)} (3D)`);
  };
  async function choose(id) {
    if (id === st.current || !st.viewer) return;
    st.current = id; st.exploded = false; paintX();
    tabs?.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.model === id)));
    info.innerHTML = pair('hint');
    await st.viewer.setModel(id);
    label(id);
  }
  function showPick(p) {
    if (!p) { info.innerHTML = pair('hint'); return; }
    const [en, zh] = pick2(p.name);
    const lab = p.label === 'No label' ? bi('No label', '無標號') : esc(p.label || en);
    const head = `<b>${lab}</b> ${p.label && p.label !== en ? bi(` · ${en}`, ` · ${zh}`) : bi('', ` · ${zh}`)}`;
    const tr = (p.triples || []).map((t) => `<code>${esc(Array.isArray(t) ? `(${t.join(', ')})` : t)}</code>`).join('');
    const hasTriples = st.models.find((m) => m.id === st.current)?.triples?.length;
    info.innerHTML = head + (tr || (hasTriples ? `<code>${pair('none')}</code>` : ''));
  }

  async function load() {
    try {
      const [{ createModelViewer }, { getModel }] = await loadLibs();
      st.models = ids.map((id) => getModel(id));
      stage.innerHTML = '';
      st.viewer = await createModelViewer(stage, {
        model: st.current,
        onPick: showPick,
        reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      });
    } catch (err) {
      console.warn('[model3d]', err);
      stage.innerHTML = `<div class="m3-off">${pair('off')}</div>`;
      bar.hidden = true; info.hidden = true;
      return;
    }
    label(st.current);
    bar.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    slot.__viewer = st.viewer;
  }
  return { load };
}

export function createModelEmbeds(root = document) {
  const slots = [...root.querySelectorAll('.model3d[data-models]')];
  if (!slots.length) return null;
  const ctl = new Map(slots.map((s) => [s, frame(s)]).filter(([, c]) => c));
  const started = new WeakSet();
  const start = (el) => { if (started.has(el) || !ctl.has(el)) return; started.add(el); ctl.get(el).load(); };
  if (!('IntersectionObserver' in window)) { slots.forEach(start); return { slots }; }
  const io = new IntersectionObserver((es) => {
    for (const e of es) if (e.isIntersecting) { io.unobserve(e.target); start(e.target); }
  }, { rootMargin: '400px 0px' });
  slots.forEach((s) => io.observe(s));
  return { slots, start };
}
