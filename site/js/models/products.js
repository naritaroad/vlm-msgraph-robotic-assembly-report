// products.js — part definitions for the six interactive models of the report.
//
//   product1 … product5   Fig. 4, bottom strip "Physics simulation" (p.5): five exploded assemblies of coloured parts
//   ballscrew             Fig. 6, bottom middle (p.6): the ball-screw linear module with its ten ground-truth triples
//
// Everything is rebuilt from what the pictures show: outline, colour, proportions and the labels (Part0 …, or the
// names printed in Fig. 6). The paper gives no dimensions, so every number here is an estimate read off the picture
// and kept consistent inside one model (tag: Demo). Where the figure shows only the exploded state, the assembled
// layout is our own reading of it. Internals that the figure does not show are not modelled.
// The ball-screw module also carries the outside detail that a linear module of this kind has and that the figure
// is too coarse to show (fixing screws and counterbores, bearing rings, seals, grease nipples, the motor connector):
// that detail is ours, not the paper's.
//
// Geometry is authored in millimetres (y up) and scaled to metres at the end, like js/lab/parts.js.
// A model is { id, title, source, view, parts[] }; a part is
//   { key, label, name:{en,zh}, color, group?, triples?, build(THREE, lib) -> Object3D,
//     assembled:{position,quaternion}, exploded:{position,quaternion} }      (metres, model frame, ground at y = 0)
// `lib.material(kind, color, overrides)` comes from the caller (viewer.js); `group` ties together parts that share
// one label in the figure (two guides, four slide blocks) so that they highlight as one.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { creaseNormals, gridSurface, latheClosed, mergeSoups, involuteOutline, gearRadii, buildNutGeometry } from '../lab/parts.js';

const MM = 0.001;
const DEG = Math.PI / 180;

// ------------------------------------------------------------------ geometry helpers (millimetres, position-only soups)

function soup(g) {
  const n = g.index ? g.toNonIndexed() : g;
  for (const k of Object.keys(n.attributes)) if (k !== 'position') n.deleteAttribute(k);
  return n;
}
const move = (g, x = 0, y = 0, z = 0) => { g.translate(x, y, z); return g; };
/** Turn a solid whose axis is +y so that the axis points along +x or +z. */
const alongX = (g) => g.rotateZ(-Math.PI / 2);
const alongZ = (g) => g.rotateX(Math.PI / 2);

const V2 = (x, y) => new THREE.Vector2(x, y);
function circle(r, cx = 0, cy = 0, n = 40, start = 0) {
  const a = [];
  for (let i = 0; i < n; i++) { const t = start + (i / n) * Math.PI * 2; a.push(V2(cx + r * Math.cos(t), cy + r * Math.sin(t))); }
  return a;
}
const hole = (r, cx = 0, cy = 0, n = 28) => new THREE.Path(circle(r, cx, cy, n).reverse());
/** Shape from a counter-clockwise polygon with every corner rounded to radius r (or less on short edges). */
function roundPoly(pts, r = 1, n = 4) {
  if (!(r > 0)) return new THREE.Shape(pts.map(([x, y]) => V2(x, y)));
  const out = [], N = pts.length;
  for (let i = 0; i < N; i++) {
    const p = pts[i], a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const d = Math.min(r, da * 0.45, db * 0.45);
    const A = [p[0] + ((a[0] - p[0]) / da) * d, p[1] + ((a[1] - p[1]) / da) * d];
    const B = [p[0] + ((b[0] - p[0]) / db) * d, p[1] + ((b[1] - p[1]) / db) * d];
    for (let k = 0; k <= n; k++) {
      const t = k / n, w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      out.push(V2(w0 * A[0] + w1 * p[0] + w2 * B[0], w0 * A[1] + w1 * p[1] + w2 * B[1]));
    }
  }
  return new THREE.Shape(out);
}
const rrect = (w, h, r, cx = 0, cy = 0) => roundPoly([[cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2], [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2]], r);
/** Points on an arc, angles in radians, inclusive. */
function arc(cx, cy, r, a0, a1, n = 16) {
  const a = [];
  for (let i = 0; i <= n; i++) { const t = a0 + ((a1 - a0) * i) / n; a.push([cx + r * Math.cos(t), cy + r * Math.sin(t)]); }
  return a;
}
function convexHull(points) {
  const p = points.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], q) <= 0) lo.pop(); lo.push(q); }
  for (let i = p.length - 1; i >= 0; i--) { const q = p[i]; while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], q) <= 0) up.pop(); up.push(q); }
  return lo.slice(0, -1).concat(up.slice(0, -1));
}

// Extrusions. The shape lives in a (u, v) plane; the nominal outline is kept and the bevel is cut into it.
function extrudeRaw(shape, depth, bevel, { bevelSegments = 2, curveSegments = 16 } = {}) {
  const b = Math.max(0, Math.min(bevel, depth / 2 - 0.01));
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: depth - 2 * b, bevelEnabled: b > 0, bevelThickness: b, bevelSize: b, bevelOffset: -b, bevelSegments, curveSegments, steps: 1,
  });
  g.translate(0, 0, b);
  return soup(g);
}
/** (u, v) -> (x, y), extruded along +z from z0 to z1. */
const extZ = (shape, z0, z1, bevel = 0.6, o) => move(extrudeRaw(shape, z1 - z0, bevel, o), 0, 0, z0);
/** (u, v) -> (x, -z), extruded along +y from y0 to y1. */
const extY = (shape, y0, y1, bevel = 0.6, o) => { const g = move(extrudeRaw(shape, y1 - y0, bevel, o), 0, 0, y0); g.rotateX(-Math.PI / 2); return g; };
/** (u, v) -> (-z, y), extruded along +x from x0 to x1. */
const extX = (shape, x0, x1, bevel = 0.6, o) => { const g = move(extrudeRaw(shape, x1 - x0, bevel, o), 0, 0, x0); g.rotateY(Math.PI / 2); return g; };

function box(w, h, d, r = 1, x = 0, y = 0, z = 0, seg = 3) {
  const rr = Math.min(r, w / 2 - 0.01, h / 2 - 0.01, d / 2 - 0.01);
  return move(soup(new RoundedBoxGeometry(w, h, d, seg, rr)), x, y, z);
}

/** Closed (r, y) profile of a ring between rIn and rOut, chamfered by c. */
function tube(rOut, rIn, y0, y1, c = 0.5) {
  if (!(c > 0)) return [[rIn, y0], [rIn, y1], [rOut, y1], [rOut, y0]];
  return [[rIn + c, y0], [rIn, y0 + c], [rIn, y1 - c], [rIn + c, y1], [rOut - c, y1], [rOut, y1 - c], [rOut, y0 + c], [rOut - c, y0]];
}
/** Closed (r, y) profile of a solid stepped shaft. secs = [[r, y0, y1], …] from bottom to top, touching. */
function stepped(secs, c = 0.5) {
  const p = [[0, secs[0][1]]];
  secs.forEach(([r, y0, y1], i) => {
    const prev = i ? secs[i - 1][0] : 0, next = i < secs.length - 1 ? secs[i + 1][0] : 0;
    const cb = prev < r ? Math.min(c, (r - prev) * 0.8) : 0, ct = next < r ? Math.min(c, (r - next) * 0.8) : 0;
    if (cb) p.push([r - cb, y0], [r, y0 + cb]); else p.push([r, y0]);
    if (ct) p.push([r, y1 - ct], [r - ct, y1]); else p.push([r, y1]);
  });
  p.push([0, secs[secs.length - 1][2]]);
  return p;
}
const lathe = (profile, seg = 48) => latheClosed(profile, seg);

/**
 * UVs for brushed metal: u runs along `axis` (plus a little radius so that end faces keep a usable tangent),
 * v is the angle about it. three derives the anisotropy tangent from these.
 */
function axisUV(g, axis = 'y') {
  const p = g.attributes.position.array, n = p.length / 3, uv = new Float32Array(n * 2);
  const [ia, ib, ic] = axis === 'x' ? [0, 1, 2] : axis === 'z' ? [2, 0, 1] : [1, 2, 0];
  const ang = [0, 0, 0];
  for (let t = 0; t < n; t += 3) {
    let ref = null;
    for (let k = 0; k < 3; k++) {
      const o = (t + k) * 3, b = p[o + ib], c = p[o + ic], r = Math.hypot(b, c);
      uv[(t + k) * 2] = (p[o + ia] + 0.35 * r) * 0.05;
      ang[k] = r > 1e-6 ? Math.atan2(c, b) : null;
      if (ref === null && ang[k] !== null) ref = ang[k];
    }
    for (let k = 0; k < 3; k++) {
      let a = ang[k] === null ? ref ?? 0 : ang[k];
      if (ref !== null) { while (a - ref > Math.PI) a -= 2 * Math.PI; while (ref - a > Math.PI) a += 2 * Math.PI; }
      uv[(t + k) * 2 + 1] = a / (2 * Math.PI);
    }
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/** Soups (mm) -> one indexed geometry in metres with crease normals. uv: 'x' | 'y' | 'z' adds brushed-metal UVs about that axis. */
function finish(list, { crease = 35, uv = null } = {}) {
  const src = Array.isArray(list) ? mergeSoups(list) : soup(list);
  let g = creaseNormals(src, crease * DEG, 1e-3);
  if (uv) axisUV(g, uv);
  g = mergeVertices(g, 1e-4);                          // index it: smooth regions share vertices, a third of the memory
  g.scale(MM, MM, MM);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function mesh(geo, mat) {
  const m = new THREE.Mesh(geo, mat);
  m.castShadow = true; m.receiveShadow = true;
  return m;
}

/** Involute spur gear, axis +y, bottom face at y = 0: toothed rim, recessed web, hub with an optional boss on top. */
function gearSoups({ teeth, m = 2, face, bore, hubR = 8, boss = 0, recess = 3, rimW = 4.5, phase = 0 }) {
  const PA = 20 * DEG, R = gearRadii(teeth, m, PA);
  const outline = involuteOutline(teeth, m, PA, { phase, backlash: 0.1 }).map(([x, y]) => V2(x, y));
  const rimIn = R.root - rimW;
  const rim = new THREE.Shape(outline);
  rim.holes.push(hole(rimIn, 0, 0, 64));
  return [
    extY(rim, 0, face, 0.5),
    lathe(tube(rimIn + 0.6, hubR - 0.6, recess, face - recess, 0), 64),
    lathe(tube(hubR, bore, 0, face + boss, 0.6), 48),
  ];
}

/**
 * Real thread geometry: a helical ridge (form 'v') or a helical groove (form 'ball') about +y, in metres, with
 * smooth normals. The ends run out over `fade` pitches: a V thread sinks to the minor radius, a ball-screw groove
 * rises to the major radius, so the plain journals next to it join without a step.
 */
function threadGeo({ y0, length, pitch, rMinor, rMajor, form = 'v', seg = 24, perPitch = 8, fade = 1.5 }) {
  const rows = Math.max(2, Math.round((length / pitch) * perPitch)) + 1, cols = seg + 1;
  const pos = new Float32Array(rows * cols * 3), idx = [];
  const sstep = (x) => { const t = Math.max(0, Math.min(1, x)); return t * t * (3 - 2 * t); };
  const prof = form === 'ball'
    ? (u) => { const s = Math.abs(u - 0.5) / 0.27; return s < 1 ? 1 - Math.sqrt(1 - s * s) : 1; }       // 1 on the land, 0 at the groove bottom
    : (u) => Math.min(1, Math.abs(2 * u - 1) * 1.12);                                                   // 1 on the crest, 0 at the root
  for (let i = 0; i < rows; i++) {
    const t = i / (rows - 1), y = y0 + length * t;
    const f = sstep(Math.min(t * length, (1 - t) * length) / (pitch * fade));
    for (let j = 0; j < cols; j++) {
      const a = (j / seg) * Math.PI * 2;
      let u = (length * t) / pitch - j / seg; u -= Math.floor(u);
      const h = prof(u);
      const r = form === 'ball' ? rMajor - (rMajor - rMinor) * (1 - h) * f : rMinor + (rMajor - rMinor) * h * f;
      const o = (i * cols + j) * 3;
      pos[o] = r * Math.cos(a) * MM; pos[o + 1] = y * MM; pos[o + 2] = -r * Math.sin(a) * MM;
    }
  }
  for (let i = 0; i < rows - 1; i++) for (let j = 0; j < seg; j++) {
    const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
    idx.push(a, b, c, b, d, c);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  const nrm = g.attributes.normal;
  for (let i = 0; i < rows; i++) {                      // the seam column is doubled: give both copies the same normal
    const a = i * cols, b = a + seg;
    const x = nrm.getX(a) + nrm.getX(b), y = nrm.getY(a) + nrm.getY(b), z = nrm.getZ(a) + nrm.getZ(b), l = Math.hypot(x, y, z) || 1;
    nrm.setXYZ(a, x / l, y / l, z / l); nrm.setXYZ(b, x / l, y / l, z / l);
  }
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

// ------------------------------------------------------------------ part records

const Q0 = [0, 0, 0, 1];
const P = (v) => [v[0] * MM, v[1] * MM, v[2] * MM];

/** at: assembled position of the part origin (mm). ex: offset of the exploded position from it (mm). */
function part(key, label, en, zh, color, at, ex, build, more = {}) {
  return {
    key, label, name: { en, zh }, color, build,
    assembled: { position: P(at), quaternion: Q0 },
    exploded: { position: P([at[0] + ex[0], at[1] + ex[1], at[2] + ex[2]]), quaternion: Q0 },
    ...more,
  };
}

// Colours sampled from the figures.
const C = { red: '#ea5453', blue: '#1f9fe4', yellow: '#f7bf18', pink: '#de84e4', green: '#84e25c' };
const plastic = (color, make, opts) => (T, lib) => mesh(finish(make(), opts), lib.material('plastic', color));

// ------------------------------------------------------------------ Product1: gearbox

function product1() {
  const floor = 5, H = 34, wall = 5, lip = 3;
  const inner = { L: 214, W: 130, r: 22 };
  // gear centres on the housing floor (x, z). All four gears sit on the floor in one layer: the red gear and the
  // two smaller ones each mesh with the blue wheel, at centre distances equal to the sum of the pitch radii
  // (module 2). The figure shows the set only exploded, so this seating is our reading of it.
  const Z = { red: 38, pink: 20, blue: 42, yellow: 24 };
  const F = { red: 16, pink: 20, blue: 16, yellow: 16 };
  const polar = (c, d, deg) => [c[0] + d * Math.cos(deg * DEG), c[1] + d * Math.sin(deg * DEG)];
  const at = { blue: [10, -14] };
  at.red = polar(at.blue, Z.red + Z.blue, 154.16);
  at.yellow = polar(at.blue, Z.blue + Z.yellow, -12);
  at.pink = polar(at.blue, Z.blue + Z.pink, 55);
  const y0 = floor;
  const dir = (a, b) => Math.atan2(-(b[1] - a[1]), b[0] - a[0]);          // angle in the gear's own outline plane
  /** Phase of gear B (zB teeth) so that it meshes with gear A (phase pA, zA teeth); phi = direction from A to B. */
  const mate = (pA, zA, zB, phi) => {
    const pitch = (2 * Math.PI) / zA;
    let d = (pA - phi) % pitch; if (d > pitch / 2) d -= pitch; if (d < -pitch / 2) d += pitch;      // where A's nearest tooth sits
    return phi + Math.PI + Math.PI / zB - d * (zA / zB);
  };
  const pBlue = 0;
  const phase = { blue: pBlue };
  for (const k of ['red', 'yellow', 'pink']) phase[k] = mate(pBlue, Z.blue, Z[k], dir(at.blue, at[k]));
  const gear = (color, o) => plastic(color, () => gearSoups({ bore: 3, hubR: 8, recess: 3.2, ...o }), { crease: 38 });
  const bush = (color) => plastic(color, () => lathe(tube(7, 3, 0, 8, 0.7), 32), { crease: 30 });

  const housing = () => {
    // rounded-rectangle tray: floor fillet inside, lip around the top, mounting ears on the outside
    const outline = [];
    const cx = inner.L / 2 - inner.r, cz = inner.W / 2 - inner.r;
    for (const [sx, sy, a0] of [[1, 1, 0], [-1, 1, 90], [-1, -1, 180], [1, -1, 270]]) {
      for (let i = 0; i <= 10; i++) {
        const t = (a0 + i * 9) * DEG;
        outline.push({ p: [sx * cx + inner.r * Math.cos(t), sy * cz + inner.r * Math.sin(t)], n: [Math.cos(t), Math.sin(t)] });
      }
    }
    const prof = [];
    const Rf = 3;
    for (let i = 0; i <= 5; i++) { const a = (-90 + i * 18) * DEG; prof.push([-Rf + Rf * Math.cos(a), floor + Rf + Rf * Math.sin(a)]); }
    prof.push([0, H - 1.2], [1.2, H], [wall + lip - 1, H], [wall + lip, H - 1], [wall + lip, H - 5], [wall, H - 7.5], [wall, 1], [wall - 1, 0]);
    const pt = (s, o, h) => [s.p[0] + s.n[0] * o, h, -(s.p[1] + s.n[1] * o)];
    const list = [gridSurface(outline.map((s) => prof.map(([o, h]) => pt(s, o, h))), { closeU: true, closeV: false, flip: true })];
    const cap = (o, h, up) => {
      const tri = [];
      for (let i = 0; i < outline.length; i++) {
        const a = pt(outline[i], o, h), b = pt(outline[(i + 1) % outline.length], o, h);
        if (up) tri.push(0, h, 0, ...a, ...b); else tri.push(0, h, 0, ...b, ...a);
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
      return g;
    };
    list.push(cap(prof[0][0], floor, true), cap(wall - 1, 0, false));
    const ear = () => {
      const w = 6.5, reach = 10;
      const pts = [[-1.5, -w], ...arc(reach - w, 0, w, -Math.PI / 2, Math.PI / 2, 10), [-1.5, w]];
      const sh = new THREE.Shape(pts.map(([x, y]) => V2(x, y)));
      sh.holes.push(hole(2.3, reach - w, 0, 18));
      return extY(sh, 11, 20, 0.7);
    };
    const place = (px, py, t) => { const g = ear(); g.rotateY(t); g.translate(px, 0, -py); list.push(g); };
    const ox = inner.L / 2 + wall, oz = inner.W / 2 + wall;
    for (const x of [-66, 0, 66]) { place(x, oz, Math.PI / 2); place(x, -oz, -Math.PI / 2); }
    place(ox, 0, 0); place(-ox, 0, Math.PI);
    return list;
  };

  return {
    id: 'product1',
    title: { en: 'Product1 · gearbox', zh: 'Product1：齒輪箱' },
    source: { en: 'Fig. 4, bottom, Product1 (p.5)', zh: '圖 4 下半，Product1（第 5 頁）' },
    view: { dir: [0.42, 0.62, 0.9] },
    parts: [
      part('part4', 'Part4', 'Housing', '殼體', C.green, [0, 0, 0], [0, 0, 0], plastic(C.green, housing, { crease: 40 })),
      part('part0', 'Part0', 'Large gear (red)', '大齒輪（紅）', C.red, [at.red[0], y0, at.red[1]], [-30, 50, 0],
        gear(C.red, { teeth: Z.red, face: F.red, phase: phase.red })),
      part('part3', 'Part3', 'Pinion (pink)', '小齒輪（粉紅）', C.pink, [at.pink[0], y0, at.pink[1]], [-14, 40, 46],
        gear(C.pink, { teeth: Z.pink, face: F.pink, phase: phase.pink, rimW: 3.5, hubR: 7, recess: 2.6 })),
      part('part2', 'Part2', 'Large gear (blue)', '大齒輪（藍）', C.blue, [at.blue[0], y0, at.blue[1]], [0, 96, 0],
        gear(C.blue, { teeth: Z.blue, face: F.blue, phase: phase.blue })),
      part('part1', 'Part1', 'Medium gear (yellow)', '中齒輪（黃）', C.yellow, [at.yellow[0], y0, at.yellow[1]], [40, 88, -34],
        gear(C.yellow, { teeth: Z.yellow, face: F.yellow, phase: phase.yellow })),
      part('part5', 'Part5', 'Bushing (red)', '襯套（紅）', C.red, [at.red[0], y0 + F.red, at.red[1]], [-30, 90, 0], bush(C.red)),
      part('part6', 'No label', 'Bushing (yellow); drawn in the figure with a leader line but no label, Part6 by the gap in the numbers', '襯套（黃）；圖上有畫、有引線但沒有標號，依編號空缺推測是 Part6', C.yellow, [at.blue[0], y0 + F.blue, at.blue[1]], [0, 136, 0], bush(C.yellow)),
      part('part7', 'Part7', 'Bushing (blue)', '襯套（藍）', C.blue, [at.yellow[0], y0 + F.yellow, at.yellow[1]], [40, 128, -34], bush(C.blue)),
    ],
  };
}

// ------------------------------------------------------------------ Product2: two blocks, two rods, one screw

function product2() {
  const holes = (sh, y) => { sh.holes.push(hole(6, -20, y), hole(6, 20, y), hole(5, 0, y, 24)); return sh; };
  const yAxis = 10;                                                     // height of the three bores above the ground
  return {
    id: 'product2',
    title: { en: 'Product2 · blocks, rods and a screw', zh: 'Product2：方塊、圓桿與螺絲' },
    source: { en: 'Fig. 4, bottom, Product2 (p.5)', zh: '圖 4 下半，Product2（第 5 頁）' },
    view: { dir: [0.62, 0.52, 0.86] },
    parts: [
      part('part0', 'Part0', 'Drilled block (red)', '鑽孔方塊（紅）', C.red, [-31, 0, 0], [-34, 0, 0],
        plastic(C.red, () => extX(holes(rrect(64, 20, 1.6, 0, 10), yAxis), -14, 14, 0.9))),
      part('part1', 'Part1', 'Stepped block (yellow)', '階梯方塊（黃）', C.yellow, [6, 0, 0], [10, 0, 0],
        plastic(C.yellow, () => [
          extX(holes(rrect(70, 34, 1.6, 0, 17), yAxis), -23, 23, 0.9),
          box(19, 13.5, 70, 0.9, -29.5, 27.25, 0),                       // the overhang that reaches over the red block
        ])),
      part('part2', 'Part2', 'Knurled rod (blue)', '壓花圓桿（藍）', C.blue, [-50, yAxis, -20], [116, 0, 0], (T, lib) => {
        const mat = lib.material('plastic', C.blue);
        const g = new THREE.Group();
        const ends = finish([alongX(lathe(stepped([[5.7, 0, 12.6]], 0.9), 32)), alongX(lathe(stepped([[5.7, 117.4, 130]], 0.9), 32))], { crease: 30 });
        const knurl = threadGeo({ y0: 12, length: 106, pitch: 2.2, rMinor: 5.3, rMajor: 5.72, seg: 24, perPitch: 6 });
        alongX(knurl);
        g.add(mesh(ends, mat), mesh(knurl, mat));
        return g;
      }),
      part('part3', 'Part3', 'Cap screw (pink)', '圓柱頭螺絲（粉紅）', C.pink, [29, yAxis, 20], [122, 0, 0], (T, lib) => {
        const mat = lib.material('plastic', C.pink);
        const g = new THREE.Group();
        const solid = finish([
          alongX(lathe(stepped([[4.1, -1, 0.2], [8.5, 0.2, 16]], 1.1), 36)),                 // head
          alongX(lathe([[0, -80], [3.3, -80], [4.1, -79], [4.1, -76.4], [0, -76.4]], 28)),    // chamfered tip
        ], { crease: 30 });
        const thread = threadGeo({ y0: -77, length: 76.6, pitch: 2.4, rMinor: 4.1, rMajor: 5, seg: 24, perPitch: 8 });
        alongX(thread);
        g.add(mesh(solid, mat), mesh(thread, mat));
        return g;
      }),
      part('part4', 'Part4', 'Plain rod (green)', '圓桿（綠）', C.green, [-71, yAxis, 0], [-98, 0, 0],
        plastic(C.green, () => {
          const r = 4.7, e = 2.2, prof = [[0, 0]];
          for (let i = 0; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); prof.push([r - e + e * Math.sin(a), e - e * Math.cos(a)]); }
          for (let i = 0; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); prof.push([r - e + e * Math.cos(a), 64 - e + e * Math.sin(a)]); }
          prof.push([0, 64]);
          return alongX(lathe(prof, 32));
        }, { crease: 40 })),
    ],
  };
}

// ------------------------------------------------------------------ Product3: wheel, rim, axle, wedge and keys

function product3() {
  const A = 60;                                                         // axis height = outer radius of the rim
  const bored = (side, r, x0, x1) => { const sh = rrect(side, side, r); sh.holes.push(hole(3.3, 0, 0, 24)); return extX(sh, x0, x1, 0.9); };
  const key = (pts, r = 1.1) => () => extZ(roundPoly(pts, r, 3), -3.5, 3.5, 0.7);
  return {
    id: 'product3',
    title: { en: 'Product3 · wheel on an axle', zh: 'Product3：輪圈與輪軸' },
    source: { en: 'Fig. 4, bottom, Product3 (p.5)', zh: '圖 4 下半，Product3（第 5 頁）' },
    view: { dir: [0.38, 0.36, 1] },
    parts: [
      part('part0', 'Part0', 'Wedge (red)', '楔塊（紅）', C.red, [-30, 0, 0], [-58, 0, 0],
        plastic(C.red, () => extX(roundPoly([[-40, 0], [40, 0], [18, 112], [2, 112]], 7, 6), -13, 13, 1.4))),
      part('part3', 'Part3', 'Rim (pink)', '輪圈（粉紅）', C.pink, [0, A, 0], [-24, 0, 0],
        plastic(C.pink, () => alongX(lathe(tube(60, 51, -15, 15, 1.6), 88)), { crease: 30 })),
      part('part2', 'Part2', 'Spoked disc (blue)', '輻板輪（藍）', C.blue, [12, A, 0], [18, 0, 0],
        plastic(C.blue, () => {
          const sh = new THREE.Shape(circle(50.6, 0, 0, 96));
          sh.holes.push(hole(3.2, 0, 0, 24));
          for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; sh.holes.push(hole(11.5, 29 * Math.cos(a), 29 * Math.sin(a), 36)); }
          return [extX(sh, -3, 3, 0.8), alongX(lathe(tube(9, 3.2, -4.5, 4.5, 0.6), 36))];
        })),
      part('part5', 'Part5', 'Axle (red)', '輪軸（紅）', C.red, [3, A, 0], [52, 0, 0],
        plastic(C.red, () => alongX(lathe(stepped([[3, 0, 12], [4.2, 12, 18], [3.1, 18, 69]], 0.5), 28)), { crease: 30 })),
      part('part1', 'Part1', 'Bearing block (yellow)', '軸承座方塊（黃）', C.yellow, [24, A, 0], [104, 0, 0],
        plastic(C.yellow, () => [bored(34, 1.6, 0, 24.6), bored(37.5, 1.6, 24, 37)])),
      part('part4', 'Part4', 'Spacer (green)', '間隔環（綠）', C.green, [62, A, 0], [134, 0, 0],
        plastic(C.green, () => alongX(lathe(tube(4.6, 3.3, 0, 9, 0.5), 28)), { crease: 30 })),
      part('part6', 'Part6', 'Gib-head key (yellow)', '勾頭鍵（黃）', C.yellow, [73, A + 6.5, 0], [160, 15, 0],
        plastic(C.yellow, key([[0, -3], [50, -3], [50, 8], [44, 8], [44, 3], [0, 3]]))),
      part('part7', 'Part7', 'Gib-head key (blue)', '勾頭鍵（藍）', C.blue, [73, A, 0], [172, 0, 0],
        plastic(C.blue, key([[0, -3], [48, -3], [48, -9], [54, -9], [54, 3], [0, 3]]))),
      part('part8', 'Part8', 'Flat key (pink)', '平鍵（粉紅）', C.pink, [73, A - 6.5, 0], [150, -15, 0],
        plastic(C.pink, key([[0, -3], [40, -3], [40, -1.6], [45, -1.6], [45, 1.6], [40, 1.6], [40, 3], [0, 3]], 0.7))),
    ],
  };
}

// ------------------------------------------------------------------ Product4: geared shaft in a flanged housing

function product4() {
  const A = 42;                                                         // axis height = radius of the housing flange
  const housing = () => {
    const flange = new THREE.Shape(circle(42, 0, 0, 96));
    flange.holes.push(hole(8.5, 0, 0, 36));
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2 + Math.PI / 6; flange.holes.push(hole(3, 35 * Math.cos(a), 35 * Math.sin(a), 20)); }
    const a0 = Math.asin(19 / 29);                                      // the flat milled on top of the first half of the body
    const dcut = new THREE.Shape(arc(0, 0, 29, Math.PI - a0, 2 * Math.PI + a0, 64).map(([x, y]) => V2(x, y)));
    dcut.holes.push(hole(8.5, 0, 0, 36));
    const round = new THREE.Shape(circle(29, 0, 0, 80));
    round.holes.push(hole(8.5, 0, 0, 36));
    return [
      extX(flange, 0, 8, 1),
      extX(dcut, 7.6, 42, 0.8),
      extX(round, 41.6, 70, 0.8),
      alongX(lathe(tube(17, 10, 69.6, 86, 1), 56)),
    ];
  };
  const bearing = () => {
    const pts = [...circle(13, 0, 0, 40), ...circle(6.5, 0, 20, 20), ...circle(6.5, 0, -20, 20)].map((v) => [v.x, v.y]);
    const sh = roundPoly(convexHull(pts), 0);
    sh.holes.push(hole(7.2, 0, 0, 32), hole(2.6, 0, 20, 16), hole(2.6, 0, -20, 16));
    return [extX(sh, 0, 5, 0.7), alongX(lathe(tube(11, 7.2, 4.6, 15, 0.7), 40))];
  };
  const pulley = () => {
    const rb = 6.15, c = 0.6;
    return alongX(lathe([
      [rb + c, 0], [rb, c], [rb, 24 - c], [rb + c, 24], [11 - c, 24], [11, 24 - c], [11, 14], [39.3, 14], [40, 13.3], [40, 11],
      [31, 9], [31, 5], [40, 3], [40, 0.7], [39.3, 0],
    ], 96));
  };
  const pin = (color, r, h) => plastic(color, () => lathe(stepped([[r, 0, h]], 0.4), 20), { crease: 30 });
  return {
    id: 'product4',
    title: { en: 'Product4 · geared shaft and housing', zh: 'Product4：齒輪軸與殼體' },
    source: { en: 'Fig. 4, bottom, Product4 (p.5)', zh: '圖 4 下半，Product4（第 5 頁）' },
    view: { dir: [0.5, 0.5, 0.95] },
    parts: [
      part('part0', 'Part0', 'Flanged housing (red)', '法蘭殼體（紅）', C.red, [0, A, 0], [0, 0, 0], plastic(C.red, housing, { crease: 32 })),
      part('part1', 'Part1', 'Stepped shaft (yellow)', '階梯軸（黃）', C.yellow, [-36, A, 0], [6, 62, -34],
        plastic(C.yellow, () => alongX(lathe(stepped([[4, 0, 14], [5, 14, 34], [7, 34, 140], [6, 140, 169], [4, 169, 186]], 0.6), 36)), { crease: 30 })),
      part('part6', 'Part6', 'Spur gear (yellow)', '正齒輪（黃）', C.yellow, [-8, A, 0], [-40, 0, 0],
        plastic(C.yellow, () => gearSoups({ teeth: 36, face: 12, bore: 5.1, hubR: 12, boss: 5, recess: 2.5, rimW: 5.5 }).map((g) => g.rotateZ(Math.PI / 2)), { crease: 38 })),
      part('part7', 'Part7', 'Hex nut (blue)', '六角螺帽（藍）', C.blue, [-33, A, 0], [-66, 14, 0], (T, lib) => {
        const g = buildNutGeometry({ acrossFlats: 0.015, height: 0.008, bore: 0.0082, chamfer: 0.0012 });
        alongX(g);
        return mesh(g, lib.material('plastic', C.blue));
      }),
      part('part2', 'Part2', 'Flange bearing (blue)', '法蘭軸承座（藍）', C.blue, [87, A, 0], [26, 0, 0], plastic(C.blue, bearing, { crease: 32 })),
      part('part5', 'Part5', 'Pin (red)', '銷（紅）', C.red, [97, A + 10, 0], [26, 24, 0], pin(C.red, 1.6, 9)),
      part('part3', 'Part3', 'Pulley (pink)', '皮帶輪（粉紅）', C.pink, [108, A, 0], [56, 0, 0], plastic(C.pink, pulley, { crease: 30 })),
      part('part4', 'Part4', 'Set screw (green)', '固定螺絲（綠）', C.green, [127, A + 10, 0], [56, 26, 0], pin(C.green, 2, 7.5)),
      part('part8', 'No label', 'Bushing (pink); drawn in the figure with a leader line but no label, Part8 by the gap in the numbers', '襯套（粉紅）；圖上有畫、有引線但沒有標號，依編號空缺推測是 Part8', C.pink, [134, A, 0], [88, 0, 0],
        plastic(C.pink, () => alongX(lathe(tube(7, 4.15, 0, 12, 0.6), 32)), { crease: 30 })),
    ],
  };
}

// ------------------------------------------------------------------ Product5: bars, a bridge, a C-clamp and a ring

function product5() {
  const arch = () => roundPoly([[15, 0], [25, 0], [25, 30], [-25, 30], [-25, 0], [-15, 0], ...arc(0, 8, 15, Math.PI, 0, 18)], 0);
  const rack = () => {
    const n = 18, p = 60 / n, pts = [[-30, 0], [30, 0], [30, 7.4]];
    for (let k = 0; k < n; k++) { const x = 30 - k * p; pts.push([x - 0.55, 7.4], [x - 1.15, 10], [x - p + 1.15, 10], [x - p + 0.55, 7.4]); }
    pts.push([-30, 7.4]);
    return extZ(new THREE.Shape(pts.map(([x, y]) => V2(x, y))), -5.8, 5.8, 0.4, { bevelSegments: 1 });
  };
  return {
    id: 'product5',
    title: { en: 'Product5 · rails, bridge and clamp', zh: 'Product5：導軌、跨座與夾塊' },
    source: { en: 'Fig. 4, bottom, Product5 (p.5)', zh: '圖 4 下半，Product5（第 5 頁）' },
    view: { dir: [0.3, 0.72, 0.9] },
    parts: [
      part('part4', 'Part4', 'Grooved rail (green)', '帶槽導軌（綠）', C.green, [-15, 0, 0], [-52, 0, -40],
        plastic(C.green, () => [
          extX(roundPoly([[-11, 0], [11, 0], [11, 12], [6.2, 12], [6.2, 8], [-6.2, 8], [-6.2, 12], [-11, 12]], 0.9, 3), -55, 55, 0.8),
          box(8, 4.6, 13, 0.5, -51, 9.7, 0),                             // the closed end of the groove
        ])),
      part('part6', 'Part6', 'Rack (yellow)', '齒條（黃）', C.yellow, [-20, 8, 0], [-62, 30, -72], plastic(C.yellow, rack, { crease: 30 })),
      part('part5', 'Part5', 'Notched bar (red)', '缺口長桿（紅）', C.red, [-50, 0, 39], [-26, 0, 34],
        plastic(C.red, () => {
          const sh = roundPoly([[-60, -13], [60, -13], [60, 13], [49, 13], ...arc(40, 13, 9, 0, -Math.PI, 14).slice(1, -1), [31, 13], [-60, 13]], 0);
          sh.holes.push(hole(1.7, 52, -6, 16));
          return extY(sh, 0, 14, 1);
        })),
      part('part2', 'Part2', 'Bridge (blue)', '跨座（藍）', C.blue, [21, 0, 0], [0, 0, 0],
        plastic(C.blue, () => [extX(arch(), -23, -11, 0.9), extX(arch(), 11, 23, 0.9), box(24, 8, 14, 0.9, 0, 26, 18), box(24, 8, 14, 0.9, 0, 26, -18)])),
      part('part8', 'Part8', 'Ring (pink)', '圓環（粉紅）', C.pink, [21, 36.9, 0], [0, 34, 0],
        plastic(C.pink, () => alongZ(lathe(tube(13, 6.5, -6, 6, 1), 48)), { crease: 30 })),
      part('part0', 'Part0', 'Headed pin (red)', '帶頭銷（紅）', C.red, [38, 24, 0], [0, 26, 0],
        plastic(C.red, () => lathe(stepped([[2, 0, 17], [3.2, 17, 20]], 0.4), 24), { crease: 30 })),
      part('part3', 'Part3', 'Cube (pink)', '方塊（粉紅）', C.pink, [21, 0, 36.5], [8, 0, 30], plastic(C.pink, () => box(22, 22, 22, 1.6, 0, 11, 0))),
      part('part7', 'Part7', 'C-clamp (blue)', 'C 形夾塊（藍）', C.blue, [59, 0, 0], [44, 0, 0],
        plastic(C.blue, () => {
          const sh = roundPoly([[-14, -30], ...arc(0, 0, 30, -Math.PI / 2, Math.PI / 2, 28), [-14, 30], [-14, 17], ...arc(0, 0, 17, Math.PI / 2, -Math.PI / 2, 24), [-14, -17]], 0);
          return [extY(sh, 0, 22, 1.2), box(12, 16, 7, 0.8, -8, 8, 13.6)];
        })),
      part('part1', 'Part1', 'Dowel pin (yellow)', '定位銷（黃）', C.yellow, [2, 4, 45], [-26, 26, 34],
        plastic(C.yellow, () => lathe(stepped([[1.3, 0, 14]], 0.3), 16), { crease: 30 })),
    ],
  };
}

// ------------------------------------------------------------------ Fig. 6: ball-screw linear module

/** The right-hand "Ground Truth Triplets" box of Fig. 6, in the order printed. The first line is printed twice. */
export const BALLSCREW_TRIPLES = [
  '(Linear rolling guides, goes through, Slide blocks)',
  '(Linear rolling guides, goes through, Slide blocks)',
  '(Nut bracket, attached to, Slide blocks)',
  '(Screw-nut joints, screwed, Nut bracket)',
  '(Screw shaft, attached to, Screw-nut joints)',
  '(Upper-end bearing joints, attached to, Screw shaft)',
  '(Servo motor, attached to, Upper-end bearing joints)',
  '(Screw shaft, goes through, Lower-end bearing joints)',
  '(Spindle system, attached to, Slide blocks)',
  '(Spindle unit, goes through, Spindle system)',
];

// ---- machining helpers for the ball-screw module (millimetres, position-only soups)

function soupOf(arr) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arr), 3));
  return g;
}
/** Drop the zero-area triangles that a lathe leaves on its axis. */
function dropSlivers(g) {
  const p = g.attributes.position.array, out = [];
  for (let t = 0; t < p.length; t += 9) {
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2], vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    if (nx * nx + ny * ny + nz * nz > 1e-10) for (let k = 0; k < 9; k++) out.push(p[t + k]);
  }
  return soupOf(out);
}
/** Split a soup by a test on each triangle: pred(centroid [x, y, z], unit normal [x, y, z]) -> [yes, no]. */
function splitSoup(g, pred) {
  const p = g.attributes.position.array, yes = [], no = [];
  for (let t = 0; t < p.length; t += 9) {
    const ux = p[t + 3] - p[t], uy = p[t + 4] - p[t + 1], uz = p[t + 5] - p[t + 2], vx = p[t + 6] - p[t], vy = p[t + 7] - p[t + 1], vz = p[t + 8] - p[t + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx, l = Math.hypot(nx, ny, nz) || 1;
    const c = [(p[t] + p[t + 3] + p[t + 6]) / 3, (p[t + 1] + p[t + 4] + p[t + 7]) / 3, (p[t + 2] + p[t + 5] + p[t + 8]) / 3];
    const dst = pred(c, [nx / l, ny / l, nz / l]) ? yes : no;
    for (let k = 0; k < 9; k++) dst.push(p[t + k]);
  }
  return [soupOf(yes), soupOf(no)];
}

/** Counter-clockwise polygon [[x, y], …] with every corner rounded; always n + 1 points per corner. */
function roundPts(pts, r = 1, n = 4) {
  const out = [], N = pts.length;
  for (let i = 0; i < N; i++) {
    const p = pts[i], a = pts[(i - 1 + N) % N], b = pts[(i + 1) % N];
    const da = Math.hypot(a[0] - p[0], a[1] - p[1]), db = Math.hypot(b[0] - p[0], b[1] - p[1]);
    const d = Math.min(r, da * 0.45, db * 0.45);
    const A = [p[0] + ((a[0] - p[0]) / da) * d, p[1] + ((a[1] - p[1]) / da) * d];
    const B = [p[0] + ((b[0] - p[0]) / db) * d, p[1] + ((b[1] - p[1]) / db) * d];
    for (let k = 0; k <= n; k++) {
      const t = k / n, w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      out.push([w0 * A[0] + w1 * p[0] + w2 * B[0], w0 * A[1] + w1 * p[1] + w2 * B[1]]);
    }
  }
  return out;
}
const ringPts = (cx, cy, r, n, rot = 0) => Array.from({ length: n }, (_, i) => { const t = rot + (i / n) * Math.PI * 2; return [cx + r * Math.cos(t), cy + r * Math.sin(t)]; });
const polar = (n, r, a0 = 0, cx = 0, cy = 0) => ringPts(cx, cy, r, n, a0);
const shapeOf = (pts) => new THREE.Shape(pts.map(([x, y]) => V2(x, y)));

// Holes for drill(): a stack of loops going into the material, [depth, radius] per station.
/** Round (or n-sided) hole. floor: false leaves the last loop open, for a hole that meets one drilled from the other side. */
const bore = (cx, cy, prof, { n = 20, floor = true, rot = 0 } = {}) => ({ loops: prof.map(([d, r]) => ({ d, pts: ringPts(cx, cy, r, n, rot) })), floor });
/** Counterbore: chamfered mouth, flat seat at `depth`, then the clearance hole for `more`. */
const cbore = (cx, cy, rcb, depth, r, more = 5, o) => bore(cx, cy, [[0, rcb + 0.4], [0.4, rcb], [depth, rcb], [depth, r], [depth + more, r]], o);
/** Tapped hole with a countersunk mouth. */
const tapped = (cx, cy, r, depth = 8, o) => bore(cx, cy, [[0, r + 0.45], [0.45, r], [depth, r]], { n: 16, ...o });
/** Rounded-rectangle pocket; prof = [[depth, inset], …]. */
const pocket = (cx, cy, w, h, rad, prof) => ({
  loops: prof.map(([d, i]) => ({ d, pts: roundPts([[cx - w / 2 + i, cy - h / 2 + i], [cx + w / 2 - i, cy - h / 2 + i], [cx + w / 2 - i, cy + h / 2 - i], [cx - w / 2 + i, cy + h / 2 - i]], Math.max(0.3, rad - i), 4) })),
  floor: true,
});

/**
 * Cut holes into one flat, axis-aligned face of a soup. axis 'x' | 'y' | 'z' and sign ±1 give the outward normal of
 * the face, `at` its coordinate. Hole positions are given in the two other coordinates: x → (y, z), y → (x, z),
 * z → (x, y). The face is cut out and triangulated again around the mouth of every hole, the walls join the loops,
 * and the last loop is closed by a floor. Floors go to `floors` (an array of soups) when given, so that the bottom
 * of a hole can take another material; otherwise they stay in the result.
 */
function drill(g, axis, sign, at, holes, floors = null) {
  const p = g.attributes.position.array;
  const ia = 'xyz'.indexOf(axis), iu = (ia + 1) % 3, iv = (ia + 2) % 3, swap = axis === 'y';
  const key = (u, v) => `${Math.round(u * 500)},${Math.round(v * 500)}`;
  const out = [], edges = new Map();
  let found = 0;
  for (let t = 0; t < p.length; t += 9) {
    let hit = Math.abs(p[t + ia] - at) < 2e-3 && Math.abs(p[t + 3 + ia] - at) < 2e-3 && Math.abs(p[t + 6 + ia] - at) < 2e-3;
    if (hit) {
      const A = (p[t + 3 + iu] - p[t + iu]) * (p[t + 6 + iv] - p[t + iv]) - (p[t + 6 + iu] - p[t + iu]) * (p[t + 3 + iv] - p[t + iv]);
      hit = A * sign > 1e-9;
    }
    if (!hit) { for (let k = 0; k < 9; k++) out.push(p[t + k]); continue; }
    found++;
    for (let k = 0; k < 3; k++) {
      const a = t + k * 3, b = t + ((k + 1) % 3) * 3;
      const ka = key(p[a + iu], p[a + iv]), kb = key(p[b + iu], p[b + iv]);
      if (ka === kb) continue;
      if (edges.has(`${kb}|${ka}`)) edges.delete(`${kb}|${ka}`); else edges.set(`${ka}|${kb}`, { a: ka, b: kb, u: p[a + iu], v: p[a + iv], used: false });
    }
  }
  if (!found) throw new Error(`drill: no face at ${axis} = ${at}`);

  // boundary loops of the face
  const from = new Map();
  for (const e of edges.values()) { const l = from.get(e.a); if (l) l.push(e); else from.set(e.a, [e]); }
  const loops = [];
  for (const start of edges.values()) {
    if (start.used) continue;
    const loop = [];
    for (let e = start; e && !e.used; e = (from.get(e.b) ?? []).find((x) => !x.used)) { e.used = true; loop.push([e.u, e.v]); }
    if (loop.length >= 3) loops.push(loop);
  }
  const area = (L) => { let s = 0; for (let i = 0; i < L.length; i++) { const a = L[i], b = L[(i + 1) % L.length]; s += a[0] * b[1] - b[0] * a[1]; } return s / 2; };
  const inside = (q, L) => {
    let c = false;
    for (let i = 0, j = L.length - 1; i < L.length; j = i++) {
      const a = L[i], b = L[j];
      if ((a[1] > q[1]) !== (b[1] > q[1]) && q[0] < ((b[0] - a[0]) * (q[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
    }
    return c;
  };
  const centre = (L) => { let x = 0, y = 0; for (const q of L) { x += q[0]; y += q[1]; } return [x / L.length, y / L.length]; };
  const outers = loops.filter((L) => area(L) * sign > 0).map((L) => ({ L, holes: [] }));
  for (const L of loops) if (area(L) * sign <= 0) outers.find((o) => inside(L[0], o.L))?.holes.push(L);

  const cut = holes.map((h) => h.loops.map((l) => ({ d: l.d, pts: l.pts.map(([a, b]) => (swap ? [b, a] : [a, b])) })));
  for (const Ls of cut) {
    const o = outers.find((x) => inside(centre(Ls[0].pts), x.L));
    if (!o) throw new Error(`drill: a hole lies outside the face at ${axis} = ${at}`);
    o.holes.push(Ls[0].pts);
  }

  const P3 = (q, d) => { const w = [0, 0, 0]; w[ia] = at - sign * d; w[iu] = q[0]; w[iv] = q[1]; return w; };
  const flat = (arr, contour, hs, d) => {            // triangulate a polygon with holes at depth d, facing out of the face
    const c = contour.map(([u, v]) => V2(u, v)), h = hs.map((x) => x.map(([u, v]) => V2(u, v)));
    const all = c.concat(...h);
    for (const [i, j, k] of THREE.ShapeUtils.triangulateShape(c, h)) {
      const A = all[i], B = all[j], C2 = all[k];
      const s = (B.x - A.x) * (C2.y - A.y) - (C2.x - A.x) * (B.y - A.y);
      if (s * sign > 0) arr.push(...P3([A.x, A.y], d), ...P3([B.x, B.y], d), ...P3([C2.x, C2.y], d));
      else arr.push(...P3([A.x, A.y], d), ...P3([C2.x, C2.y], d), ...P3([B.x, B.y], d));
    }
  };
  for (const o of outers) flat(out, o.L, o.holes, 0);

  const fl = [];
  cut.forEach((Ls, hi) => {
    const c0 = centre(Ls[0].pts);
    for (let i = 0; i + 1 < Ls.length; i++) {
      const A = Ls[i], B = Ls[i + 1], n = A.pts.length;
      for (let j = 0; j < n; j++) {
        const j1 = (j + 1) % n;
        const a = P3(A.pts[j], A.d), b = P3(A.pts[j1], A.d), c = P3(B.pts[j1], B.d), e = P3(B.pts[j], B.d);
        // the wall faces the cavity: towards the axis of the hole and out of the face
        const d1 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]], d2 = [e[0] - b[0], e[1] - b[1], e[2] - b[2]];
        const N = [d1[1] * d2[2] - d1[2] * d2[1], d1[2] * d2[0] - d1[0] * d2[2], d1[0] * d2[1] - d1[1] * d2[0]];
        const mu = (a[iu] + b[iu] + c[iu] + e[iu]) / 4 - c0[0], mv = (a[iv] + b[iv] + c[iv] + e[iv]) / 4 - c0[1], ml = Math.hypot(mu, mv) || 1;
        const D = [0, 0, 0]; D[iu] = -mu / ml; D[iv] = -mv / ml; D[ia] = sign;
        if (N[0] * D[0] + N[1] * D[1] + N[2] * D[2] > 0) out.push(...a, ...b, ...c, ...a, ...c, ...e);
        else out.push(...a, ...c, ...b, ...a, ...e, ...c);
      }
    }
    if (holes[hi].floor !== false) { const last = Ls[Ls.length - 1]; flat(floors ? fl : out, last.pts, [], last.d); }
  });
  if (floors && fl.length) floors.push(soupOf(fl));
  return soupOf(out);
}

/**
 * UVs for brushed flat stock: u runs along `axis` and v across it, both linear in position, so the anisotropy
 * tangent that three derives from them is the axis itself on every face parallel to it (axisUV is for turned parts:
 * its angle coordinate bends across a large flat triangle).
 */
function grainUV(g, axis = 'y') {
  const p = g.attributes.position.array, n = p.length / 3, uv = new Float32Array(n * 2);
  const [ia, ib, ic] = axis === 'x' ? [0, 1, 2] : axis === 'z' ? [2, 0, 1] : [1, 2, 0];
  for (let i = 0; i < n; i++) {
    const a = p[i * 3 + ia], b = p[i * 3 + ib], c = p[i * 3 + ic];
    uv[i * 2] = (a + 0.3 * b + 0.2 * c) * 0.02;
    uv[i * 2 + 1] = (0.4 * b + 0.9 * c) * 0.02;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}

/**
 * creaseNormals() and mergeVertices() in one pass, for the big soups of this model: positions are welded with integer
 * keys instead of strings, normals are averaged over the faces within `angle` (area weighted, as in creaseNormals),
 * and corners at one point share a vertex when their normal and UV agree. `addUV(g)` may add UVs before indexing.
 */
function creaseWeld(g, angle, addUV = null) {
  const pos = g.attributes.position.array, n = pos.length / 3, faces = n / 3;
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.length; i++) { const k = i % 3; if (pos[i] < lo[k]) lo[k] = pos[i]; if (pos[i] > hi[k]) hi[k] = pos[i]; }
  let q = 2e-3, rx = 1, ry = 1;
  for (;; q *= 2) {
    rx = Math.ceil((hi[0] - lo[0]) / q) + 2; ry = Math.ceil((hi[1] - lo[1]) / q) + 2;
    if (rx * ry * (Math.ceil((hi[2] - lo[2]) / q) + 2) < 2 ** 52) break;
  }
  const inv = 1 / q, ids = new Map(), pid = new Int32Array(n);
  for (let v = 0; v < n; v++) {
    const key = Math.round((pos[v * 3] - lo[0]) * inv) + rx * (Math.round((pos[v * 3 + 1] - lo[1]) * inv) + ry * Math.round((pos[v * 3 + 2] - lo[2]) * inv));
    let id = ids.get(key);
    if (id === undefined) { id = ids.size; ids.set(key, id); }
    pid[v] = id;
  }
  const P = ids.size, fn = new Float64Array(faces * 3), fl = new Float64Array(faces);
  for (let f = 0; f < faces; f++) {
    const i = f * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    fn[f * 3] = x; fn[f * 3 + 1] = y; fn[f * 3 + 2] = z; fl[f] = Math.hypot(x, y, z);
  }
  const start = new Int32Array(P + 1);                 // faces around each welded point
  for (let v = 0; v < n; v++) start[pid[v] + 1]++;
  for (let i = 0; i < P; i++) start[i + 1] += start[i];
  const fill = start.slice(0, P), around = new Int32Array(n);
  for (let v = 0; v < n; v++) around[fill[pid[v]]++] = (v / 3) | 0;
  const cosA = Math.cos(angle), nrm = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const f = (v / 3) | 0, ax = fn[f * 3], ay = fn[f * 3 + 1], az = fn[f * 3 + 2], al = fl[f] || 1, id = pid[v];
    let sx = 0, sy = 0, sz = 0;
    for (let k = start[id]; k < start[id + 1]; k++) {
      const g2 = around[k], bl = fl[g2];
      if (bl === 0) continue;
      const bx = fn[g2 * 3], by = fn[g2 * 3 + 1], bz = fn[g2 * 3 + 2];
      if (g2 === f || (ax * bx + ay * by + az * bz) / (al * bl) >= cosA) { sx += bx; sy += by; sz += bz; }
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    nrm[v * 3] = sx / l; nrm[v * 3 + 1] = sy / l; nrm[v * 3 + 2] = sz / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
  if (addUV) addUV(g);
  const uv = g.attributes.uv ? g.attributes.uv.array : null;
  const head = new Int32Array(P).fill(-1), next = [], oPos = [], oNrm = [], oUv = [], index = new Uint32Array(n), E = 1e-4;
  for (let v = 0; v < n; v++) {
    const id = pid[v], a = v * 3, b = v * 2;
    let o = head[id];
    for (; o !== -1; o = next[o]) {
      if (Math.abs(oNrm[o * 3] - nrm[a]) < E && Math.abs(oNrm[o * 3 + 1] - nrm[a + 1]) < E && Math.abs(oNrm[o * 3 + 2] - nrm[a + 2]) < E
        && (!uv || (Math.abs(oUv[o * 2] - uv[b]) < E && Math.abs(oUv[o * 2 + 1] - uv[b + 1]) < E))) break;
    }
    if (o === -1) {
      o = next.length; next.push(head[id]); head[id] = o;
      oPos.push(pos[a], pos[a + 1], pos[a + 2]); oNrm.push(nrm[a], nrm[a + 1], nrm[a + 2]);
      if (uv) oUv.push(uv[b], uv[b + 1]);
    }
    index[v] = o;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(new Float32Array(oPos), 3));
  out.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(oNrm), 3));
  if (uv) out.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(oUv), 2));
  out.setIndex(new THREE.BufferAttribute(next.length > 65535 ? index : new Uint16Array(index), 1));
  return out;
}

/** Turn a solid built about +y so that +y points along `dir`, then move it. */
const TURN = { '+y': null, '-y': (g) => g.rotateX(Math.PI), '+z': (g) => g.rotateX(Math.PI / 2), '-z': (g) => g.rotateX(-Math.PI / 2), '+x': (g) => g.rotateZ(-Math.PI / 2), '-x': (g) => g.rotateZ(Math.PI / 2) };
const turned = (g, dir, x = 0, y = 0, z = 0) => { const c = g.clone(); TURN[dir]?.(c); return move(c, x, y, z); };

/** Socket-head cap screw M<d>: head of height k with a hex socket, top face at y = 0, socket towards +y; optional shank. */
function capScrew(d, k = d, shank = 0) {
  const r = 0.8 * d, c = 0.1 * d, rs = 0.47 * d;
  const prof = shank > 0 ? [[0, -k - shank], [rs, -k - shank], [rs, -k], [r, -k], [r, -c], [r - c, 0], [0, 0]] : [[0, -k], [r, -k], [r, -c], [r - c, 0], [0, 0]];
  const sd = Math.min(0.55 * d, k - 0.7);
  return drill(dropSlivers(lathe(prof, 16)), 'y', 1, 0, [bore(0, 0, [[0, 0.5 * d], [0.08 * d, 0.44 * d], [sd, 0.44 * d]], { n: 6 })]);
}

function ballscrew() {
  // Part colours sampled from Fig. 6. Hardware that the figure is too coarse to show (screws, bearing rings, seals)
  // is steel, brass or black.
  const K = { motor: '#d92b2f', bearing: '#b4662a', guide: '#a7a2ea', slide: '#22b2bd', system: '#2cab33', unit: '#2a2fc4', bracket: '#8d9197', nut: '#dcbf2c', screw: '#b13fc4' };
  // Four shader variants in all (paint with clearcoat, metal, brushed metal, rubber), so the first frame does not
  // wait for more programs than the old model needed.
  const MAT = {
    motor: ['paint', K.motor, { metalness: 0.15, roughness: 0.5, clearcoat: 0.35, clearcoatRoughness: 0.35 }],       // powder coat
    bearing: ['metal', K.bearing, { metalness: 0.88, roughness: 0.4 }],                                             // anodised
    guide: ['metal', K.guide, { metalness: 0.9, roughness: 0.32, anisotropy: 0.5 }],                                // ground, tinted
    race: ['metal', '#e6e8f4', { metalness: 1, roughness: 0.16 }],                                                  // raceways
    guideCap: ['paint', '#8f8ad8', { metalness: 0, roughness: 0.55, clearcoat: 0.15 }],                             // moulded
    slide: ['paint', K.slide, { metalness: 0.6, roughness: 0.36, clearcoat: 0.25 }],
    slideCap: ['paint', '#1b9fab', { metalness: 0, roughness: 0.5, clearcoat: 0.2 }],                               // moulded
    system: ['paint', K.system, { metalness: 0.1, roughness: 0.5, clearcoat: 0.4, clearcoatRoughness: 0.3 }],       // enamel on a casting
    milled: ['metal', '#49ba54', { metalness: 0.6, roughness: 0.26, anisotropy: 0.5 }],                             // milled seats, same green
    unit: ['metal', K.unit, { metalness: 0.88, roughness: 0.36 }],
    bracket: ['metal', K.bracket, { metalness: 0.9, roughness: 0.46, anisotropy: 0.4 }],                            // machined aluminium
    nut: ['metal', K.nut, { metalness: 0.92, roughness: 0.3 }],
    screw: ['metal', K.screw, { roughness: 0.3 }],
    steel: ['metal', '#cfd3d9', { metalness: 1, roughness: 0.26 }],
    dark: ['rubber', '#16181c', { roughness: 0.7 }],
    brass: ['metal', '#c9a54b', { metalness: 1, roughness: 0.3 }],
  };
  const tr = (...i) => i.map((k) => BALLSCREW_TRIPLES[k]);
  // Like finish(), with creaseWeld() for speed, plus `grain`: linear UVs for brushed flat stock (see grainUV).
  const fin = (soups, { crease = 35, uv = null, grain = null } = {}) => {
    const g = creaseWeld(dropSlivers(mergeSoups(soups.flat(Infinity))), crease * DEG, uv ? (x) => axisUV(x, uv) : grain ? (x) => grainUV(x, grain) : null);
    g.scale(MM, MM, MM);
    g.computeBoundingBox();
    g.computeBoundingSphere();
    return g;
  };
  // Geometry is built once per part type and shared: four slide blocks and two guides come from one mesh each, and
  // showing the model again costs nothing. Materials are made per part, as the viewer needs for its highlight.
  const cache = new Map();
  const built = (name, specs) => (T, lib) => {
    let c = cache.get(name);
    if (!c) cache.set(name, (c = specs().filter((s) => s.geo || s.soups.length).map((s) => ({ geo: s.geo ?? fin(s.soups, s.opts), mat: s.mat }))));
    const g = new THREE.Group();
    for (const { geo, mat } of c) g.add(mesh(geo, lib.material(mat[0], mat[1], mat[2])));
    return g;
  };
  const screws = new Map();
  const screwHead = (d, k = d, shank = 0) => { const id = `${d}/${k}/${shank}`; if (!screws.has(id)) screws.set(id, capScrew(d, k, shank)); return screws.get(id); };
  const railX = 80;

  // ---- linear rolling guide: ground rail, head towards -z (inside the slide blocks), mounting face towards +z
  const railSection = () => {
    const dip = (A, B, sag, k = 4) => {                // raceway: a shallow groove from A to B, hollowed towards the core
      const dx = B[0] - A[0], dz = B[1] - A[1], L = Math.hypot(dx, dz);
      let nx = -dz / L, nz = dx / L;
      if (nx > 0) { nx = -nx; nz = -nz; }
      return Array.from({ length: k + 1 }, (_, i) => { const t = i / k, s = 4 * t * (1 - t) * sag; return [A[0] + dx * t + nx * s, A[1] + dz * t + nz * s]; });
    };
    const right = [[13, 9], [14, 8], [14, 1.6], [11.4, -0.6], ...dip([11.4, -1.6], [14, -4.2], 0.45), ...dip([14, -6.4], [11.6, -8.8], 0.45), [11.3, -9]];
    return right.concat(right.slice().reverse().map(([x, z]) => [-x, z]));         // (x, z)
  };
  const guide = built('guide', () => {
    const L = 610, cap = 3.2, sec = railSection();
    let body = extY(shapeOf(sec.map(([x, z]) => [x, -z])), cap - 0.3, L - cap + 0.3, 0.5, { bevelSegments: 1 });
    const ys = Array.from({ length: 10 }, (_, i) => 35 + 60 * i);
    body = drill(body, 'z', -1, -9, ys.map((y) => bore(0, y, [[0, 5.9], [0.4, 5.5], [6.5, 5.5], [6.5, 3.3], [17.6, 3.3]], { floor: false })));
    body = drill(body, 'z', 1, 9, ys.map((y) => bore(0, y, [[0, 3.7], [0.4, 3.3]], { floor: false })));
    const [race, rest] = splitSoup(body, (c, n) => Math.abs(c[0]) > 11.5 && Math.abs(n[1]) < 0.3 && ((c[2] < -6.45 && c[2] > -8.95) || (c[2] < -1.65 && c[2] > -4.15)));
    const capShape = () => shapeOf(sec.map(([x, z]) => [x * 0.965, -z * 0.95]));
    return [
      { soups: [rest], opts: { crease: 30, grain: 'y' }, mat: MAT.guide },
      { soups: [race], opts: { crease: 40 }, mat: MAT.race },
      { soups: [extY(capShape(), 0, cap, 0.6, { bevelSegments: 2 }), extY(capShape(), L - cap, L, 0.6, { bevelSegments: 2 })], mat: MAT.guideCap },
    ];
  });

  // ---- slide block: steel body, moulded end caps, end seals, grease nipple on the upper end. The rail head sits
  // in the channel, which opens towards +z; the mounting face (four tapped holes) faces -z.
  const slideSection = (o = 0, gap = 0.5) => {
    const g = gap - 0.5;
    const ch = [[14.6 + g, 15 - o], [14.6 + g, 11.3], [12.3 + g, 9.5], [12.3 + g, 8.1], [14.6 + g, 5.7], [14.6 + g, 3.5], [12.2 + g, 1 - gap * 0.8]];
    const right = [[26 - o, 15 - o], [27 - o, 14 - o], [27 - o, -13 + o], [25 - o, -15 + o]];
    const pts = [ch[0], ...right, ...right.slice().reverse().map(([x, z]) => [-x, z]), ...ch.map(([x, z]) => [-x, z]), ...ch.slice(1).reverse()];
    return shapeOf(pts.map(([x, z]) => [x, -z]));
  };
  const slide = built('slide', () => {
    const dark = [], steel = [];
    let body = extY(slideSection(), -30, 30, 0.8, { bevelSegments: 2 });
    body = drill(body, 'z', -1, -15, [[-19.5, -17], [19.5, -17], [-19.5, 17], [19.5, 17]].map(([x, y]) => tapped(x, y, 2.6, 9)), dark);
    const caps = [extY(slideSection(0.6, 0.3), 30, 37.4, 0.7, { bevelSegments: 2 }), extY(slideSection(0.6, 0.3), -37.4, -30, 0.7, { bevelSegments: 2 })];
    dark.push(extY(slideSection(1.1, 0.12), 37.4, 40, 0.5, { bevelSegments: 1 }), extY(slideSection(1.1, 0.12), -40, -37.4, 0.5, { bevelSegments: 1 }));
    const pan = lathe([[0, 0], [2.3, 0], [2.3, 0.5], [1.7, 1.2], [0, 1.2]], 12);
    for (const x of [-20.8, 20.8]) steel.push(turned(pan, '+y', x, 39.9, 3), turned(pan, '-y', x, -39.9, 3));
    const nipple = [
      move(extY(shapeOf(ringPts(0, 0, 3.2, 6)), 39.8, 42.4, 0.3, { bevelSegments: 1 }), 0, 0, -8),
      move(lathe([[0, 42.3], [1.7, 42.3], [1.7, 44.3], [2.6, 45], [2.6, 46.3], [1.5, 47.5], [0, 47.5]], 14), 0, 0, -8),
    ];
    return [
      { soups: [body], mat: MAT.slide },
      { soups: caps, mat: MAT.slideCap },
      { soups: dark, mat: MAT.dark },
      { soups: steel, mat: MAT.steel },
      { soups: nipple, opts: { crease: 30 }, mat: MAT.brass },
    ];
  });
  const slideAt = (key, sx, y) => part(key, 'Slide blocks', 'Slide block', '滑塊', K.slide, [sx * railX, y, -8], BALLSCREW_EX.slide, slide,
    { group: 'slide-blocks', triples: tr(0, 1, 2, 8) });

  // ---- lower-end bearing block: U-shaped housing, four counterbored fixing screws on the front, bearing seat on top
  const lower = built('lower', () => {
    const dark = [], steel = [];
    let body = extZ(roundPoly([[-39, 0], [-14, 0], [-14, 22], [14, 22], [14, 0], [39, 0], [39, 50], [-39, 50]], 2, 3), -20, 20, 1.4, { bevelSegments: 3 });
    const at = [[-27, 11], [27, 11], [-27, 38], [27, 38]];
    body = drill(body, 'z', 1, 20, at.map(([x, y]) => cbore(x, y, 4.5, 5.4, 2.8, 5)), dark);
    body = drill(body, 'y', 1, 50, [bore(0, 0, [[0, 13.5], [0.6, 12.9], [12, 12.9]], { n: 40 })], dark);
    body = drill(body, 'y', -1, 22, [bore(0, 0, [[0, 8.1], [0.5, 7.6], [6, 7.6]], { n: 28 })], dark);
    for (const [x, y] of at) steel.push(turned(screwHead(5), '+z', x, y, 19.6));
    steel.push(lathe(tube(12.85, 10.7, 38.2, 45.9, 0.4), 40), lathe(tube(9.3, 7.35, 38.2, 45.9, 0.4), 32));       // bearing rings
    dark.push(lathe(tube(10.7, 9.3, 38.2, 45.2, 0), 32));                                                           // bearing seal
    return [{ soups: [body], mat: MAT.bearing }, { soups: steel, mat: MAT.steel }, { soups: dark, mat: MAT.dark }];
  });

  // ---- upper-end bearing block: housing, motor plate with pilot bore, bearing retainer underneath, side lug
  const upper = built('upper', () => {
    const dark = [], steel = [];
    let body = extY(rrect(100, 64, 4), 0, 88.4, 1.8, { bevelSegments: 3 });
    body = drill(body, 'y', -1, 0, [bore(0, 0, [[0, 11.4], [14, 11.4]], { n: 32 })], dark);
    body = drill(body, 'y', 1, 88.4, [bore(0, 0, [[0, 13], [24, 13]], { n: 32 })], dark);
    const corners = [[-57, -30], [57, -30], [-57, 30], [57, 30]];
    let plate = box(132, 9, 80, 2, 0, 92.5, 0);
    plate = drill(plate, 'y', 1, 97, [
      bore(0, 0, [[0, 26.5], [0.5, 26], [5, 26], [5, 13], [9.2, 13]], { n: 48, floor: false }),
      ...corners.map(([x, z]) => cbore(x, z, 4.5, 5.4, 2.8, 3)),
    ], dark);
    for (const [x, z] of corners) steel.push(turned(screwHead(5), '+y', x, 96.6, z));
    let cap = dropSlivers(lathe(tube(20, 11, -10, 1, 0.6), 48));                                                    // bearing retainer
    const ring = polar(4, 15.5, Math.PI / 4);
    cap = drill(cap, 'y', -1, -10, ring.map(([x, z]) => cbore(x, z, 2.7, 3.2, 1.7, 2, { n: 16 })), dark);
    for (const [x, z] of ring) steel.push(turned(screwHead(3), '-y', x, -9.7, z));
    steel.push(lathe(tube(10.95, 9.4, -8.6, 0.5, 0.35), 40), lathe(tube(8.6, 7.35, -8.6, 0.5, 0.35), 32));
    dark.push(lathe(tube(9.4, 8.6, -7.9, 0.5, 0), 32));
    let lug = extZ(rrect(26, 78, 2, -37, 45), 31.6, 38, 1, { bevelSegments: 2 });
    lug = drill(lug, 'z', 1, 38, [22, 45, 68].map((y) => cbore(-37, y, 4.5, 3.4, 2.8, 2.2)), dark);
    for (const y of [22, 45, 68]) steel.push(turned(screwHead(5, 3), '+z', -37, y, 37.7));
    return [{ soups: [body, plate, cap, lug], mat: MAT.bearing }, { soups: steel, mat: MAT.steel }, { soups: dark, mat: MAT.dark }];
  });

  // ---- servo motor: square flange with four screws, end bells, ribbed stack, rear cover, pilot and shaft underneath,
  // connector and cable gland on the back
  const ribbedSquare = (s, ch, pitch, w, dep) => {
    const h = s / 2, side = [[-h + ch, -h]], m = Math.floor((h - ch - w) / pitch);
    for (let k = -m; k <= m; k++) { const x = k * pitch; side.push([x - w / 2, -h], [x - w / 2 + dep * 0.35, -h + dep], [x + w / 2 - dep * 0.35, -h + dep], [x + w / 2, -h]); }
    side.push([h - ch, -h]);
    const out = [];
    for (let q = 0; q < 4; q++) for (const [x, y] of side) { let X = x, Y = y; for (let i = 0; i < q; i++) [X, Y] = [-Y, X]; out.push([X, Y]); }
    return shapeOf(out);
  };
  const motor = built('servo', () => {
    const dark = [], steel = [];
    const oct = (s, ch) => { const h = s / 2; return [[-h + ch, -h], [h - ch, -h], [h, -h + ch], [h, h - ch], [h - ch, h], [-h + ch, h], [-h, h - ch], [-h, -h + ch]]; };
    const bell = () => roundPoly(oct(76, 12), 2.5, 3);
    let cover = extY(rrect(70, 70, 11), 94, 112, 3.2, { bevelSegments: 4 });
    const cs = [[-25, -25], [25, -25], [-25, 25], [25, 25]];
    cover = drill(cover, 'y', 1, 112, cs.map(([x, z]) => cbore(x, z, 3.5, 3.4, 2.2, 2)), dark);
    for (const [x, z] of cs) steel.push(turned(screwHead(4, 3), '+y', x, 111.7, z));
    for (const [x, z] of [[-37, -37], [37, -37], [-37, 37], [37, 37]]) steel.push(turned(screwHead(6), '+y', x, 17, z));
    steel.push(lathe(stepped([[7, -24, -4], [25.6, -4, 0.5]], 0.8), 40));                                           // shaft and pilot
    steel.push(box(34, 10, 0.9, 0.3, 0, 103, 35.2, 1));                                                             // rating plate (blank)
    // back: circular connector and cable gland on a pad
    const pad = box(60, 15, 4, 1.2, 0, 103, -36.6, 2);
    const shell = lathe([[0, 0], [10.5, 0], [10.5, 3], [9, 3], [9, 11], [9.8, 11.5], [9.8, 14.5], [9, 15], [9, 17], [7.6, 17], [7.6, 13.5], [0, 13.5]], 32);
    steel.push(turned(shell, '-z', -15, 103, -38.4));
    dark.push(turned(lathe(stepped([[7.5, 13, 15]], 0.3), 24), '-z', -15, 103, -38.4));
    steel.push(turned(extY(shapeOf(ringPts(0, 0, 7.6, 6)), 0, 5, 0.6, { bevelSegments: 1 }), '-z', 17, 103, -38.4));
    dark.push(turned(lathe(stepped([[5.4, 4.6, 9], [4.5, 9, 15], [3.7, 15, 21]], 0.7), 20), '-z', 17, 103, -38.4));
    return [
      { soups: [
        extY(rrect(92, 92, 9), 0, 11, 1.3, { bevelSegments: 3 }),
        extY(bell(), 10, 25, 1.2, { bevelSegments: 2 }),
        extY(ribbedSquare(75, 12, 6.5, 2.6, 1.8), 24, 82, 0.6, { bevelSegments: 1 }),
        extY(bell(), 81, 95, 1.2, { bevelSegments: 2 }),
        cover, pad,
      ], mat: MAT.motor },
      { soups: steel, mat: MAT.steel },
      { soups: dark, mat: MAT.dark },
    ];
  });

  // ---- spindle system: carriage plate with milled seats for the slide blocks and the nut bracket, bolted from the
  // back, and the spindle housing with its bore and a milled front face
  const system = built('system', () => {
    const dark = [], steel = [], seats = [], milled = [];
    let plate = extZ(roundPoly([[-116, -126], [118, -126], [118, 126], [-118, 126], [-118, -28], [-135, -28], [-135, -40]], 3, 3), -9, 9, 1.6, { bevelSegments: 3 });
    const blocks = [[-railX, 82], [railX, 82], [-railX, -88], [railX, -88]];
    const through = blocks.flatMap(([x, y]) => [[x - 19.5, y - 17], [x + 19.5, y - 17], [x - 19.5, y + 17], [x + 19.5, y + 17]]);
    const forBracket = [[-40.5, 44], [40.5, 44], [-40.5, 88], [40.5, 88]];
    plate = drill(plate, 'z', 1, 9, [...blocks.map(([x, y]) => pocket(x, y, 58, 70, 3, [[0, 0], [0.6, 0.6]])), pocket(0, 66, 96, 74, 3, [[0, 0], [0.6, 0.6]])], seats);
    milled.push(drill(mergeSoups(seats), 'z', 1, 8.4, [
      ...through.map(([x, y]) => bore(x, y, [[0, 3.7], [0.4, 3.3]], { floor: false })),
      ...forBracket.map(([x, y]) => tapped(x, y, 2.6, 9)),
    ], dark));
    plate = drill(plate, 'z', -1, -9, through.map(([x, y]) => bore(x, y, [[0, 5.9], [0.4, 5.5], [6.5, 5.5], [6.5, 3.3], [17, 3.3]], { floor: false })));
    for (const [x, y] of through) steel.push(turned(screwHead(6, 6, 10.5), '-z', x, y, -8.5));
    const bx = -201.5, bz = -26;
    let housing = extY(rrect(177, 110, 7, bx, -bz), -30, 84, 2.6, { bevelSegments: 3 });
    // spot faces under the flange and the nose cap; the bore and the tapped circles are cut into them
    const spotTop = [], spotLow = [];
    housing = drill(housing, 'y', 1, 84, [bore(bx, bz, [[0, 44], [0.6, 43.4]], { n: 64 })], spotTop);
    housing = drill(housing, 'y', -1, -30, [bore(bx, bz, [[0, 45.6], [0.6, 45]], { n: 64 })], spotLow);
    milled.push(drill(mergeSoups(spotTop), 'y', 1, 83.4, [bore(bx, bz, [[0, 31.4], [0.9, 30.5], [111.9, 30.5]], { n: 48, floor: false }), ...polar(6, 34.4, Math.PI / 6, bx, bz).map(([x, z]) => tapped(x, z, 2, 8))], dark));
    milled.push(drill(mergeSoups(spotLow), 'y', -1, -29.4, [bore(bx, bz, [[0, 31.4], [0.9, 30.5]], { n: 48, floor: false }), ...polar(6, 35.2, Math.PI / 6, bx, bz).map(([x, z]) => tapped(x, z, 2, 8))], dark));
    const face = [];
    housing = drill(housing, 'z', 1, 29, [pocket(bx, 27, 150, 88, 4, [[0, 0], [1, 1]])], face);
    milled.push(drill(mergeSoups(face), 'z', 1, 28, [[-62, -32], [62, -32], [-62, 32], [62, 32]].map(([x, y]) => tapped(bx + x, 27 + y, 3.4, 10)), dark));
    return [
      { soups: [plate, housing], mat: MAT.system },
      { soups: milled, opts: { grain: 'y' }, mat: MAT.milled },
      { soups: steel, mat: MAT.steel },
      { soups: dark, mat: MAT.dark },
    ];
  });

  // ---- spindle unit: cartridge with O-rings, bolted flange and drawbar cylinder on top, nose cap with labyrinth
  // grooves below, and a spindle nose with taper socket and two drive keys
  const unit = built('unit', () => {
    const dark = [], steel = [];
    let body = dropSlivers(lathe([[14.5, -109], [17.2, -109], [18, -108.2], [18, -101], [39.8, -101], [41, -99.8], [41, -91], [39.6, -91], [39.6, -89], [41, -89], [41, -86], [39.6, -86], [39.6, -84], [41, -84], [41, -58.4], [39.6, -57],
      [30, -57], [30, -42], [28.8, -42], [28.8, -39], [30, -39], [30, 39], [28.8, 39], [28.8, 42], [30, 42], [30, 57],
      [38.4, 57], [39, 57.6], [39, 68], [37.8, 68.4], [37.8, 69.6], [39, 70], [39, 80.4], [38.4, 81],
      [20, 81], [20, 83.2], [19.2, 84], [15, 84], [15, 96], [14.2, 96.3], [14.2, 97.7], [15, 98], [15, 104.2], [14.2, 105], [7, 105], [7, 110.2], [6.2, 111], [0, 111]], 64));
    const top = polar(6, 34.4, Math.PI / 6), under = polar(6, 35.2, Math.PI / 6);
    body = drill(body, 'y', 1, 81, top.map(([x, z]) => cbore(x, z, 3.4, 4.3, 2.3, 3)), dark);
    body = drill(body, 'y', 1, 111, [bore(0, 0, [[0, 3.6], [0.5, 3.1], [5, 3.1]])], dark);
    body = drill(body, 'y', -1, -101, under.map(([x, z]) => cbore(x, z, 3.4, 4.3, 2.3, 4)), dark);
    for (const [x, z] of top) steel.push(turned(screwHead(4), '+y', x, 80.7, z));
    for (const [x, z] of under) steel.push(turned(screwHead(4), '-y', x, -100.7, z));
    steel.push(lathe([[14.5, -109], [14.5, -90], [0, -90], [0, -93], [6, -93], [10.5, -109]], 40));                 // nose face and taper socket
    steel.push(box(6.4, 4.4, 7, 0.6, 14.6, -110.9, 0, 1), box(6.4, 4.4, 7, 0.6, -14.6, -110.9, 0, 1));              // drive keys
    for (const y of [-40.5, 40.5]) dark.push(lathe(ringPts(29.15, y, 1.3, 8), 48));                                 // O-rings
    return [{ soups: [body], opts: { crease: 30 }, mat: MAT.unit }, { soups: steel, mat: MAT.steel }, { soups: dark, mat: MAT.dark }];
  });

  // ---- nut bracket: grooved front as in the figure, four fixing screws, tapped circle for the nut flange
  const bracket = built('bracket', () => {
    const dark = [], steel = [];
    const pts = [[-47, -24.5]];
    for (const c of [-32, -16, 0, 16, 32]) pts.push([c - 2, -24.5], [c - 2, -22], [c + 2, -22], [c + 2, -24.5]);
    pts.push([47, -24.5], [47, 24.5], [-47, 24.5]);
    const sh = roundPoly(pts, 0.8, 2);
    sh.holes.push(hole(16.4, 0, 1.5, 48));
    let body = extY(sh, -34, 34, 1.2, { bevelSegments: 2 });
    const at = [[-40.5, -22], [40.5, -22], [-40.5, 22], [40.5, 22]];
    body = drill(body, 'z', 1, 24.5, at.map(([x, y]) => cbore(x, y, 4.4, 5.4, 2.8, 5)), dark);
    body = drill(body, 'y', 1, 34, polar(6, 21.5, 0, 0, -1.5).map(([x, z]) => tapped(x, z, 2.1, 7)), dark);
    for (const [x, y] of at) steel.push(turned(screwHead(5), '+z', x, y, 24.1));
    return [{ soups: [body], opts: { grain: 'y' }, mat: MAT.bracket }, { soups: steel, mat: MAT.steel }, { soups: dark, mat: MAT.dark }];
  });

  // ---- ball nut: flange with six screws, wiper rings at both ends
  const nut = built('nut', () => {
    const rb = 10.4, rw = 13, dw = 1.8, c = 0.9, dark = [], steel = [];
    let body = dropSlivers(lathe([[rb, 8 - dw], [rw, 8 - dw], [rw, 7.7], [rw + 0.3, 8], [27 - c, 8], [27, 8 - c], [27, c], [27 - c, 0], [17.2, 0], [16, -1.2],
      [16, -85], [15.3, -85.3], [15.3, -86.7], [16, -87], [16, -94 + c], [16 - c, -94], [rw + 0.3, -94], [rw, -93.7], [rw, -94 + dw], [rb, -94 + dw]], 60));
    const ring = polar(6, 21.5);
    body = drill(body, 'y', 1, 8, ring.map(([x, z]) => cbore(x, z, 3.5, 4.3, 2.3, 2.6)), dark);
    for (const [x, z] of ring) steel.push(turned(screwHead(4), '+y', x, 7.7, z));
    dark.push(lathe(tube(rw - 0.05, 10.12, 8 - dw, 7.5, 0.3), 48), lathe(tube(rw - 0.05, 10.12, -93.5, -94 + dw, 0.3), 48));   // wipers
    return [{ soups: [body], opts: { crease: 30 }, mat: MAT.nut }, { soups: steel, mat: MAT.steel }, { soups: dark, mat: MAT.dark }];
  });

  // ---- screw shaft: the ball-thread between two plain journals; circlip groove below, bearing seat, locknut
  // thread and coupling end above, centre holes in both ends
  const screw = built('screw', () => {
    let low = dropSlivers(lathe([[0, 0], [6.2, 0], [7, 0.8], [7, 7], [6.3, 7.2], [6.3, 8.4], [7, 8.6], [7, 40], [9.2, 40], [10, 40.8], [10, 45], [0, 45]], 36));
    const top = [[0, 525], [10, 525], [10, 529.2], [9.2, 530], [7, 530], [7, 548], [6.6, 548.4]];
    for (let y = 548.4; y < 559.5; y += 1.25) top.push([5.9, y + 0.625], [6.6, y + 1.25]);
    top.push([5.5, 561], [5.5, 599.2], [4.7, 600], [0, 600]);
    let high = dropSlivers(lathe(top, 36));
    const centre = [bore(0, 0, [[0, 2.4], [1.2, 1.2], [3.6, 1.2]], { n: 16 })];
    low = drill(low, 'y', -1, 0, centre);
    high = drill(high, 'y', 1, 600, centre);
    return [
      { soups: [low, high], opts: { crease: 30, uv: 'y' }, mat: ['metal', K.screw, { roughness: 0.3, anisotropy: 0.5 }] },
      { geo: threadGeo({ y0: 44, length: 482, pitch: 6, rMinor: 8.3, rMajor: 10, form: 'ball', seg: 24, perPitch: 10, fade: 1 }), mat: MAT.screw },
    ];
  });

  return {
    id: 'ballscrew',
    title: { en: 'Ball-screw linear module', zh: '滾珠螺桿線性模組' },
    source: { en: 'Fig. 6, bottom middle (p.6)', zh: '圖 6 中間下方（第 6 頁）' },
    triples: BALLSCREW_TRIPLES.slice(),
    // From the front left: the exploded layers then fan out to the left, where the spindle housing already is, and
    // nothing ends up behind the rails. (Fig. 6 is drawn from the front right; the layout is the same.)
    view: { dir: [-0.62, 0.32, 1] },
    parts: [
      part('servo', 'Servo motor', 'Servo motor', '伺服馬達', K.motor, [0, 629, 0], BALLSCREW_EX.servo, motor, { triples: tr(6) }),
      part('upper', 'Upper-end bearing joints', 'Upper-end bearing joint', '上端軸承座', K.bearing, [0, 532, 0], BALLSCREW_EX.upper, upper, { triples: tr(5, 6) }),
      part('guide_l', 'Linear rolling guides', 'Linear rolling guide', '線性滑軌', K.guide, [-railX, 0, 2], BALLSCREW_EX.guide, guide,
        { group: 'guides', triples: tr(0, 1) }),
      part('guide_r', 'Linear rolling guides', 'Linear rolling guide', '線性滑軌', K.guide, [railX, 0, 2], BALLSCREW_EX.guide, guide,
        { group: 'guides', triples: tr(0, 1) }),
      slideAt('slide_ul', -1, 396), slideAt('slide_ur', 1, 396), slideAt('slide_ll', -1, 226), slideAt('slide_lr', 1, 226),
      part('bracket', 'Nut bracket', 'Nut bracket', '螺帽座', K.bracket, [0, 380, 1.5], BALLSCREW_EX.bracket, bracket, { triples: tr(2, 3) }),
      part('nut', 'Screw-nut joints', 'Screw-nut joint (ball nut)', '螺桿螺帽（滾珠螺帽）', K.nut, [0, 414, 0], BALLSCREW_EX.nut, nut, { triples: tr(3, 4) }),
      part('screw', 'Screw shaft', 'Screw shaft', '螺桿', K.screw, [0, 6, 0], BALLSCREW_EX.screw, screw, { triples: tr(4, 5, 7) }),
      part('lower', 'Lower-end bearing joints', 'Lower-end bearing joint', '下端軸承座', K.bearing, [0, 0, 0], BALLSCREW_EX.lower, lower, { triples: tr(7) }),
      part('system', 'Spindle system', 'Spindle system', '主軸系統', K.system, [0, 314, -32], BALLSCREW_EX.system, system, { triples: tr(8, 9) }),
      part('unit', 'Spindle unit', 'Spindle unit', '主軸單元', K.unit, [-201.5, 341, -58], BALLSCREW_EX.unit, unit, { triples: tr(9) }),
    ],
  };
}

// Exploded offsets of the ball-screw module, in millimetres as they end up on screen: MODELS spreads the model by
// 1.7 (keep BALLSCREW_SPREAD equal to that factor), so the numbers are divided by it here. The rails and the lower bearing block stay where they
// are. Along the screw axis (y): shaft out of the lower bearing, upper bearing block off the shaft, motor off the
// block, ball nut out of its bracket, spindle unit out of its housing. Along the fixing screws (z): slide blocks
// off the rails to the back, carriage plate off the slide blocks, nut bracket off the plate to the front.
const BALLSCREW_SPREAD = 1.7;
const BALLSCREW_EX = Object.fromEntries(Object.entries({
  lower: [0, 0, 0], guide: [0, 0, 0], screw: [0, 60, 0], upper: [0, 156, 0], servo: [0, 216, 0],
  slide: [0, 0, -125], system: [0, 0, -280], unit: [0, 225, -280], bracket: [0, 0, 150], nut: [0, 110, 150],
}).map(([k, v]) => [k, v.map((n) => n / BALLSCREW_SPREAD)]));

// ------------------------------------------------------------------ registry

// The ball screw is tall and thin, so its exploded offsets read small once the camera reframes: spread them out.
function spread(m, k) {
  for (const p of m.parts) {
    const a = p.assembled.position, e = p.exploded.position;
    p.exploded = { ...p.exploded, position: e.map((v, i) => a[i] + (v - a[i]) * k) };   // positions are [x, y, z] in metres
  }
  return m;
}

export const MODELS = [product1(), product2(), product3(), product4(), product5(), spread(ballscrew(), 1.7)];
export const MODEL_IDS = MODELS.map((m) => m.id);
export function getModel(id) {
  const m = typeof id === 'string' ? MODELS.find((x) => x.id === id) : id;
  if (!m || !Array.isArray(m.parts)) throw new Error(`models: unknown model "${id}"`);
  return m;
}
