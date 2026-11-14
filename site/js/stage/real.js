// Stage tab "Real": our own desk footage (two videos, three photos), the Grounding DINO + SAM 2.1 output drawn on it,
// and the raw prompts and replies of every local GPT-4o / GPT-4o-mini run. Everything here is tagged "Local run".
// Nothing on this tab is the paper's data: see the fixed "How this differs from the paper" block.
import { RELATIONS, norm } from '../metrics.js';
import { outOfListByModel } from './scores.js';

const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const bi = (en, zh) => `<span class="en" lang="en">${en}</span><span class="zh" lang="zh-Hant">${zh}</span>`;
const tag = t => `<span class="tag" data-tag="${t}">${t}</span>`;
const site = p => new URL(`../../${String(p).replace(/^site\//, '')}`, import.meta.url).href;   // JSON paths carry a site/ prefix
const getJSON = async p => { const r = await fetch(site(p)); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };
const triText = t => `⟨${t[0]}, ${t[1]}, ${t[2]}⟩`;
const triHtml = t => `⟨${esc(t[0])}, <b>${esc(t[1])}</b>, ${esc(t[2])}⟩`;
const sec = t => `${t.toFixed(1)} s`;
const iou = (a, b) => {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]), h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  const i = Math.max(0, w) * Math.max(0, h), u = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - i;
  return u ? i / u : 0;
};
const runId = r => `${r.model}/${r.variant}/${r.run}`;
const ICON = {
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4.5v15l12-7.5z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14M16 5v14"/></svg>',
  prev: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 5v14M19 5l-9 7 9 7z"/></svg>',
  next: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 5v14M5 5l9 7-9 7z"/></svg>',
};

const MEDIA = {
  scene2: { kind: 'video', file: 'media/video/scene2_assembly_1080', tracks: 'data/perception/scene2_tracks.json', still: 'B', w: 1920, h: 1080, poster: 'media/photo/20261112_031939410.jpg',
    name: ['Scene 2 video', '場景 2 影片'], what: ['a hand assembles two pens and a fidget spinner, six steps', '人手組裝兩支筆與指尖陀螺，六步'] },
  scene1: { kind: 'video', file: 'media/video/scene1_sweep_1080', tracks: 'data/perception/scene1_tracks.json', still: 'A', w: 1080, h: 1920,
    name: ['Scene 1 video', '場景 1 影片'], what: ['handheld sweep over desk tools, perception only', '手持掃過桌上工具，只做感知'] },
  B: { kind: 'photo', json: 'data/perception/sceneB_disassembled.json', check: 'sceneB_disassembled', video: 'scene2',
    name: ['Photo B', '照片 B'], zhNote: '場景 2 組裝前：每個零件分開放在桌上。', what: ['scene 2, parts apart: the photo sent to the VLM', '場景 2 拆開：送給 VLM 的那張'] },
  Bdone: { kind: 'photo', json: 'data/perception/sceneB_assembled.json', check: 'sceneB_assembled', video: 'scene2',
    name: ['Photo B done', '照片 B 組好'], zhNote: '場景 2 組裝後：筆芯與握把在筆管裡或筆管上，蓋子在陀螺上，所以零件分開時的預期數量不能直接套用。', what: ['scene 2, assembled', '場景 2 組好'] },
  A: { kind: 'photo', json: 'data/perception/sceneA_still.json', check: 'sceneA_still', video: 'scene1',
    name: ['Photo A', '照片 A'], zhNote: '場景 1（感知）：8 件工具、6 顆螺帽、一把鋼尺，全部分開放。', what: ['scene 1, tools on the desk', '場景 1 桌上工具'] },
};
const STAGES = { relation_narrator: 'Relation Narrator', image_narrator: 'Image Narrator', base_searcher: 'Base Searcher', action_narrator: 'Action Narrator', triple_extractor: 'Triple Extractor' };

/** Tiny WebVTT reader: cue start, end and text. Enough for our own caption files. */
export function parseVtt(text) {
  const cues = [], toS = s => { const p = s.split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n'), i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->').map(s => s.trim().split(' ')[0]);
    cues.push({ t0: toS(a), t1: toS(b), text: lines.slice(i + 1).join('\n') });
  }
  return cues;
}

/** Things the per-frame detections of scene 1 show. Every number is counted from the tracks file; nothing is hand-typed. */
export function scene1Markers(tr) {
  const T = tr.t, N = T.length, top = (p, i) => tr.tracks[p]?.[i]?.[0], out = [];
  const times = idx => idx.map(i => T[i].toFixed(1)).join(', ');
  const four = ['silver adjustable wrench', 'silver utility knife', 'nail clipper', 'metal clip'].filter(p => tr.tracks[p]);
  const same = (ps, i) => ps.every(p => top(p, i)) && ps.every(p => iou(top(p, i), top(ps[0], i)) >= 0.8);
  if (four.length === 4) {
    const idx = T.map((_, i) => i).filter(i => same(four, i));
    if (idx.length) out.push({ t: T[idx[0]], prompt: 'nail clipper',
      en: `Four prompts (wrench, utility knife, nail clipper, metal clip) return the same top box (IoU ≥ 0.8) in ${idx.length} of ${N} frames.`,
      zh: `四個提示詞（wrench、utility knife、nail clipper、metal clip）在 ${N} 格裡有 ${idx.length} 格，第一名是同一個框（IoU ≥ 0.8）。` });
  }
  const pairHits = (p, q) => T.map((_, i) => i).filter(i => top(p, i) && top(q, i) && iou(top(p, i), top(q, i)) >= 0.8);
  const ws = tr.tracks.scissors ? pairHits('silver adjustable wrench', 'scissors') : [];
  if (ws.length) out.push({ t: T[ws[0]], prompt: 'silver adjustable wrench',
    en: `“silver adjustable wrench”: the top box jumps onto the “scissors” box at ${times(ws)} s.`, zh: `「silver adjustable wrench」：第一名的框在 ${times(ws)} 秒跳到「scissors」的框上。` });
  const nut = 'small silver hexagonal nut', nc = tr.counts[nut];
  if (nc) {
    const min = Math.min(...nc), i = nc.indexOf(min), exp = tr.expected[nut], exact = nc.filter(x => x === exp).length;
    out.push({ t: T[i], prompt: nut, en: `“${nut}”: ${min} boxes at this frame, ${exp} expected. Exactly ${exp} boxes in ${exact} of ${N} frames.`, zh: `「${nut}」：這一格只有 ${min} 個框，預期 ${exp} 個。${N} 格裡剛好 ${exp} 個框的有 ${exact} 格。` });
  }
  const st = tr.tracks.stapler ? T.map((_, i) => i).filter(i => !tr.tracks.stapler[i].length) : [];
  if (st.length) out.push({ t: T[st[0]], prompt: 'stapler', en: `“stapler”: no box above ${tr.thresholds?.box_threshold ?? 0.35} at ${times(st)} s (${st.length} of ${N} frames).`, zh: `「stapler」：${times(st)} 秒沒有超過 ${tr.thresholds?.box_threshold ?? 0.35} 的框（${N} 格裡 ${st.length} 格）。` });
  const rl = tr.tracks['steel ruler'] ? pairHits('steel ruler', 'nail clipper') : [];
  if (rl.length) out.push({ t: T[rl[0]], prompt: 'steel ruler', en: `“steel ruler”: the top box coincides with the “nail clipper” top box at ${times(rl)} s.`, zh: `「steel ruler」：第一名的框在 ${times(rl)} 秒和「nail clipper」的第一名重疊。` });
  return out.sort((a, b) => a.t - b.t);
}

/** Scene 2: when the cap prompt stops seeing two separate caps. Counted from the tracks file. */
export function scene2Markers(tr) {
  const T = tr.t, cap = 'small round metal cap', sp = 'silver three-lobed spinner', out = [];
  if (!tr.tracks[cap] || !tr.tracks[sp]) return out;
  const merged = T.map((_, i) => i).filter(i => tr.tracks[cap][i][0] && tr.tracks[sp][i][0] && iou(tr.tracks[cap][i][0], tr.tracks[sp][i][0]) >= 0.8);
  if (!merged.length) return out;
  const before = T.filter((t, i) => t < T[merged[0]] && tr.counts[cap][i] === 2), lastTwo = before[before.length - 1];
  out.push({ t: T[merged[0]], prompt: cap,
    en: `“${cap}”: two boxes up to ${lastTwo?.toFixed(1)} s. From ${T[merged[0]].toFixed(1)} s its top box coincides with the spinner box (IoU ≥ 0.8) in ${merged.length} frames: a mounted cap is no longer seen as its own part.`,
    zh: `「${cap}」：到 ${lastTwo?.toFixed(1)} 秒為止是兩個框。${T[merged[0]].toFixed(1)} 秒起，第一名的框有 ${merged.length} 格和陀螺的框重疊（IoU ≥ 0.8）：蓋子裝上去之後就不再被當成獨立零件。` });
  return out;
}

/** Wrap every relation that is not in the Fig. 5 list in <mark>. Returns { html, n, off }. */
export function markRelations(text) {
  const re = /\(([^()]+?),\s*([^(),]+?),\s*([^()]+?)\)/g;
  let m, last = 0, html = '', n = 0, off = 0;
  while ((m = re.exec(text))) {
    n++;
    if (RELATIONS.includes(norm(m[2]))) continue;
    off++;
    const start = m.index + 1 + m[1].length + m[0].slice(1 + m[1].length).indexOf(m[2]);
    html += esc(text.slice(last, start)) + `<mark class="w-ool">${esc(m[2])}</mark>`;
    last = start + m[2].length;
  }
  return { html: html + esc(text.slice(last)), n, off };
}

export async function mount(el, ctx = {}) {
  const [gt, summary, checks] = await Promise.all([getJSON('data/sceneB_gt.json'), getJSON('data/vlm/summary.json'), getJSON('data/perception/count_check.json')]);
  const steps = gt.video_steps;
  const cache = new Map();
  const load = p => { if (!cache.has(p)) cache.set(p, getJSON(p)); return cache.get(p); };
  const loadText = p => { if (!cache.has(p)) cache.set(p, fetch(site(p)).then(r => (r.ok ? r.text() : ''))); return cache.get(p); };
  const state = { view: 'footage', media: 'scene2', prompt: 'all', boxes: false, cc: true, step: -1, frame: -1, raw: runId(summary.runs.find(r => r.model === 'gpt-4o' && r.variant === 'with_base') || summary.runs[0]), stage: 'triple_extractor', open: {} };
  const bind = (k, v) => { try { ctx.bind?.(k, v); } catch { /* host not ready */ } };
  const emit = (e, d) => { try { ctx.bus?.emit?.(e, d); } catch { /* host not ready */ } };
  const status = s => { try { ctx.setStatus?.(s); } catch { /* optional */ } };
  let video = null, cues = { en: [], zh: [] }, tracks = null, det = null, markers = [], pendingSeek = null, raf = 0, token = 0, rawToken = 0, blobUrl = null, emitted = -1;

  el.classList.add('w', 'w-real');
  el.innerHTML = `
    <div class="w-nav" role="group" aria-label="Real views">
      <button type="button" data-view="footage">${bi('Footage and detection', '實拍與偵測')}</button>
      <button type="button" data-view="raw">${bi('VLM prompts and replies', 'VLM 提示詞與回覆')}</button>
    </div>
    <div class="w-body">
      <section class="panel" data-pane="footage">
        <header class="panel-head"><h3 class="panel-name">${bi('The steps of the paper on a real desk', '論文的每一步，在桌上實物發生')}</h3><span class="panel-ref" data-role="ref"></span>${tag('Local run')}</header>
        <div class="panel-body">
          <div class="w-seg w-pick" role="group" aria-label="Footage">${Object.entries(MEDIA).map(([k, m]) => `<button type="button" data-media="${k}" title="${esc(m.what[0])}">${bi(m.name[0], m.name[1])}</button>`).join('')}</div>
          <div class="w-viewer" data-role="viewer">
            <div class="w-frame" data-role="frame"><div class="w-media" data-role="media"></div><svg class="w-overlay" data-role="overlay" preserveAspectRatio="none" aria-hidden="true"></svg><div class="w-labels" data-role="labels" aria-hidden="true"></div><div class="w-grip" data-role="grip" role="slider" tabindex="0" aria-label="Picture size" aria-valuemin="24" aria-valuemax="88" aria-valuenow="58" title="Drag to resize the picture; double-click to reset"></div></div>
            <div class="w-under">
              <div class="w-player" data-role="player">
                <div class="w-pbar">
                  <button type="button" class="icon-btn" data-ctl="prev" aria-label="Previous step">${ICON.prev}</button>
                  <button type="button" class="icon-btn w-play" data-ctl="play" aria-label="Play">${ICON.play}</button>
                  <button type="button" class="icon-btn" data-ctl="next" aria-label="Next step">${ICON.next}</button>
                  <output class="w-time" data-role="time">0.0 s</output>
                  <input type="range" data-ctl="seek" min="0" max="1" step="0.1" value="0" aria-label="Seek" data-keys="own">
                  <select data-ctl="rate" aria-label="Playback speed"><option value="0.5">0.5×</option><option value="1" selected>1×</option><option value="2">2×</option></select>
                  <button type="button" class="btn w-tgl" data-ctl="cc" aria-pressed="true">CC</button>
                  <button type="button" class="btn w-tgl" data-ctl="boxes" aria-pressed="false">${bi('Boxes', '偵測框')}</button>
                </div>
                <div class="w-timeline" data-role="timeline"></div>
              </div>
              <div class="w-now" data-role="now" aria-live="polite"></div>
              <p class="w-caption" data-role="caption"></p>
              <ol class="w-marks" data-role="marks"></ol>
            </div>
          </div>
          <div class="w-detect" data-role="detect"></div>
        </div>
        <footer class="panel-src" data-role="src"></footer>
      </section>
      <section class="panel" data-pane="raw">
        <header class="panel-head"><h3 class="panel-name">${bi('What was sent and what came back', '送出去的，和回來的')}</h3><span class="panel-ref">Eq. (1)(2)(3) · Fig. 5</span>${tag('Local run')}</header>
        <div class="panel-body" data-role="raw"></div>
        <footer class="panel-src">${bi('Source: data/vlm/raw/**/runN.json, written by tools/run_vlm.py; counts recomputed here from data/vlm/summary.json.', '來源：data/vlm/raw/**/runN.json，由 tools/run_vlm.py 寫出；次數是這裡用 data/vlm/summary.json 重算的。')}</footer>
      </section>
      <section class="panel w-diff" aria-label="How this differs from the paper">
        <header class="panel-head"><h3 class="panel-name">${bi('How this differs from the paper', '和論文的差別')}</h3><span class="panel-ref">§3.2 · §4</span>${tag('Local run')}</header>
        <div class="panel-body"><ul class="w-difflist">
          <li><b>1</b>${bi('A human hand moves the parts. The paper uses an xArm6 robot.', '動手的是人。論文用的是 xArm6 機械手臂。')}</li>
          <li><b>2</b>${bi('A phone gives RGB only: no depth d_t(u,v) and no calibrated K. Eq. (4) cannot be computed on this footage.', '手機只有 RGB：沒有深度 d_t(u,v)，也沒有標定過的 K。式 (4) 沒辦法在這些素材上算。')}</li>
          <li><b>3</b>${bi('The objects are desk tools, two pens and a fidget spinner, not the paper’s gearbox.', '物件是桌上工具、兩支筆和指尖陀螺，不是論文的齒輪箱。')}</li>
          <li><b>4</b>${bi('The VLM gets a photo of the loose parts, not an assembly drawing.', 'VLM 拿到的是零件的照片，不是組裝圖。')}</li>
          <li><b>5</b>${bi('The Triple Extractor few-shot examples are two we wrote ourselves. The paper’s six examples are not printed (Fig. 5).', 'Triple Extractor 的 few-shot 例子是我們自己寫的兩個。論文的六個例子沒有印出來（圖 5）。')}</li>
        </ul></div>
      </section>
    </div>`;
  const $ = r => el.querySelector(`[data-role="${r}"]`);
  const nav = el.querySelector('.w-nav');
  const M = () => MEDIA[state.media];

  // ── picture size: drag the corner grip (or focus it and use the arrow keys); kept for the next visit
  {
    const frame = $('frame'), grip = $('grip'), KEY = 'msgraph.videoH', DEF = 58;
    const set = (v, save = true) => {
      const n = Math.max(24, Math.min(88, Math.round(v)));
      frame.style.setProperty('--vsize', String(n));
      grip.setAttribute('aria-valuenow', String(n));
      if (save) { try { if (n === DEF) localStorage.removeItem(KEY); else localStorage.setItem(KEY, String(n)); } catch { /* private mode */ } }
      return n;
    };
    let cur = DEF, drag = null;
    try { const s = parseFloat(localStorage.getItem(KEY)); if (s >= 24 && s <= 88) cur = set(s, false); } catch { /* private mode */ }
    grip.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      drag = { id: e.pointerId, y: e.clientY, v: cur };
      grip.setPointerCapture(e.pointerId); frame.classList.add('is-sizing'); e.preventDefault(); e.stopPropagation();
    });
    grip.addEventListener('pointermove', (e) => { if (drag && e.pointerId === drag.id) cur = set(drag.v + ((e.clientY - drag.y) / Math.max(1, window.innerHeight)) * 100, false); });
    const end = (e) => { if (!drag || e.pointerId !== drag.id) return; drag = null; frame.classList.remove('is-sizing'); cur = set(cur); try { grip.releasePointerCapture(e.pointerId); } catch { /* released */ } };
    grip.addEventListener('pointerup', end); grip.addEventListener('pointercancel', end);
    grip.addEventListener('dblclick', () => { cur = set(DEF); });
    grip.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowUp' || e.key === 'ArrowLeft' ? -4 : e.key === 'ArrowDown' || e.key === 'ArrowRight' ? 4 : 0;
      if (e.key === 'Home') cur = set(24); else if (e.key === 'End') cur = set(88); else if (e.key === 'Enter') cur = set(DEF); else if (d) cur = set(cur + d); else return;
      e.preventDefault(); e.stopPropagation();
    });
  }
  const isVideo = () => M().kind === 'video';

  /* ------------------------------------------------------------ media */
  async function setMedia(key, { play = false, seek = null } = {}) {
    if (!MEDIA[key]) return false;
    const my = ++token;
    const same = key === state.media && (video || det);
    state.media = key;
    const m = M();
    if (!same) {
      cancelAnimationFrame(raf);
      if (video) { video.pause(); video.removeAttribute('src'); video.load?.(); }
      if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
      pendingSeek = null; emitted = -1;
      video = null; tracks = null; det = null; markers = []; state.step = -1; state.frame = -1; cues = { en: [], zh: [] };
      $('overlay').innerHTML = ''; $('labels').innerHTML = ''; $('caption').textContent = ''; $('now').innerHTML = ''; $('marks').innerHTML = '';
      $('viewer').dataset.kind = m.kind;
      $('viewer').dataset.orient = m.kind === 'video' && m.h > m.w ? 'portrait' : 'landscape';
      if (m.kind === 'video') {
        $('frame').style.aspectRatio = `${m.w} / ${m.h}`;
        $('frame').style.setProperty('--ar', (m.w / m.h).toFixed(4));
        $('overlay').setAttribute('viewBox', `0 0 ${m.w} ${m.h}`);
        $('media').innerHTML = `<video muted playsinline preload="metadata" tabindex="0"${m.poster ? ` poster="${site(m.poster)}"` : ''} aria-label="${esc(m.name[0])}: ${esc(m.what[0])}. Silent; captions below.">
          <source src="${site(m.file + '.mp4')}" type="video/mp4">
          <track kind="captions" srclang="en" label="English" src="${site(m.file + '.en.vtt')}">
          <track kind="captions" srclang="zh-Hant" label="繁體中文" src="${site(m.file + '.zh.vtt')}"></video>`;
        video = $('media').querySelector('video');
        for (const t of video.textTracks) t.mode = 'disabled';   // captions are drawn below the picture from the same .vtt files
        wireVideo(video);
        const [tr, en, zh] = await Promise.all([load(m.tracks), loadText(m.file + '.en.vtt'), loadText(m.file + '.zh.vtt')]);
        if (my !== token) return true;
        tracks = tr; cues = { en: parseVtt(en), zh: parseVtt(zh) };
        markers = key === 'scene1' ? scene1Markers(tr) : scene2Markers(tr);
        if (!Object.keys(tr.tracks).includes(state.prompt)) state.prompt = 'all';
      } else {
        det = await load(m.json);
        if (my !== token) return true;
        const [w, h] = det.image_size;
        $('frame').style.aspectRatio = `${w} / ${h}`;
        $('frame').style.setProperty('--ar', (w / h).toFixed(4));
        $('overlay').setAttribute('viewBox', `0 0 ${w} ${h}`);
        $('media').innerHTML = `<img src="${site(det.base_image)}" width="${w}" height="${h}" alt="${esc(det.note)}">`;
        if (!det.prompts[state.prompt]) state.prompt = 'all';
      }
    }
    renderChrome();
    if (isVideo()) {
      if (seek != null) seekTo(seek);
      if (play) video.play().catch(() => {});
      tick(true);
    } else drawPhoto();
    renderDetect();
    return true;
  }

  function wireVideo(v) {
    const loop = () => { tick(); if (!v.paused && !v.ended) raf = requestAnimationFrame(loop); };
    v.addEventListener('loadedmetadata', () => {
      // A server without byte ranges (python -m http.server) gives a stream that cannot seek. Load the file into memory instead.
      const n = v.seekable.length, canSeek = n > 0 && v.seekable.end(n - 1) >= v.duration - 1;
      if (!canSeek && !v.dataset.blob) {
        v.dataset.blob = 'loading';
        fetch(v.currentSrc, { cache: 'no-store' }).then(r => r.blob()).then(blob => {
          if (video !== v) return;
          const t = pendingSeek ?? v.currentTime, playing = !v.paused;
          blobUrl = URL.createObjectURL(blob);
          v.querySelector('source')?.remove();
          v.dataset.blob = 'ready'; v.src = blobUrl; pendingSeek = t; v.load();
          if (playing) v.play().catch(() => {});
        }).catch(() => { v.dataset.blob = 'failed'; });
        renderTimeline(); tick(true);
        return;
      }
      if (pendingSeek != null && v.dataset.blob !== 'loading') { v.currentTime = Math.min(pendingSeek, Math.max(0, v.duration - 0.05)); pendingSeek = null; }
      renderTimeline(); tick(true);
    });
    v.addEventListener('play', () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(loop); syncPlay(); });
    v.addEventListener('pause', () => { syncPlay(); tick(true); });
    v.addEventListener('ended', () => { syncPlay(); tick(true); });
    v.addEventListener('seeked', () => tick(true));
    v.addEventListener('timeupdate', () => { tick(); bind('video.t', v.currentTime); });
    v.addEventListener('click', toggle);
    const failed = () => { $('viewer').dataset.novideo = '1'; $('now').hidden = false; $('now').innerHTML = `<span class="w-now-s">${bi('This browser could not play the video file (H.264 in MP4). The photos, the detection overlay and the step list still work.', '這個瀏覽器播不了影片檔（MP4 裡的 H.264）。照片、偵測疊圖與步驟清單仍然可用。')}</span>`; };
    v.addEventListener('error', failed);
    v.querySelector('source').addEventListener('error', failed);
  }
  const duration = () => (video && Number.isFinite(video.duration) && video.duration > 0 ? video.duration : tracks ? tracks.t[tracks.t.length - 1] + 0.5 : 1);
  function toggle() { if (!video) return; if (video.paused || video.ended) video.play().catch(() => {}); else video.pause(); }
  function syncPlay() {
    const b = el.querySelector('[data-ctl="play"]'), playing = video && !video.paused && !video.ended;
    b.innerHTML = playing ? ICON.pause : ICON.play;
    b.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  }
  function seekTo(t) {
    if (!video) return;
    const tt = Math.max(0, t);
    if (video.readyState >= 1 && video.dataset.blob !== 'loading') { video.currentTime = Math.min(tt, Math.max(0, duration() - 0.05)); } else pendingSeek = tt;
    tick(true);
  }
  const stepAt = t => { const n = steps.filter(s => t >= s.t0).length; return { n, active: n > 0 && t < steps[n - 1].t1 }; };

  /** Called on every frame while playing, and once after a seek. Updates the cursor, caption, current step and per-frame boxes. */
  function tick(force = false) {
    if (!video) return;
    const t = pendingSeek ?? video.currentTime, d = duration();
    $('time').textContent = `${t.toFixed(1)} / ${d.toFixed(1)} s`;
    const seek = el.querySelector('[data-ctl="seek"]');
    if (document.activeElement !== seek || force) seek.value = t;
    seek.setAttribute('aria-valuetext', `${t.toFixed(1)} seconds of ${d.toFixed(1)}`);
    $('timeline').style.setProperty('--pos', `${Math.min(100, t / d * 100)}%`);
    // caption from the .vtt cues
    const cue = l => { const c = cues[l].find(c => t >= c.t0 && t < c.t1)?.text || ''; return state.media === 'scene2' ? c.replace(/^t = \d.*\n/, '') : c; };
    const key = `${cue('en')}|${state.cc}`;
    if (key !== $('caption').dataset.key) {
      $('caption').dataset.key = key;
      $('caption').innerHTML = state.cc ? `<span class="en" lang="en">${esc(cue('en')).replace(/\n/g, '<br>')}</span><span class="zh" lang="zh-Hant">${esc(cue('zh')).replace(/\n/g, '<br>')}</span>` : '';
    }
    if (state.media === 'scene2') {
      const { n, active } = stepAt(t);
      const k = n * 2 + (active ? 1 : 0);
      if (k !== state.step || force) {
        const changed = emitted !== n;
        emitted = n;
        state.step = k;
        const s = steps[n - 1];
        $('now').innerHTML = n === 0
          ? `<span class="w-now-t">t = 0</span><span class="w-now-tri">${bi('Parts apart. G_0 has no edges yet.', '零件分開。G_0 還沒有邊。')}</span>`
          : `<span class="w-now-t">t = ${n}</span><span class="w-now-tri">${triHtml(s.triple)}</span><span class="w-now-s">${active ? bi(`in progress, ${s.t0.toFixed(1)}–${s.t1.toFixed(1)} s`, `進行中，${s.t0.toFixed(1)}–${s.t1.toFixed(1)} 秒`) : bi(`done at ${s.t1.toFixed(1)} s`, `${s.t1.toFixed(1)} 秒完成`)}</span>`;
        el.querySelectorAll('.w-segm').forEach((b, i) => { b.toggleAttribute('data-on', active && i === n - 1); b.toggleAttribute('data-done', i < n - (active ? 1 : 0)); if (active && i === n - 1) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current'); });
        if (changed) {
          bind('video.step', n); bind('video.triple', s ? triText(s.triple) : '');
          emit('video:step', { n, triple: s ? s.triple : null, t, active, scene: 'scene2' });
          status(n ? `Scene 2 · t = ${n} · ${triText(s.triple)}` : 'Scene 2 · t = 0 · parts apart');
        }
      }
    }
    if (tracks) {
      const i = Math.max(0, Math.min(tracks.t.length - 1, Math.round(t * tracks.sample_fps)));
      if (i !== state.frame || force) {
        if (state.media === 'scene1' && i !== state.frame) status(`Scene 1 · ${tracks.t[i].toFixed(1)} s · perception only, no triples`);
        state.frame = i; drawFrameBoxes(); updateFrameCounts();
      }
    }
  }

  /* ------------------------------------------------------------ chrome around the picture */
  function renderChrome() {
    const m = M();
    el.querySelectorAll('[data-media]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.media === state.media)));
    $('player').hidden = !isVideo();
    $('caption').hidden = !isVideo();
    $('now').hidden = state.media !== 'scene2';
    $('ref').textContent = state.media === 'scene2' ? 'G_t = (N_t, E_t) · R@k' : state.media === 'scene1' ? '§3.2 perception · Eq. (4)' : state.media === 'B' ? 'Eq. (1) input ν · c_i, m_i' : '§3.2 · c_i, m_i';
    el.querySelector('[data-ctl="boxes"]').setAttribute('aria-pressed', String(state.boxes));
    el.querySelector('[data-ctl="cc"]').setAttribute('aria-pressed', String(state.cc));
    renderTimeline();
    syncPlay();
    const list = markers.map((k, i) => `<li><button type="button" class="w-mark" data-mark="${i}"><span class="w-mono">${k.t.toFixed(1)} s</span><span>${bi(esc(k.en), esc(k.zh))}</span></button></li>`).join('');
    $('marks').innerHTML = list;
    $('marks').hidden = !list || !isVideo();
    $('src').innerHTML = isVideo()
      ? bi(`Source: ${esc(m.file)}.mp4 (${m.w}×${m.h}, silent) with captions ${esc(m.file.split('/').pop())}.en.vtt / .zh.vtt; step times from data/sceneB_gt.json; per-frame boxes from ${esc(m.tracks)} (Grounding DINO tiny, 2 frames per second, no tracking).`,
        `來源：${esc(m.file)}.mp4（${m.w}×${m.h}，無聲），字幕 ${esc(m.file.split('/').pop())}.en.vtt／.zh.vtt；各步時間取自 data/sceneB_gt.json；逐格框取自 ${esc(m.tracks)}（Grounding DINO tiny，每秒 2 格，沒有追蹤）。`)
      : bi(`Source: ${esc(m.json)} · Grounding DINO tiny + SAM 2.1 small, box ${det?.thresholds.box_threshold}, text ${det?.thresholds.text_threshold}, NMS IoU ${det?.thresholds.nms_iou} · check table data/perception/count_check.json.`,
        `來源：${esc(m.json)}；Grounding DINO tiny＋SAM 2.1 small，box ${det?.thresholds.box_threshold}、text ${det?.thresholds.text_threshold}、NMS IoU ${det?.thresholds.nms_iou}；核對表 data/perception/count_check.json。`);
  }
  function renderTimeline() {
    if (!isVideo()) return;
    const d = duration(), seek = el.querySelector('[data-ctl="seek"]');
    seek.max = d.toFixed(1);
    let h = '';
    if (state.media === 'scene2') h = steps.map((s, i) => {
      const region = i < 2 ? 'k' : i < 4 ? 'r' : 's';
      return `<button type="button" class="w-segm" data-step="${i + 1}" data-region="${region}" style="left:${s.t0 / d * 100}%;width:${(s.t1 - s.t0) / d * 100}%" aria-label="Step ${i + 1}, ${s.t0.toFixed(1)} to ${s.t1.toFixed(1)} seconds: ${esc(s.triple.join(' '))}" title="${esc(triText(s.triple))}"><b>${i + 1}</b><i>${esc(s.triple[1])}</i></button>`;
    }).join('');
    else h = markers.map((k, i) => `<button type="button" class="w-pin" data-mark="${i}" style="left:${k.t / d * 100}%" aria-label="${k.t.toFixed(1)} seconds: ${esc(k.en)}" title="${esc(k.en)}"><b>${i + 1}</b></button>`).join('');
    $('timeline').innerHTML = `<span class="w-track"></span>${h}<span class="w-cursor"></span>`;
    $('timeline').dataset.kind = state.media;
    state.step = -1;
  }

  /* ------------------------------------------------------------ detection overlay */
  const prompts = () => (isVideo() ? Object.keys(tracks?.tracks || {}) : Object.keys(det?.prompts || {}));
  const colour = p => prompts().indexOf(p) % 9;
  const pct = (v, total) => `${(v / total * 100).toFixed(2)}%`;
  let labelSpots = [];
  function label(x, y, W, H, c, text) {
    // boxes from different prompts often coincide: stack their labels instead of hiding one under another
    const near = labelSpots.filter(q => Math.abs(q[0] - x) / W < 0.2 && Math.abs(q[1] - y) / H < 0.035).length;
    labelSpots.push([x, y]);
    const below = y / H < 0.07 + near * 0.05;
    return `<span class="w-dlabel${below ? ' w-below' : ''}" data-c="${c}" style="left:${pct(x, W)};top:${pct(y, H)};margin-top:${(below ? 1 : -1) * near * 19}px">${esc(text)}</span>`;
  }
  function drawPhoto() {
    if (!det) return;
    const [W, H] = det.image_size, all = state.prompt === 'all';
    let svg = '', lab = '';
    labelSpots = [];
    for (const [p, v] of Object.entries(det.prompts)) {
      if (!all && p !== state.prompt) continue;
      const c = colour(p);
      v.detections.forEach((d, i) => {
        const [x1, y1, x2, y2] = d.box;
        if (d.polygon?.length) svg += `<polygon class="w-mask" data-c="${c}" points="${d.polygon.map(q => q.join(',')).join(' ')}"/>`;
        svg += `<rect class="w-box" data-c="${c}"${i ? ' data-rest' : ''} x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"/>`;
        if (!all || i === 0) lab += label(x1, y1, W, H, c, all ? `${p} ${d.score.toFixed(2)}` : `#${i + 1}  ${d.score.toFixed(2)}`);
      });
    }
    $('overlay').innerHTML = svg; $('labels').innerHTML = lab;
  }
  function drawFrameBoxes() {
    if (!tracks || !state.boxes) { if (isVideo()) { $('overlay').innerHTML = ''; $('labels').innerHTML = ''; } return; }
    const [W, H] = tracks.frame_size, i = state.frame < 0 ? 0 : state.frame, all = state.prompt === 'all';
    let svg = '', lab = '';
    labelSpots = [];
    for (const p of Object.keys(tracks.tracks)) {
      if (!all && p !== state.prompt) continue;
      const c = colour(p);
      (tracks.tracks[p][i] || []).forEach(([x1, y1, x2, y2, s]) => {
        svg += `<rect class="w-box" data-c="${c}" x="${x1}" y="${y1}" width="${x2 - x1}" height="${y2 - y1}"/>`;
        lab += label(x1, y1, W, H, c, `${p} ${s.toFixed(2)}`);
      });
    }
    $('overlay').innerHTML = svg; $('labels').innerHTML = lab;
  }
  function updateFrameCounts() {
    if (!tracks) return;
    const i = Math.max(0, state.frame);
    $('detect').querySelectorAll('[data-count]').forEach(td => {
      const p = td.dataset.count;
      if (!tracks.counts[p]) return;
      const n = tracks.counts[p][i], topBox = tracks.tracks[p][i][0];
      td.textContent = n; td.dataset.bad = String(n !== tracks.expected[p]);
      td.nextElementSibling.textContent = topBox ? topBox[4].toFixed(2) : '—';
    });
    const ft = $('detect').querySelector('[data-frame-t]');
    if (ft) ft.textContent = `${tracks.t[i].toFixed(1)} s`;
  }
  function renderDetect() {
    const m = M(), ps = prompts();
    const pick = p => `<button type="button" class="w-prompt" data-prompt="${esc(p)}" aria-pressed="${state.prompt === p}"><i class="w-sw" data-c="${p === 'all' ? 'all' : colour(p)}"></i>${p === 'all' ? bi('all prompts', '全部提示詞') : esc(p)}</button>`;
    let table = '', note = '';
    if (isVideo()) {
      if (!tracks) return;
      table = `<table class="w-table w-dtable"><caption>${bi(`Per-frame detection, frame nearest to <span data-frame-t>0.0 s</span> (2 frames per second)`, `逐格偵測，最接近 <span data-frame-t>0.0 s</span> 的那一格（每秒 2 格）`)}</caption>
        <thead><tr><th>${bi('Text prompt', '文字提示')}</th><th>${bi('Expected', '預期')}</th><th>${bi('Boxes in frame', '這一格的框數')}</th><th>${bi('Top score', '最高分')}</th></tr></thead>
        <tbody>${ps.map(p => `<tr data-sel="${state.prompt === p}"><th scope="row">${pick(p)}</th><td>${tracks.expected[p]}</td><td data-count="${esc(p)}">–</td><td>–</td></tr>`).join('')}</tbody></table>`;
      note = `<p class="w-note">${bi(`Turn on “Boxes” to draw them on the video. Each sampled frame is detected on its own: no tracking, no masks. A box above ${tracks.thresholds?.box_threshold ?? 0.35} is not proof that the object is there.`,
        `按「偵測框」把框疊在影片上。每一格各自偵測：沒有追蹤，也沒有遮罩。分數超過 ${tracks.thresholds?.box_threshold ?? 0.35} 的框，不代表那個物件真的在那裡。`)}</p>`;
    } else {
      if (!det) return;
      const rows = checks[m.check] || [];
      const yn = v => (v === true ? `<span class="w-yes">✓ ${bi('yes', '對')}</span>` : v === false ? `<span class="w-no">✗ ${bi('no', '不對')}</span>` : '—');
      table = `<table class="w-table w-dtable"><caption>${bi(esc(det.note), esc(m.zhNote))}</caption>
        <thead><tr><th>${bi('Text prompt', '文字提示')}</th><th>${bi('Expected', '預期')}</th><th>${bi('Detected', '偵測到')}</th><th>${bi('Correct', '正確')}</th><th>${bi('Top-1 right?', '第一名對不對')}</th><th>${bi('Wrong boxes on', '錯框落在')}</th></tr></thead>
        <tbody>${ps.map(p => {
          const r = rows.find(x => x.prompt === p) || {}, d = det.prompts[p], fb = r['fallback_0.25'];
          return `<tr data-sel="${state.prompt === p}"><th scope="row">${pick(p)}</th><td>${r.expected ?? d.expected}</td><td data-bad="${(r.detected ?? d.detected_at_default) !== (r.expected ?? d.expected)}">${r.detected ?? d.detected_at_default}</td><td>${r.correct ?? '—'}${r.partial ? ` <span class="w-dim">+${r.partial} ${bi('partial', '只框到一部分')}</span>` : ''}</td><td>${yn(r.top1_correct)}</td>
            <td class="w-wrong">${esc((r.wrong_boxes_on || []).join(', '))}${fb ? ` ${bi(`at the 0.25 fallback: ${fb.detected} box, score ${fb.score}`, `退到 0.25 才有：${fb.detected} 個框，分數 ${fb.score}`)}` : ''}${r.note ? `<span class="w-rownote">${esc(r.note)}</span>` : ''}</td></tr>`;
        }).join('')}</tbody></table>`;
      note = `<p class="w-note">${tag('My view')} ${bi('“Detected” is model output (boxes left after NMS). “Correct” and “Top-1 right?” were judged by eye from the picture after the run. They are not model output and not a labelled test set.',
        '「偵測到」是模型輸出（NMS 之後留下的框數）。「正確」與「第一名對不對」是跑完後人工看圖判的，不是模型輸出，也不是標註過的測試集。')}</p>
        <p class="w-note">${bi('Boxes c_i come from Grounding DINO, the filled outlines m_i from SAM 2.1 prompted with each box. In the paper these two feed Eq. (6), together with depth, which we do not have.', '框 c_i 來自 Grounding DINO；填色的輪廓 m_i 是 SAM 2.1 用每個框當提示切出來的。論文裡這兩樣加上深度一起進式 (6)；深度我們沒有。')}</p>`;
    }
    $('detect').innerHTML = `<div class="w-dhead"><h4>${bi('Open-vocabulary detection', '開放詞彙偵測')} <span class="w-mono">Grounding DINO → c_i · SAM 2.1 → m_i</span></h4>${pick('all')}</div><div class="w-scroll">${table}</div>${note}`;
    if (isVideo()) { state.frame = -1; tick(true); }
  }
  function setPrompt(p) {
    state.prompt = prompts().includes(p) ? p : 'all';
    if (isVideo()) { if (state.prompt !== 'all') state.boxes = true; el.querySelector('[data-ctl="boxes"]').setAttribute('aria-pressed', String(state.boxes)); drawFrameBoxes(); } else drawPhoto();
    renderDetect();
  }

  /* ------------------------------------------------------------ raw prompts and replies */
  async function renderRaw() {
    const run = summary.runs.find(r => runId(r) === state.raw) || summary.runs[0];
    const my = ++rawToken;
    const doc = await load(run.file);
    if (my !== rawToken) return;
    const st = doc.stages.find(s => s.stage === state.stage) || doc.stages[doc.stages.length - 1];
    state.stage = st.stage;
    const groups = {};
    for (const r of summary.runs) (groups[`${r.scene === 'A' ? 'Scene 1 photo' : 'Scene 2 photo'} · ${r.model}`] ||= []).push(r);
    const options = Object.entries(groups).map(([g, rs]) => `<optgroup label="${esc(g)}">${rs.map(r => `<option value="${runId(r)}"${r === run ? ' selected' : ''}>${esc(r.model)} · ${esc(r.variant.replace('_', ' '))} · run ${r.run}</option>`).join('')}</optgroup>`).join('');
    const isList = st.stage === 'triple_extractor', hasTriples = isList || st.stage === 'relation_narrator';
    const marked = hasTriples ? markRelations(st.reply) : { html: esc(st.reply), n: 0, off: 0 };
    const u = st.usage || {};
    const chain = doc.stages.reduce((a, s) => a + (s.usage?.total_tokens || 0), 0);
    const ro = (label, value, sub = '') => `<div class="readout"><small>${label}</small><output>${value}</output>${sub ? `<span class="w-frac">${sub}</span>` : ''}</div>`;
    const block = (key, title, html, chars) => `<div class="w-rawblock"><div class="w-rawhead"><h4>${title}</h4><span class="w-dim">${chars} ${bi('characters', '字元')}</span>
        <button type="button" class="btn w-tgl" data-expand="${key}" aria-pressed="${!!state.open[key]}">${bi('Expand', '展開')}</button></div>
      <pre class="w-pre" data-open="${!!state.open[key]}" tabindex="0">${html}</pre></div>`;
    const stat = outOfListByModel(summary.runs);
    const relStat = {};
    for (const r of summary.runs.filter(r => r.scene === 'B')) { const o = (relStat[r.model] ||= { runs: 0, off: 0, n: 0 }); o.runs++; o.off += r.relation_out_of_list; o.n += r.relation_triples.length; }
    const statRows = Object.entries(stat).map(([model, v]) => `<tr><th scope="row" class="w-nw">${esc(model)}</th><td><b>${v.runsWith}</b> / ${v.runs}</td><td><b>${v.triplesOut}</b> / ${v.triples}</td><td class="w-wrong">${esc(Object.entries(v.terms).sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} ×${n}`).join(', '))}</td><td>${relStat[model].off} / ${relStat[model].n}</td></tr>`).join('');
    const sum = Object.values(stat).reduce((a, v) => ({ w: a.w + v.runsWith, r: a.r + v.runs }), { w: 0, r: 0 });
    $('raw').innerHTML = `
      <div class="w-controls">
        <label class="w-field"><span>${bi('Run', '實跑')}</span><select data-ctl="rawrun" aria-label="Run">${options}</select></label>
        <span class="w-field"><span>${bi('Agent', '階段')}</span><span class="w-seg" role="group" aria-label="Agent">${doc.stages.map((s, i) => `<button type="button" data-stage="${s.stage}" aria-pressed="${s === st}">${i + 1} ${STAGES[s.stage] || esc(s.stage)}</button>`).join('')}</span></span>
      </div>
      <div class="readouts w-reads-sm w-meta">
        ${ro(bi('Model (as served)', '模型（API 回報）'), esc(st.served_model || run.served || doc.model), esc(doc.model))}
        ${ro(bi('Time (UTC)', '時間（UTC）'), esc(doc.utc.replace('T', ' ').replace('+00:00', '')), bi(`${st.seconds} s for this call`, `這次呼叫 ${st.seconds} 秒`))}
        ${ro(bi('Tokens, this call', 'token，這次呼叫'), u.total_tokens ?? '—', `${u.prompt_tokens ?? '—'} in + ${u.completion_tokens ?? '—'} out · ${bi(`chain ${chain}`, `整條 ${chain}`)}`)}
        ${ro(bi('Temperature', '溫度'), esc(doc.temperature), bi(st.image ? `image sent: ${esc(doc.image)}` : 'text only, no image', st.image ? `有送圖：${esc(doc.image)}` : '只有文字，沒有送圖'))}
      </div>
      ${hasTriples ? `<p class="w-callout">${isList
        ? bi(`This reply: <b>${marked.off}</b> of ${marked.n} triples use a relation outside the ten in Fig. 5 (marked). The list is in this prompt, policy (3).`, `這則回覆：${marked.n} 條 triple 裡有 <b>${marked.off}</b> 條用了圖 5 十詞以外的關係詞（已標出）。這份提示詞裡有清單，見 policy (3)。`)
        : bi(`This reply: ${marked.off} of ${marked.n} triples use a relation outside the ten (marked). The Relation Narrator prompt does not contain the list; it asks for location and direction words, so this is not a violation.`, `這則回覆：${marked.n} 條裡有 ${marked.off} 條用了十詞以外的關係詞（已標出）。Relation Narrator 的提示詞沒有那份清單，只要求位置與方向的詞，所以不算違規。`)}</p>` : ''}
      ${block('prompt', bi('Prompt, as sent', '送出的提示詞'), esc(st.prompt), st.prompt.length)}
      ${block('reply', bi('Reply, as received', '模型的回覆'), marked.html, st.reply.length)}
      <div class="w-scroll"><table class="w-table w-num"><caption>${bi(`Relations outside the Fig. 5 list, per model: ${sum.w} of ${sum.r} Triple Extractor replies in total`, `清單外關係詞，分模型：Triple Extractor 的 ${sum.r} 則回覆裡共 ${sum.w} 則`)}</caption>
        <thead><tr><th>${bi('Model', '模型')}</th><th>${bi('Triple Extractor replies with one or more', 'Triple Extractor 有越界的回覆')}</th><th>${bi('Off-list triples', '越界的 triple')}</th><th>${bi('Words used', '用了哪些詞')}</th><th>${bi('Relation Narrator (no list in prompt)', 'Relation Narrator（提示詞沒有清單）')}</th></tr></thead>
        <tbody>${statRows}</tbody></table></div>
      <p class="w-note">${bi('Counted here from data/vlm/summary.json. Scene 2 photo, 4 GPT-4o chains and 10 GPT-4o-mini chains; the GPT-4o count is small because of the account limit of 50 calls per day.', '這裡用 data/vlm/summary.json 當場算的。場景 2 照片，GPT-4o 4 條鏈、GPT-4o-mini 10 條鏈；GPT-4o 次數少是因為帳號每天 50 次的上限。')}</p>`;
  }

  /* ------------------------------------------------------------ views and events */
  function setView(v) {
    state.view = v === 'raw' ? 'raw' : 'footage';
    nav.querySelectorAll('button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.view === state.view)));
    el.querySelectorAll('[data-pane]').forEach(p => { p.hidden = p.dataset.pane !== state.view; });
    if (state.view === 'raw') { video?.pause(); renderRaw(); }
  }
  function gotoStep(n, play) {
    const s = steps[Math.max(1, Math.min(steps.length, n)) - 1];
    return setMedia('scene2', { seek: s.t0 + 0.05, play });
  }
  function jump(dir) {
    if (!video) return;
    const t = video.currentTime, pts = state.media === 'scene2' ? steps.map(s => s.t0) : markers.map(k => k.t);
    const target = dir > 0 ? pts.find(p => p > t + 0.2) : [...pts].reverse().find(p => p < t - 1);
    seekTo(target != null ? target + (state.media === 'scene2' ? 0.05 : 0) : dir > 0 ? duration() - 0.1 : 0);
  }
  function gotoMark(i) {
    const k = markers[i];
    if (!k) return;
    video?.pause();
    state.boxes = true; state.prompt = k.prompt;
    el.querySelector('[data-ctl="boxes"]').setAttribute('aria-pressed', 'true');
    seekTo(k.t);
    renderDetect();
  }

  nav.addEventListener('click', e => { const b = e.target.closest('button[data-view]'); if (b) setView(b.dataset.view); });
  el.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !el.contains(b)) return;
    if (b.dataset.media) setMedia(b.dataset.media);
    else if (b.dataset.step) { seekTo(steps[+b.dataset.step - 1].t0 + 0.05); }
    else if (b.dataset.mark) gotoMark(+b.dataset.mark);
    else if (b.dataset.prompt) { setPrompt(b.dataset.prompt); $('detect').querySelector(`[data-prompt="${CSS.escape(b.dataset.prompt)}"]`)?.focus(); }
    else if (b.dataset.stage) { state.stage = b.dataset.stage; renderRaw().then(() => $('raw').querySelector(`[data-stage="${state.stage}"]`)?.focus()); }
    else if (b.dataset.expand) { state.open[b.dataset.expand] = !state.open[b.dataset.expand]; b.setAttribute('aria-pressed', String(state.open[b.dataset.expand])); b.closest('.w-rawblock').querySelector('pre').dataset.open = String(state.open[b.dataset.expand]); }
    else if (b.dataset.ctl === 'play') toggle();
    else if (b.dataset.ctl === 'prev') jump(-1);
    else if (b.dataset.ctl === 'next') jump(1);
    else if (b.dataset.ctl === 'cc') { state.cc = !state.cc; b.setAttribute('aria-pressed', String(state.cc)); tick(true); }
    else if (b.dataset.ctl === 'boxes') { state.boxes = !state.boxes; b.setAttribute('aria-pressed', String(state.boxes)); drawFrameBoxes(); }
  });
  el.addEventListener('input', e => { if (e.target.matches('[data-ctl="seek"]')) seekTo(+e.target.value); });
  el.addEventListener('change', e => {
    if (e.target.matches('[data-ctl="rate"]') && video) video.playbackRate = +e.target.value;
    if (e.target.matches('[data-ctl="rawrun"]')) { state.raw = e.target.value; renderRaw().then(() => $('raw').querySelector('[data-ctl="rawrun"]')?.focus()); }
  });
  $('frame').addEventListener('keydown', e => {
    if (!video || e.target !== video) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); e.stopPropagation(); toggle(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); seekTo(video.currentTime + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); seekTo(video.currentTime - 1); }
  });

  async function act(action, args) {
    const [a, ...rest] = [action, ...(Array.isArray(args) ? args : args != null ? [args] : [])].join(':').split(':');
    const arg = rest.join(':');
    if (a === 'video') { setView('footage'); return setMedia(MEDIA[arg]?.kind === 'video' ? arg : 'scene2', { play: true }); }
    if (a === 'photo') { setView('footage'); return setMedia(MEDIA[arg]?.kind === 'photo' ? arg : 'B'); }
    if (a === 'seek') { setView('footage'); const t = parseFloat(arg); if (Number.isNaN(t)) return false; await setMedia(isVideo() ? state.media : M().video); seekTo(t); return true; }
    if (a === 'step') { setView('footage'); const n = parseInt(arg, 10); if (Number.isNaN(n)) return false; return gotoStep(n, video ? !video.paused : false); }
    if (a === 'detect') {
      // boxes and masks exist for the still photos, so this shows the photo of the scene that has the prompt
      setView('footage');
      const want = arg || 'all';
      const cur = isVideo() ? M().still : state.media;
      const has = async k => want === 'all' || !!(await load(MEDIA[k].json)).prompts[want];
      const key = (await has(cur)) ? cur : (await has('B')) ? 'B' : (await has('A')) ? 'A' : cur;
      state.prompt = want;
      await setMedia(key);
      setPrompt(want);
      return true;
    }
    if (a === 'raw') {
      const [id, stage] = [rest[0], rest[1]];
      if (id && summary.runs.some(r => runId(r) === id)) state.raw = id;
      if (stage && STAGES[stage]) state.stage = stage;
      setView('raw');
      return true;
    }
    if (a === 'boxes') { state.boxes = arg !== 'off'; renderChrome(); drawFrameBoxes(); return true; }
    if (a === 'toggle' || a === 'primary') { toggle(); return true; }
    if (a === 'play') { video?.play().catch(() => {}); return true; }
    if (a === 'pause') { video?.pause(); return true; }
    if (a === 'footage') { setView('footage'); return true; }
    return false;
  }

  setView('footage');
  await setMedia('scene2');
  return { act, onShow() { if (isVideo()) tick(true); }, onHide() { video?.pause(); }, state };
}
