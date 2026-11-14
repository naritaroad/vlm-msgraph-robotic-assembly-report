// labbench.js — a laboratory workbench for the cover scene, built in code.
//
//   const bench = buildLabBench(THREE, { theme: 'light' });   scene.add(bench);   bench.userData.setTheme('dark');
//
// Modelled on a steel-frame lab bench: four powder-coated box-section legs on levelling feet, aprons under a thick
// laminate worktop with a dark bevelled edge, a lower shelf, and at the back two uprights carrying a perforated
// panel, a power strip and an upper shelf with a light bar. Metres, y up. With the defaults the worktop surface is
// at y = 0.74 and the bench stays inside x ∈ [-0.30, 0.62], z ∈ [-0.30, 0.42]; the front is +z, the back panel -z.
// Nothing reaches past x = 0.62, so a robot column can stand right beside the +x edge.
//
// Surface detail (speckle, scratches, edge wear, orange peel, perforation, socket faces) is painted on canvases
// here; no image files are loaded. Every mesh casts and receives shadows.

import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

const PALETTE = {
  light: { top: 0xc9d3e0, edge: 0x232b38, frame: 0x2a364d, shelf: 0x33405a, panel: 0x9fb0c9, alu: 0xb9bfc8, strip: 0x2b2f37 },
  dark: { top: 0x5a6e94, edge: 0x1a2233, frame: 0xc2cbda, shelf: 0x97a4bb, panel: 0x3a4a6b, alu: 0xaeb6c2, strip: 0x1b1e25 },
};

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ canvases

function canvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return [c, c.getContext('2d')]; }

/** Worktop colour, neutral so that material.color can tint it: fine speckle, mottling, scratches, worn edges. */
function paintTop(seed) {
  const W = 1024, H = 800, [c, g] = canvas(W, H), rnd = mulberry(seed);
  g.fillStyle = '#e9e9e9'; g.fillRect(0, 0, W, H);
  for (let i = 0; i < 70; i++) {                       // soft mottling
    const x = rnd() * W, y = rnd() * H, r = 60 + rnd() * 160;
    const gr = g.createRadialGradient(x, y, 0, x, y, r), dark = rnd() < 0.5;
    gr.addColorStop(0, dark ? 'rgba(90,90,90,0.05)' : 'rgba(255,255,255,0.07)'); gr.addColorStop(1, 'rgba(128,128,128,0)');
    g.fillStyle = gr; g.fillRect(x - r, y - r, 2 * r, 2 * r);
  }
  for (let i = 0; i < 16000; i++) {                    // speckle
    const dark = rnd() < 0.55;
    g.globalAlpha = dark ? 0.08 + rnd() * 0.16 : 0.14 + rnd() * 0.22;
    g.fillStyle = dark ? '#7c7c7c' : '#ffffff';
    g.beginPath(); g.arc(rnd() * W, rnd() * H, 0.4 + rnd() * 0.9, 0, Math.PI * 2); g.fill();
  }
  g.lineCap = 'round';
  for (let i = 0; i < 46; i++) {                       // hairline scratches, mostly along the bench
    const x = rnd() * W, y = rnd() * H, a = (rnd() - 0.5) * (rnd() < 0.7 ? 0.5 : 3), l = 30 + rnd() * 190;
    g.globalAlpha = 0.05 + rnd() * 0.1; g.strokeStyle = rnd() < 0.6 ? '#ffffff' : '#6a6a6a'; g.lineWidth = 0.6 + rnd() * 0.7;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.globalAlpha = 1;
  const band = (x0, y0, x1, y1, rect, k) => {          // edges polished lighter by years of sleeves
    const gr = g.createLinearGradient(x0, y0, x1, y1);
    gr.addColorStop(0, `rgba(255,255,255,${k})`); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(...rect);
  };
  band(0, H, 0, H - 46, [0, H - 46, W, 46], 0.34);     // front edge (bottom of the canvas)
  band(0, 0, 26, 0, [0, 0, 26, H], 0.2); band(W, 0, W - 26, 0, [W - 26, 0, 26, H], 0.2);
  const back = g.createLinearGradient(0, 0, 0, 150);   // a little dust towards the back panel
  back.addColorStop(0, 'rgba(60,60,60,0.10)'); back.addColorStop(1, 'rgba(60,60,60,0)');
  g.fillStyle = back; g.fillRect(0, 0, W, 150);
  for (let i = 0; i < 260; i++) {                      // nicks along the front edge
    g.globalAlpha = 0.1 + rnd() * 0.2; g.fillStyle = '#ffffff';
    g.fillRect(rnd() * W, H - 1 - rnd() * rnd() * 22, 1 + rnd() * 5, 1 + rnd() * 1.6);
  }
  g.globalAlpha = 1;
  return c;
}

/** Worktop roughness (green channel): satin, with shinier scratches and wipe marks. */
function paintTopRoughness(seed) {
  const W = 512, H = 400, [c, g] = canvas(W, H), rnd = mulberry(seed);
  g.fillStyle = 'rgb(150,150,150)'; g.fillRect(0, 0, W, H);
  const id = g.getImageData(0, 0, W, H), d = id.data;
  for (let i = 0; i < d.length; i += 4) { const v = 150 + (rnd() - 0.5) * 46; d[i] = d[i + 1] = d[i + 2] = v; }
  g.putImageData(id, 0, 0);
  g.lineCap = 'round';
  for (let i = 0; i < 26; i++) {                       // wipe marks
    g.globalAlpha = 0.05 + rnd() * 0.05; g.strokeStyle = rnd() < 0.6 ? '#6e6e6e' : '#b8b8b8'; g.lineWidth = 10 + rnd() * 26;
    const x = rnd() * W, y = rnd() * H;
    g.beginPath(); g.moveTo(x, y); g.quadraticCurveTo(x + 80 + rnd() * 80, y + (rnd() - 0.5) * 90, x + 160 + rnd() * 120, y + (rnd() - 0.5) * 60); g.stroke();
  }
  for (let i = 0; i < 40; i++) {                       // scratches catch the light
    const x = rnd() * W, y = rnd() * H, a = (rnd() - 0.5) * 1.2, l = 16 + rnd() * 90;
    g.globalAlpha = 0.25 + rnd() * 0.3; g.strokeStyle = '#5a5a5a'; g.lineWidth = 0.6;
    g.beginPath(); g.moveTo(x, y); g.lineTo(x + Math.cos(a) * l, y + Math.sin(a) * l); g.stroke();
  }
  g.globalAlpha = 0.16; g.fillStyle = '#707070'; g.fillRect(0, H - 22, W, 22);      // the front edge is worn smoother
  g.globalAlpha = 1;
  return c;
}

/** Fine two-octave noise used as a bump map: the orange peel of powder coat. */
function paintOrangePeel(seed) {
  const S = 256, [c, g] = canvas(S, S), rnd = mulberry(seed);
  g.fillStyle = '#808080'; g.fillRect(0, 0, S, S);
  for (const [n, alpha] of [[48, 0.75], [128, 0.5]]) {
    const [t, tg] = canvas(n, n), id = tg.createImageData(n, n);
    for (let i = 0; i < id.data.length; i += 4) { const v = rnd() * 255; id.data[i] = id.data[i + 1] = id.data[i + 2] = v; id.data[i + 3] = 255; }
    tg.putImageData(id, 0, 0);
    g.globalAlpha = alpha; g.imageSmoothingEnabled = true; g.drawImage(t, 0, 0, S, S);
  }
  g.globalAlpha = 1;
  return c;
}

/** One cell of the perforated panel: white sheet, black round hole (used as an alpha map). */
function paintPerforation() {
  const S = 64, [c, g] = canvas(S, S);
  g.fillStyle = '#ffffff'; g.fillRect(0, 0, S, S);
  g.fillStyle = '#000000'; g.beginPath(); g.arc(S / 2, S / 2, S * 0.2, 0, Math.PI * 2); g.fill();
  return c;
}

/** Front of the power strip: four sockets in a row. Returns the canvas and the socket count. */
function paintStripFace() {
  const W = 1024, H = 112, [c, g] = canvas(W, H);
  g.fillStyle = '#d9dce1'; g.fillRect(0, 0, W, H);
  const rr = (x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
  for (let i = 0; i < 4; i++) {
    const cx = 250 + i * 190, cy = H / 2;
    g.fillStyle = '#23262c'; rr(cx - 62, cy - 42, 124, 84, 12); g.fill();
    g.fillStyle = '#34383f'; rr(cx - 56, cy - 36, 112, 72, 9); g.fill();
    g.fillStyle = '#07080a';
    g.fillRect(cx - 22, cy - 24, 7, 26); g.fillRect(cx + 15, cy - 24, 7, 26);       // two flat slots
    g.beginPath(); g.arc(cx, cy + 20, 7, 0, Math.PI * 2); g.fill();                  // earth pin
  }
  g.fillStyle = '#23262c'; rr(52, 22, 92, 68, 10); g.fill();                         // bezel of the rocker switch
  return c;
}

// ------------------------------------------------------------------ geometry helpers

/** UVs in metres from the dominant normal axis, so a tiling map keeps one scale on every tube. */
function planarUV(THREE, geo, tile) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); } else if (ax >= az) { u = p.getZ(i); v = p.getY(i); } else { u = p.getX(i); v = p.getY(i); }
    uv[i * 2] = u / tile; uv[i * 2 + 1] = v / tile;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

class Batch {
  constructor(THREE) { this.T = THREE; this.items = new Map(); }
  add(mat, geo, { at = [0, 0, 0], rot = null, tile = 0 } = {}) {
    const T = this.T;
    const g = geo.index ? geo.toNonIndexed() : geo;
    if (rot) g.applyMatrix4(new T.Matrix4().makeRotationFromEuler(new T.Euler(rot[0], rot[1], rot[2])));
    g.translate(at[0], at[1], at[2]);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (tile) planarUV(T, g, tile);
    else if (!g.attributes.uv) g.setAttribute('uv', new T.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (k !== 'position' && k !== 'normal' && k !== 'uv') g.deleteAttribute(k);
    g.clearGroups();
    if (!this.items.has(mat)) this.items.set(mat, []);
    this.items.get(mat).push(g);
    return this;
  }
  /** Rounded box centred at (x, y, z). */
  box(mat, w, h, d, x, y, z, { r = 0.004, seg = 2, rot = null, tile = 0 } = {}) {
    const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
    const g = rr > 3e-4 ? new RoundedBoxGeometry(w, h, d, seg, rr) : new this.T.BoxGeometry(w, h, d);
    return this.add(mat, g, { at: [x, y, z], rot, tile });
  }
  build(parent, name) {
    const T = this.T, out = [];
    for (const [mat, list] of this.items) {
      const m = new T.Mesh(mergeGeometries(list, false), mat);
      for (const g of list) g.dispose();
      m.name = name; m.castShadow = true; m.receiveShadow = true;
      parent.add(m); out.push(m);
    }
    this.items.clear();
    return out;
  }
}

// ------------------------------------------------------------------ the bench

/**
 * @param {typeof import('three')} THREE
 * @param {object} [opts]
 *   theme        'light' | 'dark' (default 'light')
 *   topY         height of the work surface (default 0.74)
 *   x, z         [min, max] extents of the worktop (defaults [-0.30, 0.62] and [-0.30, 0.42])
 *   back         false leaves out the uprights, perforated panel, power strip and upper shelf
 *   backHeight   height of the uprights above the worktop (default 0.50)
 *   lowerShelf   false leaves out the shelf between the legs
 *   seed         integer for the painted surface detail
 * @returns {THREE.Group} with userData.setTheme(theme), userData.dispose(), userData.bounds, userData.materials
 */
export function buildLabBench(THREE, opts = {}) {
  const { topY = 0.74, back = true, backHeight = 0.5, lowerShelf = true, seed = 7 } = opts;
  const [x0, x1] = opts.x ?? [-0.3, 0.62], [z0, z1] = opts.z ?? [-0.3, 0.42];
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2;
  const group = new THREE.Group();
  group.name = 'lab-bench';

  // ---- textures
  const tex = (c, { srgb = false, repeat = false } = {}) => {
    const t = new THREE.CanvasTexture(c);
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  };
  const topMap = tex(paintTop(seed * 131 + 5), { srgb: true }), topRough = tex(paintTopRoughness(seed * 17 + 3));
  for (const t of [topMap, topRough]) { t.repeat.set(1 / W, 1 / D); t.offset.set(0.5, 0.5); }      // extrusion UVs are the outline in metres
  const peel = tex(paintOrangePeel(seed + 99), { repeat: true });
  const holes = tex(paintPerforation(), { repeat: true });
  const stripMap = tex(paintStripFace(), { srgb: true });
  const textures = [topMap, topRough, peel, holes, stripMap];

  // ---- materials
  const P = (o) => new THREE.MeshPhysicalMaterial(o), S = (o) => new THREE.MeshStandardMaterial(o);
  const M = {
    top: P({ map: topMap, roughnessMap: topRough, bumpMap: topRough, bumpScale: 0.35, roughness: 1, metalness: 0, clearcoat: 0.22, clearcoatRoughness: 0.5 }),
    edge: S({ roughness: 0.5, metalness: 0.05 }),
    frame: P({ roughness: 0.5, metalness: 0.38, clearcoat: 0.3, clearcoatRoughness: 0.45, bumpMap: peel, bumpScale: 0.22 }),
    shelf: P({ roughness: 0.52, metalness: 0.38, clearcoat: 0.25, clearcoatRoughness: 0.5, bumpMap: peel, bumpScale: 0.22 }),
    panel: S({ roughness: 0.55, metalness: 0.3, alphaMap: holes, alphaTest: 0.5, side: THREE.DoubleSide }),
    steel: S({ color: 0xc6cad0, roughness: 0.28, metalness: 1 }),
    zinc: S({ color: 0x9aa0a8, roughness: 0.42, metalness: 1 }),
    alu: S({ roughness: 0.4, metalness: 0.9 }),
    rubber: S({ color: 0x121316, roughness: 0.92, metalness: 0 }),
    cap: S({ color: 0x1b1d22, roughness: 0.6, metalness: 0 }),
    strip: S({ roughness: 0.55, metalness: 0.15 }),
    stripFace: S({ map: stripMap, roughness: 0.6, metalness: 0 }),
    rocker: P({ color: 0xc81d25, roughness: 0.3, metalness: 0, clearcoat: 0.7, emissive: 0xff2a2a, emissiveIntensity: 0.55 }),
    cable: S({ color: 0x15171a, roughness: 0.6, metalness: 0 }),
    led: S({ color: 0xffffff, emissive: 0xfff0dc, emissiveIntensity: 2.4, roughness: 0.6 }),
  };

  const b = new Batch(THREE);
  const TILE = 0.035;                                  // one orange-peel tile per 3.5 cm

  // ---- worktop: rounded outline, bevelled edge; caps take the laminate, the edge takes the dark core
  const tTop = 0.034, bev = 0.0035, rc = 0.014;
  {
    const sh = new THREE.Shape();
    const hw = W / 2, hd = D / 2;
    sh.moveTo(-hw + rc, -hd); sh.lineTo(hw - rc, -hd); sh.absarc(hw - rc, -hd + rc, rc, -Math.PI / 2, 0, false);
    sh.lineTo(hw, hd - rc); sh.absarc(hw - rc, hd - rc, rc, 0, Math.PI / 2, false);
    sh.lineTo(-hw + rc, hd); sh.absarc(-hw + rc, hd - rc, rc, Math.PI / 2, Math.PI, false);
    sh.lineTo(-hw, -hd + rc); sh.absarc(-hw + rc, -hd + rc, rc, Math.PI, Math.PI * 1.5, false);
    const g = new THREE.ExtrudeGeometry(sh, { depth: tTop - 2 * bev, bevelEnabled: true, bevelThickness: bev, bevelSize: bev, bevelOffset: -bev, bevelSegments: 3, curveSegments: 8, steps: 1 });
    g.translate(0, 0, bev);
    g.rotateX(-Math.PI / 2);                           // thickness along +y, outline (x, y) -> (x, -z)
    g.translate(cx, topY - tTop, cz);
    const top = new THREE.Mesh(g, [M.top, M.edge]);
    top.name = 'worktop'; top.castShadow = true; top.receiveShadow = true;
    group.add(top);
  }
  const under = topY - tTop;                           // underside of the worktop

  // ---- frame: legs, aprons, stretchers
  const leg = 0.04, inX = 0.05, inBack = 0.05, inFront = 0.075;
  const lx = [x0 + inX, x1 - inX], lz = [z0 + inBack, z1 - inFront];
  const legBottom = 0.05, legH = under - legBottom;
  for (const x of lx) for (const z of lz) {
    b.box(M.frame, leg, legH, leg, x, legBottom + legH / 2, z, { r: 0.005, tile: TILE });
    b.box(M.cap, leg - 0.002, 0.006, leg - 0.002, x, legBottom - 0.002, z, { r: 0.002 });
  }
  const apH = 0.05, apT = 0.022, apY = under - apH / 2 - 0.0005;
  const spanX = lx[1] - lx[0] - leg, spanZ = lz[1] - lz[0] - leg;
  for (const z of lz) b.box(M.frame, spanX + 0.004, apH, apT, cx, apY, z, { r: 0.004, tile: TILE });
  for (const x of lx) b.box(M.frame, apT, apH, spanZ + 0.004, x, apY, (lz[0] + lz[1]) / 2, { r: 0.004, tile: TILE });
  b.box(M.frame, apT, 0.03, spanZ + 0.004, cx, under - 0.016, (lz[0] + lz[1]) / 2, { r: 0.003, tile: TILE });      // centre bearer under the top
  const stY = 0.17;
  for (const x of lx) b.box(M.frame, 0.025, 0.04, spanZ + 0.004, x, stY, (lz[0] + lz[1]) / 2, { r: 0.004, tile: TILE });
  b.box(M.frame, spanX + 0.004, 0.04, 0.025, cx, stY, lz[0], { r: 0.004, tile: TILE });

  // gusset plates and their bolts where aprons meet legs
  const gusset = (x, z, sx) => {
    const s = 0.062, sh = new THREE.Shape();
    sh.moveTo(0, 0); sh.lineTo(s, 0); sh.lineTo(s, -0.012); sh.lineTo(0.012, -s); sh.lineTo(0, -s); sh.closePath();
    const raw = new THREE.ExtrudeGeometry(sh, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelOffset: -0.0008, bevelSegments: 1, steps: 1 });
    raw.translate(0, 0, -0.002);
    const g = raw.index ? raw.toNonIndexed() : raw;
    if (sx < 0) { g.scale(-1, 1, 1); flipWinding(g); }           // mirrored plate: restore the outward winding
    b.add(M.frame, g, { at: [x, under - 0.002, z], tile: TILE });
  };
  function flipWinding(g) {
    const p = g.attributes.position.array, n = g.attributes.normal?.array, u = g.attributes.uv?.array;
    const sw = (a, i, j, k) => { for (let c = 0; c < k; c++) { const t = a[i + c]; a[i + c] = a[j + c]; a[j + c] = t; } };
    for (let i = 0; i < p.length; i += 9) { sw(p, i + 3, i + 6, 3); if (n) sw(n, i + 3, i + 6, 3); }
    if (u) for (let i = 0; i < u.length; i += 6) sw(u, i + 2, i + 4, 2);
  }
  const bolt = (x, y, z, rot) => {
    b.add(M.zinc, new THREE.CylinderGeometry(0.0052, 0.006, 0.003, 14), { at: [x, y, z], rot });
    b.add(M.cap, new THREE.CylinderGeometry(0.0024, 0.0024, 0.0032, 6), { at: [x, y, z], rot });
  };
  for (const z of lz) {
    const face = z === lz[1] ? 1 : -1, zf = z + face * (apT / 2 + 0.002);
    gusset(lx[0] + leg / 2, zf, 1); gusset(lx[1] - leg / 2, zf, -1);
    for (const [x, s] of [[lx[0] + leg / 2, 1], [lx[1] - leg / 2, -1]]) {
      bolt(x + s * 0.018, under - 0.02, zf + face * 0.003, [face * Math.PI / 2, 0, 0]);
      bolt(x + s * 0.046, under - 0.011, zf + face * 0.003, [face * Math.PI / 2, 0, 0]);
    }
  }
  for (const x of lx) {
    const face = x === lx[1] ? 1 : -1, xf = x + face * (leg / 2 + 0.0015);
    for (const z of lz) for (const y of [apY + 0.012, apY - 0.012, stY]) bolt(xf, y, z, [0, 0, -face * Math.PI / 2]);
  }

  // levelling feet: rubber pad, steel dish, threaded stem, lock nut
  const dish = new THREE.LatheGeometry([[0, 0.004], [0.024, 0.004], [0.0262, 0.0055], [0.0262, 0.009], [0.014, 0.0165], [0.0085, 0.0185], [0, 0.0185]].map(([r, y]) => new THREE.Vector2(r, y)), 28);
  for (const x of lx) for (const z of lz) {
    b.add(M.rubber, new THREE.CylinderGeometry(0.0252, 0.0258, 0.0044, 28), { at: [x, 0.0022, z] });
    b.add(M.steel, dish.clone(), { at: [x, 0, z] });
    b.add(M.zinc, new THREE.CylinderGeometry(0.0058, 0.0058, 0.036, 14), { at: [x, 0.034, z] });
    b.add(M.zinc, new THREE.CylinderGeometry(0.0105, 0.0105, 0.007, 6), { at: [x, 0.0425, z] });
  }
  dish.dispose();

  // ---- lower shelf: a folded steel tray on the stretchers
  if (lowerShelf) {
    const sw = spanX - 0.01, sd = Math.min(0.44, spanZ), sz = lz[0] + sd / 2, sy = stY + 0.029;
    b.box(M.shelf, sw, 0.012, sd, cx, sy, sz, { r: 0.003, tile: TILE });
    b.box(M.shelf, sw, 0.03, 0.006, cx, sy - 0.011, sz + sd / 2 - 0.003, { r: 0.002, tile: TILE });      // front lip, folded down
    b.box(M.shelf, sw, 0.03, 0.006, cx, sy + 0.012, sz - sd / 2 + 0.003, { r: 0.002, tile: TILE });      // back lip, folded up
  }

  // ---- back: uprights, perforated panel, power strip, upper shelf with a light bar
  if (back) {
    const ux = [x0 + 0.045, x1 - 0.045], uz = z0 + 0.026, uw = 0.04, ud = 0.028;
    for (const x of ux) {
      b.box(M.frame, uw, backHeight, ud, x, topY + backHeight / 2 + 0.005, uz, { r: 0.004, tile: TILE });
      b.box(M.frame, 0.076, 0.006, 0.05, x, topY + 0.003, uz + 0.006, { r: 0.002, tile: TILE });           // foot plate on the worktop
      b.box(M.cap, uw - 0.002, 0.005, ud - 0.002, x, topY + backHeight + 0.006, uz, { r: 0.002 });
      for (const s of [-1, 1]) bolt(x + s * 0.029, topY + 0.0072, uz + 0.018, null);
    }
    const pw = ux[1] - ux[0] - uw, py0 = topY + 0.06, py1 = topY + backHeight - 0.1;
    for (const y of [py0, py1]) b.box(M.frame, pw + 0.004, 0.026, 0.02, cx, y, uz, { r: 0.003, tile: TILE });
    {
      const h = py1 - py0 - 0.026, pitch = 0.0254;
      const g = new THREE.PlaneGeometry(pw, h);
      const cols = Math.round(pw / pitch), rows = Math.round(h / pitch);
      const uv = g.attributes.uv;
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * cols, uv.getY(i) * rows);
      const m = new THREE.Mesh(g, M.panel);
      m.position.set(cx, (py0 + py1) / 2, uz);
      m.name = 'perforated-panel'; m.castShadow = true; m.receiveShadow = true;
      group.add(m);
    }
    // two hooks on the panel
    const hook = (x, y) => {
      const pts = [[0, 0, 0], [0, 0, 0.012], [0, -0.004, 0.05], [0, 0.004, 0.062], [0, 0.016, 0.064]].map((p) => new THREE.Vector3(...p));
      b.add(M.steel, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 20, 0.0022, 8, false), { at: [x, y, uz + 0.001] });
      b.box(M.steel, 0.012, 0.03, 0.002, x, y - 0.006, uz + 0.002, { r: 0.0008 });
    };
    hook(ux[0] + 0.12, py1 - 0.07); hook(ux[0] + 0.19, py1 - 0.07);

    // power strip on the lower part of the panel
    const sl = 0.44, shh = 0.048, sdp = 0.034, sx = cx + 0.06, sy = py0 + 0.075, szc = uz + 0.012 + sdp / 2;
    b.box(M.alu, sl, shh, sdp, sx, sy, szc, { r: 0.004 });
    for (const s of [-1, 1]) b.box(M.strip, 0.012, shh + 0.002, sdp + 0.002, sx + s * (sl / 2 + 0.004), sy, szc, { r: 0.004 });
    {
      const face = new THREE.Mesh(new THREE.PlaneGeometry(sl - 0.012, shh - 0.008), M.stripFace);
      face.position.set(sx, sy, szc + sdp / 2 + 0.0004);
      face.name = 'power-strip-face'; face.receiveShadow = true;
      group.add(face);
      const rocker = new THREE.Mesh(new RoundedBoxGeometry(0.03, 0.02, 0.008, 2, 0.003), M.rocker);
      rocker.position.set(sx - (sl - 0.012) / 2 + (98 / 1024) * (sl - 0.012), sy, szc + sdp / 2 + 0.002);
      rocker.rotation.x = -0.14;
      rocker.name = 'power-strip-switch'; rocker.castShadow = true;
      group.add(rocker);
    }
    {
      // mains lead: out of the right end of the strip, down the upright, into a grommet in the worktop
      const xe = sx + sl / 2 + 0.01, xu = ux[1] - 0.034;
      const pts = [[xe, sy, szc], [xe + 0.03, sy - 0.004, szc + 0.004], [xu - 0.012, sy - 0.03, uz + 0.03], [xu, topY + 0.07, uz + 0.03], [xu + 0.002, topY + 0.02, uz + 0.034], [xu, topY - 0.004, uz + 0.036]]
        .map((p) => new THREE.Vector3(...p));
      b.add(M.cable, new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts, false, 'centripetal'), 40, 0.0035, 8, false));
      b.add(M.cap, new THREE.TorusGeometry(0.0085, 0.003, 8, 20), { at: [xu, topY + 0.0012, uz + 0.036], rot: [Math.PI / 2, 0, 0] });
    }

    // upper shelf on two brackets, light bar underneath
    const shY = topY + backHeight - 0.06, shD = 0.2, shW = ux[1] - ux[0] + uw, shZ = z0 + 0.012 + shD / 2;
    b.box(M.shelf, shW, 0.014, shD, cx, shY, shZ, { r: 0.003, tile: TILE });
    b.box(M.shelf, shW, 0.026, 0.006, cx, shY + 0.008, shZ + shD / 2 - 0.003, { r: 0.002, tile: TILE });
    for (const x of ux) {
      const sh = new THREE.Shape();
      sh.moveTo(0, 0); sh.lineTo(shD - 0.05, 0); sh.lineTo(shD - 0.05, -0.012); sh.lineTo(0.014, -0.11); sh.lineTo(0, -0.11); sh.closePath();
      const g = new THREE.ExtrudeGeometry(sh, { depth: 0.004, bevelEnabled: true, bevelThickness: 0.0008, bevelSize: 0.0008, bevelOffset: -0.0008, bevelSegments: 1, steps: 1 });
      g.translate(0, 0, -0.002);
      g.rotateY(-Math.PI / 2);                         // outline x -> +z, thickness along x
      b.add(M.frame, g, { at: [x, shY - 0.007, uz + ud / 2], tile: TILE });
    }
    const barZ = shZ + shD / 2 - 0.04, barW = shW - 0.16;
    b.box(M.alu, barW, 0.012, 0.024, cx, shY - 0.013, barZ, { r: 0.003 });
    const led = new THREE.Mesh(new RoundedBoxGeometry(barW - 0.012, 0.003, 0.014, 1, 0.001), M.led);
    led.position.set(cx, shY - 0.0195, barZ);
    led.name = 'light-bar';
    group.add(led);
  }

  b.build(group, 'bench');

  // ---- theme
  const setTheme = (theme) => {
    const c = PALETTE[theme === 'dark' ? 'dark' : 'light'];
    M.top.color.setHex(c.top); M.edge.color.setHex(c.edge);
    M.frame.color.setHex(c.frame); M.shelf.color.setHex(c.shelf);
    M.panel.color.setHex(c.panel); M.alu.color.setHex(c.alu); M.strip.color.setHex(c.strip);
    M.led.emissiveIntensity = theme === 'dark' ? 3.2 : 2.0;
    group.userData.theme = theme === 'dark' ? 'dark' : 'light';
  };
  setTheme(opts.theme ?? 'light');

  group.userData.setTheme = setTheme;
  group.userData.materials = M;
  group.userData.bounds = { x: [x0, x1], z: [z0, z1], topY, height: back ? topY + backHeight + 0.01 : topY };
  group.userData.dispose = () => {
    group.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
    for (const m of Object.values(M)) m.dispose();
    for (const t of textures) t.dispose();
  };
  return group;
}
