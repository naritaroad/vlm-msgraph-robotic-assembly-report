// Teaching overlays (docs/lab.md section 6): labels, frames, camera frustum, pixel ray, point clouds, memory,
// ICP, Eq. (7) waypoints, grasp pose, contact points.
// Every item has show() / hide() and, where it carries data, set(data) / clear().
// All 3D overlay objects live on LAYER_OVERLAY, so the wrist camera and rig.capture() never see them.
// Inputs are world coordinates in metres; matrices are row-major arrays of 16 (same as kinematics.js).

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { CSS2DRenderer, CSS2DObject } from 'three/addons/renderers/CSS2DRenderer.js';
import { LAYER_OVERLAY } from './world.js';
import { poseFor } from './parts.js';

const AXIS = { x: 0xD7263D, y: 0x1E9E5A, z: 0x1F6FD0 };
const GRASP_BLUE = 0x2A56FF, ACCENT = 0xFF7A2E;

const CSS = `
.labrig-labels{position:absolute;inset:0;pointer-events:none;overflow:hidden}
.labrig-label{font:500 12.5px/1.25 "Segoe UI Variable Text","Segoe UI",-apple-system,"Helvetica Neue","Microsoft JhengHei","PingFang TC",sans-serif;
  color:#E6EAEE;background:rgba(13,16,20,.82);border:1px solid #2B343E;border-radius:3px;padding:3px 7px 3px 4px;white-space:nowrap;
  display:flex;align-items:center;gap:6px;transform-origin:50% 100%;box-shadow:0 1px 0 rgba(0,0,0,.35)}
.labrig-label .b{display:inline-grid;place-items:center;min-width:17px;height:17px;border-radius:2px;font:700 11px/1 "Cascadia Mono",Consolas,ui-monospace,monospace;color:#0D1014}
.labrig-label .s{font:italic 500 12.5px/1 "Iowan Old Style","Palatino Linotype",Palatino,Georgia,serif;color:#FFB454}
.labrig-label .s sub{font:500 9.5px/1 "Cascadia Mono",Consolas,ui-monospace,monospace;font-style:normal;vertical-align:-2px;margin-left:1px}
.labrig-label.plain{padding:2px 6px;color:#B9C2CC}
.labrig-num{font:700 11px/1 "Cascadia Mono",Consolas,ui-monospace,monospace;color:#0D1014;background:#E6EAEE;border-radius:9px;min-width:17px;height:17px;display:grid;place-items:center}
.labrig-num.on{background:#FF7A2E;color:#fff}
.labrig-edge{font:500 11.5px/1.2 "Cascadia Mono",Consolas,ui-monospace,monospace;color:#FFB454;background:rgba(13,16,20,.78);border-radius:2px;padding:1px 5px}
.labrig-axis{font:700 11px/1 "Cascadia Mono",Consolas,ui-monospace,monospace;color:#E6EAEE;background:rgba(13,16,20,.7);border-radius:2px;padding:1px 4px}
`;

function toFlat(points) {
  if (!points) return new Float32Array(0);
  if (points instanceof Float32Array) return points;
  if (points.length && typeof points[0] === 'number') return Float32Array.from(points);
  const a = new Float32Array(points.length * 3);
  for (let i = 0; i < points.length; i++) { a[i * 3] = points[i][0]; a[i * 3 + 1] = points[i][1]; a[i * 3 + 2] = points[i][2]; }
  return a;
}
const setRows = (M, m) => M.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);

/** Pose input: { matrix:[16] } or { position:[3], quaternion:[x,y,z,w] } or { p:[3], x:[3], z:[3] } (tool axes). */
function poseToMatrix(pose, out = new THREE.Matrix4()) {
  if (pose.matrix) return setRows(out, pose.matrix);
  if (pose.quaternion) return out.compose(new THREE.Vector3(...pose.position), new THREE.Quaternion(...pose.quaternion), new THREE.Vector3(1, 1, 1));
  const z = new THREE.Vector3(...pose.z).normalize(), x = new THREE.Vector3(...pose.x).normalize(), y = new THREE.Vector3().crossVectors(z, x).normalize();
  x.crossVectors(y, z);
  return out.makeBasis(x, y, z).setPosition(...pose.p);
}

export function createOverlays({ container, scene, camera, renderer, config, robot, parts }) {
  const root = new THREE.Group();
  root.name = 'overlays';
  scene.add(root);
  const onLayer = (o) => { o.traverse((c) => c.layers.set(LAYER_OVERLAY)); return o; };
  const lineMats = [];
  const lineMat = (color, width = 2.5, o = {}) => {
    const m = new LineMaterial({ color, linewidth: width, worldUnits: false, transparent: true, opacity: o.opacity ?? 1, depthTest: o.depthTest ?? true, dashed: !!o.dashed, dashSize: o.dashSize ?? 0.01, gapSize: o.gapSize ?? 0.008 });
    lineMats.push(m);
    return m;
  };
  const polyline = (flat, mat) => { const g = new LineGeometry(); g.setPositions(Array.from(flat)); const l = new Line2(g, mat); l.computeLineDistances(); l.frustumCulled = false; return l; };
  const segments = (flat, mat) => { const g = new LineSegmentsGeometry(); g.setPositions(Array.from(flat)); const l = new LineSegments2(g, mat); l.computeLineDistances(); l.frustumCulled = false; return l; };
  const group = (name, visible = false) => { const g = new THREE.Group(); g.name = name; g.visible = visible; root.add(g); return g; };
  const empty = (g) => { for (const c of [...g.children]) { g.remove(c); c.traverse((o) => { o.geometry?.dispose(); if (o.isCSS2DObject) o.element.remove(); }); } };
  const showHide = (g, extra = {}) => ({ show() { g.visible = true; return this; }, hide() { g.visible = false; return this; }, get visible() { return g.visible; }, object: g, ...extra });

  // ---- DOM label layer
  const style = document.createElement('style');
  style.textContent = CSS;
  container.appendChild(style);
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.className = 'labrig-labels';
  container.appendChild(labelRenderer.domElement);
  const dom = (cls, html) => { const el = document.createElement('div'); el.className = cls; el.innerHTML = html; return el; };
  const css2d = (el, pos, center = [0.5, 1.25]) => { const o = new CSS2DObject(el); if (pos) o.position.set(pos[0], pos[1], pos[2]); o.center.set(center[0], center[1]); o.layers.set(LAYER_OVERLAY); return o; };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ---- labels: part name + scene-graph symbol
  const labelGroup = group('labels');
  const labelItems = new Map();
  const partDefs = [...config.FIXTURES, ...config.PARTS];
  partDefs.forEach((def, i) => {
    const el = dom('labrig-label', '');
    const obj = css2d(el, [0, (parts.parts[def.key].object.userData.labelHeight ?? 0.03), 0]);
    labelItems.set(def.key, { el, obj, def, text: def.name, symbol: `n_${i}` });
    labelGroup.add(obj);
  });
  const extraLabels = [
    ['arm', 'xArm6', robot.links.link3, [0.04, 0.12, 0.09]],
    ['camera', 'wrist camera (D455 stand-in)', robot.cameraFrame, [0, -0.03, 0]],
    ['base', config.ROBOT.mobileBase.label, null, [robot.mobileBase.group.position.x + config.ROBOT.basePosition[0] + 0.25, config.ROBOT.mobileBase.size[1] + 0.16, 0.2]],
  ];
  for (const [key, text, parent, pos] of extraLabels) {
    const el = dom('labrig-label plain', esc(text));
    const obj = css2d(el, pos);
    labelItems.set(key, { el, obj, text, plain: true, parent });
    labelGroup.add(obj);
  }
  // 'n_3' -> n<sub>3</sub>; the mono fonts in the stack have no subscript digits
  const symHtml = (t) => esc(t).replace(/_(\w+)/g, '<sub>$1</sub>');
  const drawLabel = (it) => {
    if (it.plain) { it.el.textContent = it.text; return; }
    it.el.innerHTML = `<span class="b" style="background:${it.def.color}">${esc(it.def.short)}</span><span>${esc(it.text)}</span>${it.symbol ? `<span class="s">${symHtml(it.symbol)}</span>` : ''}`;
  };
  labelItems.forEach(drawLabel);
  const _v = new THREE.Vector3();
  const followLabels = () => {
    for (const [key, it] of labelItems) {
      const src = it.plain ? it.parent : parts.parts[key].object;
      if (!src) continue;
      src.updateWorldMatrix(true, false);
      if (it.plain) { _v.fromArray(extraLabels.find((e) => e[0] === key)[3]); src.localToWorld(_v); it.obj.position.copy(_v); }
      else { it.obj.position.setFromMatrixPosition(src.matrixWorld); it.obj.position.y += src.userData.labelHeight ?? 0.03; }
    }
  };
  const labels = showHide(labelGroup, {
    /** set('red', { text, symbol }) changes one label; symbol '' removes the symbol. */
    set(key, { text, symbol } = {}) { const it = labelItems.get(key); if (!it) return this; if (text !== undefined) it.text = text; if (symbol !== undefined) it.symbol = symbol; drawLabel(it); return this; },
  });

  // ---- edges of the scene graph: E = (subject, predicate, object)
  const edgeGroup = group('edges');
  const edgeMat = lineMat(0xFFB454, 2, { dashed: true, depthTest: false, opacity: 0.9 });
  let edgeData = [];
  const anchorOf = (key, out) => {
    const p = parts.parts[key];
    if (!p) return null;
    p.object.updateWorldMatrix(true, false);
    out.setFromMatrixPosition(p.object.matrixWorld); out.y += (p.object.userData.labelHeight ?? 0.03) * 0.6;
    return out;
  };
  const drawEdges = () => {
    empty(edgeGroup);
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (const e of edgeData) {
      if (!anchorOf(e.from, a) || !anchorOf(e.to, b)) continue;
      const mid = a.clone().add(b).multiplyScalar(0.5); mid.y += 0.035 + a.distanceTo(b) * 0.25;
      const pts = [];
      for (let i = 0; i <= 16; i++) { const t = i / 16, u = 1 - t; pts.push(u * u * a.x + 2 * u * t * mid.x + t * t * b.x, u * u * a.y + 2 * u * t * mid.y + t * t * b.y, u * u * a.z + 2 * u * t * mid.z + t * t * b.z); }
      edgeGroup.add(polyline(pts, edgeMat));
      if (e.text) edgeGroup.add(css2d(dom('labrig-edge', esc(e.text)), [(a.x + b.x) / 4 + mid.x / 2, (a.y + b.y) / 4 + mid.y / 2, (a.z + b.z) / 4 + mid.z / 2], [0.5, 0.5]));
    }
    onLayer(edgeGroup);
  };
  const edges = showHide(edgeGroup, {
    /** set([{ from:'red', to:'cover', text:'attached to' }, ...]) */
    set(list) { edgeData = list || []; drawEdges(); edgeGroup.visible = true; return this; },
    clear() { edgeData = []; empty(edgeGroup); return this; },
    refresh: drawEdges,
  });

  // ---- coordinate frames
  const axesGroup = group('axes');
  const triad = (len, name, tag) => {
    const g = new THREE.Group(); g.name = `axes:${name}`; g.matrixAutoUpdate = false;
    for (const [k, d] of [['x', [1, 0, 0]], ['y', [0, 1, 0]], ['z', [0, 0, 1]]]) {
      g.add(polyline([0, 0, 0, d[0] * len, d[1] * len, d[2] * len], lineMat(AXIS[k], 3.2, { depthTest: false })));
      const tip = new THREE.Mesh(new THREE.ConeGeometry(len * 0.055, len * 0.2, 12), new THREE.MeshBasicMaterial({ color: AXIS[k], depthTest: false, transparent: true }));
      tip.position.set(d[0] * len, d[1] * len, d[2] * len);
      tip.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(...d));
      tip.renderOrder = 20; g.add(tip);
    }
    g.add(css2d(dom('labrig-axis', esc(tag)), [0, 0, 0], [-0.25, -0.25]));
    g.traverse((o) => { if (o.isLine2) o.renderOrder = 20; });
    axesGroup.add(g);
    return g;
  };
  const frames = {
    world: { g: triad(0.2, 'world', 'world'), get: () => null },
    base: { g: triad(0.16, 'base', 'base'), get: () => robot.root.matrixWorld },
    camera: { g: triad(0.07, 'camera', 'camera'), get: () => _cam.fromArray(colMajor(robot.getCameraMatrix())) },
    tcp: { g: triad(0.08, 'tcp', 'TCP'), get: () => robot.tcp.matrixWorld },
  };
  const _cam = new THREE.Matrix4();
  const colMajor = (m) => [m[0], m[4], m[8], m[12], m[1], m[5], m[9], m[13], m[2], m[6], m[10], m[14], m[3], m[7], m[11], m[15]];
  onLayer(axesGroup);
  const axes = showHide(axesGroup, {
    /** show() shows all four; show(['tcp','camera']) shows a subset. */
    show(names) { axesGroup.visible = true; for (const [k, f] of Object.entries(frames)) f.g.visible = !names || names.includes(k); return this; },
    hide(names) { if (!names) axesGroup.visible = false; else for (const n of names) if (frames[n]) frames[n].g.visible = false; return this; },
  });

  // ---- wrist camera frustum
  const frustumGroup = group('frustum');
  frustumGroup.matrixAutoUpdate = false;
  const frMat = lineMat(0xE6EAEE, 1.6, { opacity: 0.85 });
  const frFill = new THREE.MeshBasicMaterial({ color: 0xFFB454, transparent: true, opacity: 0.07, side: THREE.DoubleSide, depthWrite: false });
  let frDepth = 0.42;
  const drawFrustum = () => {
    empty(frustumGroup);
    const K = robot.getIntrinsics();
    const corner = (u, v, d) => [((u - K.cx) / K.fx) * d, ((v - K.cy) / K.fy) * d, d];
    const n = K.near, f = frDepth;
    const c = [[-0.5, -0.5], [K.width - 0.5, -0.5], [K.width - 0.5, K.height - 0.5], [-0.5, K.height - 0.5]];
    const seg = [];
    for (let i = 0; i < 4; i++) {
      const a = corner(...c[i], f), b = corner(...c[(i + 1) % 4], f), an = corner(...c[i], n), bn = corner(...c[(i + 1) % 4], n);
      seg.push(0, 0, 0, ...a, ...a, ...b, ...an, ...bn);
    }
    frustumGroup.add(segments(seg, frMat));
    const quad = new THREE.BufferGeometry();
    const p = c.map((q) => corner(...q, f));
    quad.setAttribute('position', new THREE.Float32BufferAttribute([...p[0], ...p[1], ...p[2], ...p[0], ...p[2], ...p[3]], 3));
    frustumGroup.add(new THREE.Mesh(quad, frFill));
    onLayer(frustumGroup);
  };
  drawFrustum();
  const frustum = showHide(frustumGroup, {
    /** set({ depth }) changes how far the drawn pyramid reaches (metres along the optical axis). */
    set({ depth } = {}) { if (depth) frDepth = depth; drawFrustum(); return this; },
  });

  // ---- one pixel ray and its back-projected point
  const rayGroup = group('ray');
  const rayMat = lineMat(ACCENT, 2.6, { depthTest: false });
  const dot = (color, r = 0.005, depthTest = true) => new THREE.Mesh(new THREE.SphereGeometry(r, 16, 12), new THREE.MeshBasicMaterial({ color, depthTest, transparent: !depthTest }));
  const ray = showHide(rayGroup, {
    /** set({ origin:[3], point:[3], label? }) : camera centre and the back-projected world point. */
    set({ origin, point, label } = {}) {
      empty(rayGroup);
      if (!origin || !point) return this;
      rayGroup.add(polyline([...origin, ...point], rayMat));
      const d = dot(ACCENT, 0.0045, false); d.position.set(...point); d.renderOrder = 21; rayGroup.add(d);
      if (label) rayGroup.add(css2d(dom('labrig-edge', esc(label)), point, [0.5, 1.6]));
      onLayer(rayGroup); rayGroup.visible = true; return this;
    },
    clear() { empty(rayGroup); return this; },
  });

  // ---- point clouds
  const pointMats = new Set();
  const pointMaterial = (color, size, opacity) => {
    const m = new THREE.ShaderMaterial({
      uniforms: { uColor: { value: new THREE.Color(color) }, uSize: { value: size }, uScale: { value: 600 }, uOpacity: { value: opacity }, uUseVertex: { value: 0 } },
      vertexShader: 'uniform float uSize; uniform float uScale; uniform float uUseVertex; attribute vec3 color; varying vec3 vC; void main(){ vC = color; vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv; gl_PointSize = max(1.6, uSize * uScale / max(0.01, -mv.z)); }',
      fragmentShader: 'uniform vec3 uColor; uniform float uOpacity; uniform float uUseVertex; varying vec3 vC; void main(){ vec2 c = gl_PointCoord - 0.5; float r = dot(c, c); if (r > 0.25) discard; vec3 col = mix(uColor, vC, uUseVertex); gl_FragColor = vec4(col * (1.0 - 0.35 * smoothstep(0.08, 0.25, r)), uOpacity);\n#include <tonemapping_fragment>\n#include <colorspace_fragment>\n}',
      transparent: opacity < 1, depthWrite: opacity >= 1,
    });
    pointMats.add(m);
    return m;
  };
  const makeCloud = ({ positions, colors, color = 0xffffff, size = 0.0022, opacity = 1 }) => {
    const g = new THREE.BufferGeometry();
    const flat = toFlat(positions);
    g.setAttribute('position', new THREE.BufferAttribute(flat, 3));
    const m = pointMaterial(color, size, opacity);
    if (colors) { g.setAttribute('color', new THREE.BufferAttribute(toFlat(colors), 3)); m.uniforms.uUseVertex.value = 1; }
    else g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(flat.length), 3));
    const p = new THREE.Points(g, m); p.frustumCulled = false; p.layers.set(LAYER_OVERLAY);
    return p;
  };
  const colorOf = (key) => (partDefs.find((d) => d.key === key)?.color) ?? '#C9CED6';
  const cloudStore = (g, defaults) => {
    const items = new Map();
    return showHide(g, {
      /** set(key, { positions, colors?, color?, size?, opacity? }); positions: Float32Array | flat array | [[x,y,z],...] */
      set(key, data = {}) {
        const old = items.get(key);
        if (old) { g.remove(old); old.geometry.dispose(); pointMats.delete(old.material); old.material.dispose(); }
        const p = makeCloud({ color: colorOf(key), ...defaults, ...data });
        items.set(key, p); g.add(p); g.visible = true; return this;
      },
      clear(key) { for (const [k, p] of items) if (key === undefined || k === key) { g.remove(p); p.geometry.dispose(); pointMats.delete(p.material); p.material.dispose(); items.delete(k); } return this; },
      count: (key) => (items.get(key)?.geometry.attributes.position.count ?? 0),
    });
  };
  const clouds = cloudStore(group('clouds'), {});

  // ---- memory: assembled-state clouds (translucent) and ghost parts at their seats
  const memGroup = group('memory');
  const memClouds = new THREE.Group(); memGroup.add(memClouds); memClouds.visible = true;
  const memory = cloudStore(memClouds, { opacity: 0.45, size: 0.002 });
  const ghostGroup = new THREE.Group(); ghostGroup.visible = false; memGroup.add(ghostGroup);
  const ghostMat = (hex) => new THREE.MeshBasicMaterial({ color: hex, transparent: true, opacity: 0.22, depthWrite: false });
  for (const def of config.PARTS) {
    const m = new THREE.Mesh(parts.parts[def.key].mesh.geometry, ghostMat(def.color));
    const q = poseFor(config, def.key, 'seat');
    m.position.fromArray(q.position); m.quaternion.fromArray(q.quaternion);
    ghostGroup.add(m);
  }
  onLayer(ghostGroup);
  Object.assign(memory, {
    show() { memGroup.visible = true; memClouds.visible = true; return memory; },
    hide() { memGroup.visible = false; return memory; },
    /** Translucent parts at their assembled poses (from config). */
    ghost(on = true) { ghostGroup.visible = !!on; if (on) memGroup.visible = true; return memory; },
    object: memGroup,
  });

  // ---- ICP: moving source cloud, fixed target cloud, link between centroids
  const icpGroup = group('icp');
  const icpLink = lineMat(0xFFFFFF, 1.8, { dashed: true, depthTest: false, opacity: 0.9 });
  const centroid = (flat) => { const c = [0, 0, 0], n = flat.length / 3 || 1; for (let i = 0; i < flat.length; i += 3) { c[0] += flat[i]; c[1] += flat[i + 1]; c[2] += flat[i + 2]; } return c.map((v) => v / n); };
  const icp = showHide(icpGroup, {
    /** set({ key?, source, target, label? }): source = current (already transformed) cloud, target = memory cloud. */
    set({ key, source, target, color, label } = {}) {
      empty(icpGroup);
      const col = color ?? colorOf(key);
      const s = toFlat(source), t = toFlat(target);
      if (t.length) icpGroup.add(makeCloud({ positions: t, color: col, opacity: 0.35, size: 0.0019 }));
      if (s.length) icpGroup.add(makeCloud({ positions: s, color: 0xffffff, size: 0.0019 }));
      if (s.length && t.length) {
        const a = centroid(s), b = centroid(t);
        icpGroup.add(polyline([...a, ...b], icpLink));
        const da = dot(0xffffff, 0.004, false), db = dot(col, 0.004, false); da.position.set(...a); db.position.set(...b); icpGroup.add(da, db);
        if (label) icpGroup.add(css2d(dom('labrig-edge', esc(label)), a, [0.5, 1.7]));
      }
      onLayer(icpGroup); icpGroup.visible = true; return this;
    },
    clear() { empty(icpGroup); return this; },
  });

  // ---- Eq. (7) waypoints
  const wpGroup = group('waypoints');
  const wpLine = lineMat(0xE6EAEE, 2.2, { opacity: 0.95 }), wpDone = lineMat(ACCENT, 3, {});
  const waypoints = showHide(wpGroup, {
    /** set({ points:[[x,y,z] x n], index }): numbered balls and the path; `index` is the point being approached. */
    set({ points = [], index = -1 } = {}) {
      empty(wpGroup);
      if (!points.length) return this;
      const flat = toFlat(points);
      if (points.length > 1) wpGroup.add(polyline(flat, wpLine));
      if (index > 0) wpGroup.add(polyline(flat.subarray(0, Math.min(points.length, index + 1) * 3), wpDone));
      points.forEach((p, i) => {
        const d = dot(i === index ? ACCENT : i < index ? 0xFFB454 : 0xE6EAEE, i === index ? 0.0062 : 0.0046);
        d.position.set(p[0], p[1], p[2]); wpGroup.add(d);
        wpGroup.add(css2d(dom(`labrig-num${i === index ? ' on' : ''}`, String(i + 1)), [p[0], p[1], p[2]], [-0.45, 0.5]));
      });
      onLayer(wpGroup); wpGroup.visible = true; return this;
    },
    clear() { empty(wpGroup); return this; },
  });

  // ---- grasp pose: gate-shaped gripper glyph (two fingers, a bar and a stem), as in the bottom row of Fig. 7
  const graspGroup = group('grasp');
  const gSel = lineMat(GRASP_BLUE, 3.6, { depthTest: false }), gCand = lineMat(GRASP_BLUE, 1.6, { opacity: 0.5 });
  const glyph = (pose, width, mat, finger = 0.045, stem = 0.04) => {
    const w = (width ?? config.ROBOT.gripper.strokeMax) / 2;
    const l = segments([0, w, 0, 0, w, -finger, 0, -w, 0, 0, -w, -finger, 0, -w, -finger, 0, w, -finger, 0, 0, -finger, 0, 0, -finger - stem], mat);
    l.matrixAutoUpdate = false; poseToMatrix(pose, l.matrix); l.renderOrder = 19;
    return l;
  };
  const grasp = showHide(graspGroup, {
    /**
     * set({ pose, width, candidates:[{ pose, width }] }). A pose is the TCP frame (z = approach, y = closing axis):
     * { matrix:[16] } | { position, quaternion } | { p, x, z }.
     */
    set({ pose, matrix, position, quaternion, width, candidates = [] } = {}) {
      empty(graspGroup);
      for (const c of candidates) graspGroup.add(glyph(c.pose ?? c, c.width ?? width, gCand));
      const sel = pose ?? (matrix ? { matrix } : position ? { position, quaternion } : null);
      if (sel) graspGroup.add(glyph(sel, width, gSel));
      onLayer(graspGroup); graspGroup.visible = true; return this;
    },
    clear() { empty(graspGroup); return this; },
  });

  // ---- contact points
  const contactGroup = group('contacts');
  const cMat = lineMat(0xFFFFFF, 2, { depthTest: false });
  const contacts = showHide(contactGroup, {
    /** set([{ point:[3], normal?:[3], ok?:boolean }]) */
    set(list = []) {
      empty(contactGroup);
      for (const c of list) {
        const d = dot(c.ok === false ? 0xD7263D : 0x2EE6A6, 0.0032, false); d.position.set(...c.point); d.renderOrder = 22; contactGroup.add(d);
        if (c.normal) contactGroup.add(polyline([...c.point, c.point[0] + c.normal[0] * 0.022, c.point[1] + c.normal[1] * 0.022, c.point[2] + c.normal[2] * 0.022], cMat));
      }
      onLayer(contactGroup); contactGroup.visible = true; return this;
    },
    clear() { empty(contactGroup); return this; },
  });

  onLayer(root);
  const sizeV = new THREE.Vector2();
  function resize(w, h) { labelRenderer.setSize(w, h); }
  /** Called once per frame by the rig, after the joints and part poses are current. */
  function update() {
    robot.sync();
    if (axesGroup.visible) for (const f of Object.values(frames)) { const m = f.get(); if (m) f.g.matrix.copy(m); else f.g.matrix.identity(); }
    if (frustumGroup.visible) frustumGroup.matrix.fromArray(colMajor(robot.getCameraMatrix()));
    if (labelGroup.visible) followLabels();
    renderer.getDrawingBufferSize(sizeV);
    const scale = sizeV.y / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
    for (const m of pointMats) m.uniforms.uScale.value = scale;
    root.updateMatrixWorld(true);
    labelRenderer.render(scene, camera);
    if ((++declutterTick & 7) === 0) declutter();
  }
  // Labels that would sit on a HUD bar (camera buttons, status) or on an earlier label are hidden until they
  // come free. Earlier in the DOM wins: fixtures and parts first, then the camera and robot labels.
  let declutterTick = 0;
  function declutter() {
    const layer = labelRenderer.domElement;
    const els = [...layer.querySelectorAll('.labrig-label')].filter((el) => el.style.display !== 'none' && el.offsetParent !== null);
    if (!els.length) return;
    const hud = container.parentElement ? [...container.parentElement.querySelectorAll('.lab-hud > div')] : [];
    const placed = hud.map((h) => h.getBoundingClientRect()).filter((r) => r.width && r.height);
    for (const el of els) el.style.visibility = '';
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (!r.width) continue;
      const hit = placed.some((p) => r.left < p.right + 2 && r.right > p.left - 2 && r.top < p.bottom + 2 && r.bottom > p.top - 2);
      if (hit) el.style.visibility = 'hidden'; else placed.push(r);
    }
  }
  const all = { labels, edges, axes, frustum, ray, clouds, memory, icp, waypoints, grasp, contacts };
  return {
    ...all, root, labelRenderer, resize, update,
    hideAll() { for (const o of Object.values(all)) o.hide(); },
    clearAll() { for (const o of Object.values(all)) o.clear?.(); },
    dispose() {
      root.traverse((o) => { o.geometry?.dispose(); if (o.isCSS2DObject) o.element.remove(); });
      for (const m of lineMats) m.dispose(); for (const m of pointMats) m.dispose();
      scene.remove(root); labelRenderer.domElement.remove(); style.remove();
    },
  };
}
