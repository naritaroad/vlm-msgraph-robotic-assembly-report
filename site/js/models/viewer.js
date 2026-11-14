// viewer.js — a small orbit viewer for the models in products.js.
//
//   const v = await createModelViewer(container, { model: 'product1', onPick, reducedMotion });
//   v.setModel(id) · v.explode(t) · v.toggleExplode() · v.reset() · v.pick(key) · v.resize() · v.dispose()
//
// The picture is transparent, so the page colour shows through in both themes. Lighting is a PMREM RoomEnvironment
// plus one key light with soft shadows; the model stands on a shadow catcher with a baked radial contact shadow.
//
// One WebGL2 context serves every viewer on the page. Each viewer owns a plain canvas and the shared renderer
// draws into it on demand (visible, and something changed), then copies the frame across. Eight viewers therefore
// cost one drawing buffer, one environment map and one shadow map instead of eight of each, and the page stays
// clear of the browser's limit on live WebGL contexts. Pass { dedicated: true } to give a viewer its own WebGL
// canvas instead.
//
// Nothing global is exposed and the only DOM this module adds is the canvas. Buttons and captions belong to the caller.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { getModel } from './products.js';

const EXPLODE_MS = 700;
const MAX_DPR = 2;
const MAX_PIXELS = 1.5e6;                 // per viewer; keeps the shared drawing buffer small on large screens
const SHADOW_SIZE = 1024;
const FOV = 26;
const FIT_MARGIN = 1.06;
const KEY_DIR = new THREE.Vector3(-0.52, 1.0, 0.6).normalize();
const RIM_DIR = new THREE.Vector3(0.7, 0.45, -0.8).normalize();

const THEMES = {
  light: { env: 0.78, key: 2.1, rim: 0.5, shadow: 0.24, contact: 0.3, floor: 0x6f84a8, floorAlpha: 0.13, dim: 0xc3ccd9 },
  dark: { env: 0.7, key: 2.2, rim: 1.2, shadow: 0.5, contact: 0.5, floor: 0x8fb0f0, floorAlpha: 0.11, dim: 0x27324a },
};
const pageTheme = () => (document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light');
const easeInOut = (x) => (x < 0.5 ? 4 * x * x * x : 1 - Math.pow(-2 * x + 2, 3) / 2);
const clamp01 = (x) => Math.max(0, Math.min(1, x));
const DEG2RAD = Math.PI / 180;

// ------------------------------------------------------------------ materials

const NOISE_GLSL = /* glsl */`
float mvHash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float mvNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mvHash(i), mvHash(i + vec3(1,0,0)), f.x), mix(mvHash(i + vec3(0,1,0)), mvHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(mvHash(i + vec3(0,0,1)), mvHash(i + vec3(1,0,1)), f.x), mix(mvHash(i + vec3(0,1,1)), mvHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

/** A faint object-space roughness variation: moulded plastic and paint are never perfectly even. */
function grain(mat, amount = 0.1, fine = 1300, coarse = 110) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMvObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvMvObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vMvObj;\n${NOISE_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (mvNoise(vMvObj * ${fine.toFixed(1)}) - 0.5) * ${amount.toFixed(3)} + (mvNoise(vMvObj * ${coarse.toFixed(1)}) - 0.5) * ${(amount * 0.8).toFixed(3)}, 0.05, 1.0);`);
  };
  mat.customProgramCacheKey = () => `mvGrain:${amount}:${fine}:${coarse}`;
  return mat;
}

/**
 * The material library handed to part.build(THREE, lib). Every call returns a new material, so a part can be
 * highlighted without touching its neighbours (three still shares the compiled programs).
 * kinds: plastic · paint · metal · steel · aluminium · rubber
 */
export function createMaterialLib() {
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  return {
    material(kind = 'plastic', color = '#c8ccd2', o = {}) {
      const c = new THREE.Color(color);
      switch (kind) {
        case 'paint': return grain(P({ color: c, metalness: 0.42, roughness: 0.44, clearcoat: 0.4, clearcoatRoughness: 0.28, ...o }), 0.06);
        case 'metal': return grain(P({ color: c, metalness: 0.82, roughness: 0.36, ...o }), 0.06, 2200, 160);
        case 'steel': return grain(P({ color: c, metalness: 1, roughness: 0.3, ...o }), 0.05, 2200, 160);
        case 'aluminium': return grain(P({ color: c, metalness: 0.9, roughness: 0.46, ...o }), 0.1, 1800, 90);
        case 'rubber': return P({ color: c, metalness: 0, roughness: 0.9, ...o });
        default: return grain(P({ color: c, metalness: 0, roughness: 0.4, clearcoat: 0.6, clearcoatRoughness: 0.2, ...o }), 0.12);
      }
    },
  };
}

// ------------------------------------------------------------------ the shared stage: renderer, lights, ground

function radialTexture(stops) {
  const s = 256, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  for (const [at, rgba] of stops) grad.addColorStop(at, rgba);
  g.fillStyle = grad; g.fillRect(0, 0, s, s);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

let sharedStage = null;

class Stage {
  constructor(dedicated) {
    this.dedicated = dedicated;
    const canvas = document.createElement('canvas');
    let gl = null;
    try { gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true, depth: true, stencil: false, powerPreference: 'high-performance' }); } catch { gl = null; }
    if (!gl) throw new Error('createModelViewer: WebGL2 is not available');
    this.canvas = canvas;
    const renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: true, antialias: true, premultipliedAlpha: true });
    renderer.setPixelRatio(1);                         // sizes are handled in device pixels by the viewers
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.86;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.setClearColor(0x000000, 0);
    this.renderer = renderer;
    this.W = 0; this.H = 0;
    this.lost = false;
    this.viewers = new Set();

    const scene = new THREE.Scene();
    this.scene = scene;
    this.buildEnvironment();

    const key = new THREE.DirectionalLight(0xfff6ea, 2.3);
    key.castShadow = true;
    key.shadow.mapSize.set(SHADOW_SIZE, SHADOW_SIZE);
    key.shadow.radius = 5;
    key.shadow.bias = -0.0005;
    const rim = new THREE.DirectionalLight(0xa8c6ff, 0.6);
    scene.add(key, key.target, rim, rim.target);
    this.key = key; this.rim = rim;

    // ground: a soft disc so the model stands on something, a baked contact shadow, and the shadow catcher
    const plane = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    const soft = radialTexture([[0, 'rgba(255,255,255,1)'], [0.35, 'rgba(255,255,255,0.78)'], [0.7, 'rgba(255,255,255,0.22)'], [1, 'rgba(255,255,255,0)']]);
    const blob = radialTexture([[0, 'rgba(0,0,0,1)'], [0.4, 'rgba(0,0,0,0.62)'], [0.75, 'rgba(0,0,0,0.14)'], [1, 'rgba(0,0,0,0)']]);
    const basic = (map) => new THREE.MeshBasicMaterial({ map, transparent: true, depthWrite: false, toneMapped: false });
    this.floor = new THREE.Mesh(plane, basic(soft));
    this.contact = new THREE.Mesh(plane, basic(blob));
    this.catcher = new THREE.Mesh(plane, new THREE.ShadowMaterial({ opacity: 0.25, depthWrite: false }));
    this.catcher.receiveShadow = true;
    this.floor.renderOrder = -3; this.contact.renderOrder = -2; this.catcher.renderOrder = -1;
    scene.add(this.floor, this.contact, this.catcher);
    this.slot = new THREE.Group();
    scene.add(this.slot);

    // Context loss: let go of every GPU object now, while deleting is a silent no-op. three forgets them on restore
    // anyway, and a later dispose() would otherwise try to delete objects of the dead context. The JS-side data
    // stays, so geometry, textures and programs are simply uploaded again on the first frame after restore.
    this.onLost = (e) => {
      e.preventDefault();
      this.lost = true;
      this.scene.environment?.dispose(); this.scene.environment = null;
      this.key.shadow.map?.dispose(); this.key.shadow.map = null;
      this.floor.geometry.dispose();
      this.floor.material.map.dispose(); this.contact.material.map.dispose();
      for (const v of this.viewers) v.contextLost();
    };
    this.onRestored = () => {
      this.lost = false;
      this.buildEnvironment();
      this.W = 0; this.H = 0;
      for (const v of this.viewers) v.invalidate();
    };
    canvas.addEventListener('webglcontextlost', this.onLost);
    canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.themeWatch = new MutationObserver(() => { for (const v of this.viewers) v.invalidate(); });
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }

  buildEnvironment() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    const room = new RoomEnvironment();
    this.scene.environment?.dispose();
    this.scene.environment = pmrem.fromScene(room, 0.035).texture;
    room.dispose?.();
    pmrem.dispose();
  }

  /** Draw one viewer. `v` supplies root, camera, pixel size, theme and the frame of the model at its current pose. */
  render(v) {
    if (this.lost) return false;
    const w = v.pxW, h = v.pxH;
    if (w < 2 || h < 2) return false;
    const r = this.renderer;
    if (this.dedicated) {
      if (w !== this.W || h !== this.H) { this.W = w; this.H = h; r.setSize(w, h, false); }
    } else if (w > this.W || h > this.H) {
      this.W = Math.max(this.W, w); this.H = Math.max(this.H, h);
      r.setSize(this.W, this.H, false);
    }
    const th = THEMES[v.theme] ?? THEMES.light, f = v.frame, R = Math.max(f.radius, 1e-4);
    this.scene.environmentIntensity = th.env;
    this.key.intensity = th.key; this.rim.intensity = th.rim;
    this.key.position.set(f.cx, f.cy, f.cz).addScaledVector(KEY_DIR, R * 4);
    this.key.target.position.set(f.cx, f.cy, f.cz);
    this.rim.position.set(f.cx, f.cy, f.cz).addScaledVector(RIM_DIR, R * 4);
    this.rim.target.position.set(f.cx, f.cy, f.cz);
    const sc = this.key.shadow.camera;
    sc.left = -R * 1.25; sc.right = R * 1.25; sc.top = R * 1.25; sc.bottom = -R * 1.25; sc.near = R * 1.5; sc.far = R * 7;
    sc.updateProjectionMatrix();
    this.key.shadow.normalBias = R * 0.008;
    const fr = Math.max(f.fx, f.fz);
    this.floor.position.set(f.cx, 0, f.cz); this.floor.scale.set(fr * 4.4, 1, fr * 4.4);
    this.floor.material.color.setHex(th.floor); this.floor.material.opacity = th.floorAlpha;
    this.contact.position.set(f.cx, 0, f.cz); this.contact.scale.set(f.fx * 2.7, 1, f.fz * 2.7);
    this.contact.material.opacity = th.contact * (1 - 0.45 * f.spread);
    this.catcher.position.set(f.cx, 0, f.cz); this.catcher.scale.set(R * 14, 1, R * 14);
    this.catcher.material.opacity = th.shadow;

    this.slot.add(v.root);
    r.setViewport(0, 0, w, h);
    r.setScissor(0, 0, w, h);
    r.setScissorTest(true);
    r.render(this.scene, v.camera);
    this.slot.remove(v.root);
    if (v.ctx) {
      v.ctx.clearRect(0, 0, w, h);
      v.ctx.drawImage(this.canvas, 0, this.H - h, w, h, 0, 0, w, h);
    }
    return true;
  }

  release(v) {
    this.viewers.delete(v);
    if (this.viewers.size) return;
    this.themeWatch.disconnect();
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    for (const m of [this.floor, this.contact]) { m.material.map?.dispose(); m.material.dispose(); }
    this.catcher.material.dispose();
    this.floor.geometry.dispose();
    this.key.shadow.map?.dispose();
    this.scene.environment?.dispose();
    this.renderer.dispose();
    if (!this.dedicated) this.renderer.forceContextLoss?.();
    if (sharedStage === this) sharedStage = null;
  }
}

// ------------------------------------------------------------------ the viewer

/**
 * @param {HTMLElement} container  an element with a definite size; the canvas fills it
 * @param {object} opts
 *   model          id from products.js, or a model object of the same shape
 *   onPick         called with { key, label, name, triples, keys } after a part is picked, and with null when cleared
 *   reducedMotion  true: explode and reset jump instead of animating (default: the user's system setting)
 *   theme          'light' | 'dark' to pin the lighting; default follows html[data-theme]
 *   dedicated      true: this viewer gets its own WebGL canvas instead of sharing one context
 *   touchAction    CSS touch-action for the canvas (default 'pan-y', so a vertical swipe still scrolls the page)
 * Throws when WebGL2 is missing, so the caller can show a fallback.
 */
export async function createModelViewer(container, opts = {}) {
  if (!container) throw new Error('createModelViewer: container is required');
  const { onPick = null, dedicated = false } = opts;
  const reduced = opts.reducedMotion ?? window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const stage = dedicated ? new Stage(true) : (sharedStage ??= new Stage(false));

  const canvas = dedicated ? stage.canvas : document.createElement('canvas');
  const ctx = dedicated ? null : canvas.getContext('2d');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
  canvas.tabIndex = 0;
  canvas.setAttribute('role', 'img');
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  container.append(canvas);

  const lib = createMaterialLib();
  const root = new THREE.Group();
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.01, 50);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.09;
  controls.rotateSpeed = 0.9;
  controls.zoomSpeed = 0.9;
  controls.screenSpacePanning = true;
  controls.autoRotate = false;
  controls.enableZoom = false;                       // the wheel belongs to the page until the viewer is grabbed
  controls.minPolarAngle = 0.05;
  controls.maxPolarAngle = Math.PI * 0.94;
  controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_ROTATE };
  canvas.style.touchAction = opts.touchAction ?? 'pan-y';

  let model = null, parts = [], pickables = [];
  let t = 0, goal = 0, anim = null;
  let hovered = null, selected = null;               // group names
  let visible = false, disposed = false, dirty = true, raf = 0, inTick = false, idle = 0, frames = 0;
  let fitA = null, fitE = null;                      // corner clouds of the two end states
  const view = { root, camera, ctx, pxW: 0, pxH: 0, theme: 'light', frame: { cx: 0, cy: 0, cz: 0, radius: 1, fx: 1, fz: 1, spread: 0 }, invalidate: () => wake() };
  view.contextLost = () => { for (const o of pickables) o.geometry.dispose(); };
  stage.viewers.add(view);

  const v3 = new THREE.Vector3(), v3b = new THREE.Vector3(), q4 = new THREE.Quaternion();
  const basis = { right: new THREE.Vector3(), up: new THREE.Vector3(), back: new THREE.Vector3() };

  // ---- frame of the model at pose t: all part bounding-box corners, their centre, radius and footprint
  function cloud(tt) {
    const pts = [], box = new THREE.Box3();
    for (const p of parts) {
      v3.lerpVectors(p.pa, p.pe, tt); q4.slerpQuaternions(p.qa, p.qe, tt);
      for (const c of p.corners) { const w = c.clone().applyQuaternion(q4).add(v3); pts.push(w); box.expandByPoint(w); }
    }
    const center = box.getCenter(new THREE.Vector3());
    let radius = 0;
    for (const w of pts) radius = Math.max(radius, w.distanceTo(center));
    return { pts, center, radius, fx: (box.max.x - box.min.x) / 2, fz: (box.max.z - box.min.z) / 2 };
  }
  const mix = (a, b, k) => a + (b - a) * k;
  function frameAt(tt) {
    const e = tt;
    return {
      center: v3b.lerpVectors(fitA.center, fitE.center, e).clone(),
      radius: mix(fitA.radius, fitE.radius, e), fx: mix(fitA.fx, fitE.fx, e), fz: mix(fitA.fz, fitE.fz, e),
    };
  }
  function setBasis(back) {
    basis.back.copy(back).normalize();
    basis.right.crossVectors(camera.up, basis.back);
    if (basis.right.lengthSq() < 1e-8) basis.right.set(1, 0, 0);
    basis.right.normalize();
    basis.up.crossVectors(basis.back, basis.right).normalize();
  }
  /** Camera distance at which the corner cloud of pose tt just fills the view, looking along -back at `center`. */
  function fitDistance(tt, center) {
    const tanV = Math.tan((camera.fov * DEG2RAD) / 2), tanH = tanV * camera.aspect;
    const c = tt <= 0 ? fitA : tt >= 1 ? fitE : cloud(tt);
    let d = 0;
    for (const p of c.pts) {
      v3.subVectors(p, center);
      const x = Math.abs(v3.dot(basis.right)), y = Math.abs(v3.dot(basis.up)), z = v3.dot(basis.back);
      d = Math.max(d, z + x / tanH, z + y / tanV);
    }
    return d * FIT_MARGIN;
  }
  function updateFrame() {
    const f = frameAt(t);
    Object.assign(view.frame, { cx: f.center.x, cy: f.center.y, cz: f.center.z, radius: f.radius, fx: f.fx, fz: f.fz, spread: t });
  }
  function limits() {
    setBasis(v3.subVectors(camera.position, controls.target));
    const f = frameAt(t), d = fitDistance(t, f.center);
    controls.minDistance = d * 0.3;
    controls.maxDistance = d * 2.4;
    controls.cursor.copy(f.center);
    controls.maxTargetRadius = f.radius * 0.9;
    const far = Math.max(fitA.radius, fitE.radius);
    camera.near = Math.max(1e-4, far * 0.04);
    camera.far = far * 60;
    camera.updateProjectionMatrix();
  }
  function frameDefault() {
    const dir = model.view?.dir ?? [0.5, 0.5, 1];
    setBasis(v3.set(dir[0], dir[1], dir[2]));
    const f = frameAt(t);
    controls.target.copy(f.center);
    camera.position.copy(f.center).addScaledVector(basis.back, fitDistance(t, f.center));
    camera.lookAt(f.center);
    limits();
    controls.update();
  }

  // ---- poses
  function applyPose(tt, follow) {
    let k = 1, pan = null, f0 = null;
    if (follow) {                                    // keep the user's zoom and pan relative to the growing model
      f0 = frameAt(t);
      setBasis(v3.subVectors(camera.position, controls.target));
      k = camera.position.distanceTo(controls.target) / fitDistance(t, f0.center);
      pan = controls.target.clone().sub(f0.center);
    }
    t = tt;
    for (const p of parts) {
      p.holder.position.lerpVectors(p.pa, p.pe, t);
      p.holder.quaternion.slerpQuaternions(p.qa, p.qe, t);
    }
    updateFrame();
    if (follow) {
      const f1 = frameAt(t), d = fitDistance(t, f1.center) * k;
      controls.minDistance = 0; controls.maxDistance = Infinity; controls.maxTargetRadius = Infinity;
      controls.target.copy(f1.center).add(pan);
      camera.position.copy(controls.target).addScaledVector(basis.back, d);
    }
  }

  // ---- highlight
  const tmpC = new THREE.Color();
  function paint() {
    const th = THEMES[view.theme] ?? THEMES.light;
    for (const p of parts) {
      const sel = selected !== null && p.group === selected, hov = hovered !== null && p.group === hovered;
      const dim = selected !== null && !sel;
      for (const m of p.materials) {
        const b = m.userData.base;
        m.color.copy(b.color);
        if (dim) m.color.lerp(tmpC.setHex(th.dim), 0.46);
        m.emissive.copy(b.color).multiplyScalar(sel ? 0.2 : hov ? 0.11 : 0);
        m.envMapIntensity = b.env * (dim ? 0.7 : sel ? 1.15 : 1);
        if ('clearcoat' in m) m.clearcoat = b.clearcoat * (dim ? 0.4 : 1);
      }
    }
    wake();
  }
  const partByKey = (key) => parts.find((p) => p.def.key === key) ?? null;
  function describe(p) {
    const keys = parts.filter((x) => x.group === p.group).map((x) => x.def.key);
    return { key: p.def.key, label: p.def.label, name: p.def.name, triples: (p.def.triples ?? []).slice(), keys };
  }
  function select(p, notify) {
    const g = p ? p.group : null;
    const changed = g !== selected;
    selected = g;
    paint();
    if (notify && (changed || p) && typeof onPick === 'function') onPick(p ? describe(p) : null);
  }

  // ---- pointer: hover, click to pick, wheel only after the viewer has been grabbed
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function partAt(ev) {
    const r = canvas.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    root.updateMatrixWorld(true);
    camera.updateMatrixWorld();
    ray.setFromCamera(ndc, camera);
    const hits = ray.intersectObjects(pickables, false);
    return hits.length ? hits[0].object.userData.part : null;
  }
  let down = null, hoverEv = null, hoverRaf = 0;
  const onDown = (ev) => { down = { x: ev.clientX, y: ev.clientY, time: performance.now(), id: ev.pointerId }; controls.enableZoom = true; };
  const onUp = (ev) => {
    if (!down || down.id !== ev.pointerId) return;
    const moved = Math.hypot(ev.clientX - down.x, ev.clientY - down.y), dt = performance.now() - down.time;
    down = null;
    if (moved < 6 && dt < 600) select(partAt(ev), true);
  };
  const onMove = (ev) => {
    if (ev.buttons || ev.pointerType === 'touch') return;
    hoverEv = ev;
    if (hoverRaf) return;
    hoverRaf = requestAnimationFrame(() => {
      hoverRaf = 0;
      if (disposed || !hoverEv) return;
      const p = partAt(hoverEv), g = p ? p.group : null;
      canvas.style.cursor = p ? 'pointer' : 'grab';
      if (g !== hovered) { hovered = g; paint(); }
    });
  };
  const onLeave = () => { hoverEv = null; controls.enableZoom = false; if (hovered !== null) { hovered = null; paint(); } };
  const onKey = (ev) => {
    const step = { ArrowLeft: [-0.14, 0], ArrowRight: [0.14, 0], ArrowUp: [0, -0.1], ArrowDown: [0, 0.1] }[ev.key];
    if (step) {
      const s = new THREE.Spherical().setFromVector3(v3.subVectors(camera.position, controls.target));
      s.theta += step[0]; s.phi = Math.max(controls.minPolarAngle, Math.min(controls.maxPolarAngle, s.phi + step[1]));
      camera.position.copy(controls.target).add(v3.setFromSpherical(s));
    } else if (ev.key === '+' || ev.key === '=' || ev.key === '-') {
      const d = camera.position.distanceTo(controls.target) * (ev.key === '-' ? 1.12 : 1 / 1.12);
      v3.subVectors(camera.position, controls.target).setLength(Math.max(controls.minDistance, Math.min(controls.maxDistance, d)));
      camera.position.copy(controls.target).add(v3);
    } else if (ev.key === 'e' || ev.key === 'E') { toggleExplode(); return; }
    else if (ev.key === 'Home') { reset(); return; }
    else if (ev.key === 'Escape' && selected !== null) { select(null, true); return; }
    else return;
    ev.preventDefault();
    wake();
  };
  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointerup', onUp);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerleave', onLeave);
  canvas.addEventListener('keydown', onKey);
  controls.addEventListener('change', () => wake());

  // ---- on-demand rendering
  function wake() {
    dirty = true;
    if (!raf && !inTick && visible && !disposed && !document.hidden) raf = requestAnimationFrame(tick);
  }
  function tick(now) {
    raf = 0;
    if (disposed || !visible || document.hidden) return;
    inTick = true;
    let active = false;
    if (anim) {
      const u = clamp01((now - anim.t0) / anim.dur);
      applyPose(mix(anim.from, anim.to, easeInOut(u)), true);
      dirty = true; active = true;
      if (u >= 1) { const done = anim.resolve; anim = null; limits(); done(); }
    }
    if (controls.update()) dirty = true;
    if (dirty) {
      dirty = false; idle = 0;
      const th = opts.theme ?? pageTheme();
      if (th !== view.theme) { view.theme = th; paint(); dirty = false; }
      if (stage.render(view)) frames++;
      active = true;
    } else idle++;
    inTick = false;
    if (active || idle < 3) raf = requestAnimationFrame(tick);
  }

  // ---- size
  function resize() {
    const w = container.clientWidth, h = container.clientHeight;
    if (!w || !h) return;
    let dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    if (w * h * dpr * dpr > MAX_PIXELS) dpr = Math.sqrt(MAX_PIXELS / (w * h));
    const pw = Math.max(2, Math.round(w * dpr)), ph = Math.max(2, Math.round(h * dpr));
    if (pw === view.pxW && ph === view.pxH) return;
    let k = null, f = null;
    if (model && view.pxW) {                           // keep the framing when the aspect changes
      f = frameAt(t);
      setBasis(v3.subVectors(camera.position, controls.target));
      k = camera.position.distanceTo(controls.target) / fitDistance(t, f.center);
    }
    view.pxW = pw; view.pxH = ph;
    if (!dedicated) { canvas.width = pw; canvas.height = ph; }
    camera.aspect = pw / ph;
    camera.updateProjectionMatrix();
    if (model) {
      if (k === null) frameDefault();
      else {
        controls.minDistance = 0; controls.maxDistance = Infinity;
        camera.position.copy(controls.target).addScaledVector(basis.back, fitDistance(t, f.center) * k);
        limits();
      }
    }
    wake();
  }
  const ro = new ResizeObserver(() => resize());
  ro.observe(container);
  const io = new IntersectionObserver((es) => { visible = es[es.length - 1].isIntersecting; if (visible) wake(); }, { rootMargin: '120px' });
  io.observe(container);
  const onVisibility = () => { if (!document.hidden) wake(); };
  const onWindowResize = () => resize();
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('resize', onWindowResize);

  // ---- model
  function clearModel() {
    for (const p of parts) {
      p.holder.traverse((o) => { if (o.isMesh) o.geometry.dispose(); });
      for (const m of p.materials) m.dispose();
      root.remove(p.holder);
    }
    parts = []; pickables = []; hovered = null; selected = null; anim?.resolve(); anim = null;
  }
  async function setModel(id) {
    const next = getModel(id);
    clearModel();
    model = next;
    for (const def of model.parts) {
      const object = def.build(THREE, lib);
      const holder = new THREE.Group();
      holder.name = `part:${def.key}`;
      holder.add(object);
      const p = {
        def, holder, group: def.group ?? def.key, materials: [], corners: [],
        pa: new THREE.Vector3().fromArray(def.assembled.position), qa: new THREE.Quaternion().fromArray(def.assembled.quaternion ?? [0, 0, 0, 1]),
        pe: new THREE.Vector3().fromArray(def.exploded.position), qe: new THREE.Quaternion().fromArray(def.exploded.quaternion ?? [0, 0, 0, 1]),
      };
      holder.updateMatrixWorld(true);
      const bb = new THREE.Box3().setFromObject(holder);
      for (let i = 0; i < 8; i++) p.corners.push(new THREE.Vector3(i & 1 ? bb.max.x : bb.min.x, i & 2 ? bb.max.y : bb.min.y, i & 4 ? bb.max.z : bb.min.z));
      holder.traverse((o) => {
        if (!o.isMesh) return;
        o.userData.part = p;
        pickables.push(o);
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
          if (p.materials.includes(m)) continue;
          m.userData.base = { color: m.color.clone(), env: m.envMapIntensity ?? 1, clearcoat: m.clearcoat ?? 0 };
          p.materials.push(m);
        }
      });
      root.add(holder);
      parts.push(p);
    }
    fitA = cloud(0); fitE = cloud(1);
    t = 0; goal = 0;
    applyPose(0, false);
    canvas.setAttribute('aria-label', `${model.title?.en ?? model.id}: interactive 3D model`);
    view.theme = opts.theme ?? pageTheme();
    if (view.pxW) frameDefault(); else resize();
    paint();
    return handle;
  }

  // ---- public actions
  function explode(target = 1, { instant = false } = {}) {
    goal = clamp01(Number(target) || 0);
    anim?.resolve(); anim = null;
    if (!model) return Promise.resolve();
    if (reduced || instant || !visible || Math.abs(goal - t) < 1e-4) { applyPose(goal, true); limits(); wake(); return Promise.resolve(); }
    return new Promise((resolve) => {
      anim = { from: t, to: goal, t0: performance.now(), dur: EXPLODE_MS * Math.max(0.4, Math.abs(goal - t)), resolve };
      wake();
    });
  }
  function toggleExplode() { return explode(goal > 0.5 ? 0 : 1); }
  function reset() {
    select(null, true);
    anim?.resolve(); anim = null;
    goal = 0;
    applyPose(0, false);
    if (model) frameDefault();
    wake();
  }
  function pick(key, { silent = false } = {}) {
    const p = key == null ? null : partByKey(key);
    if (key != null && !p) throw new Error(`viewer.pick: unknown part "${key}"`);
    select(p, !silent);
  }
  function info() {
    let triangles = 0;
    for (const o of pickables) triangles += (o.geometry.index ? o.geometry.index.count : o.geometry.attributes.position.count) / 3;
    const mem = stage.renderer.info.memory;
    return {
      model: model?.id ?? null, parts: parts.length, meshes: pickables.length, triangles, explode: t, selected, frames, visible,
      pixels: [view.pxW, view.pxH], buffer: [stage.W, stage.H], gpu: { geometries: mem.geometries, textures: mem.textures }, contextLost: stage.lost,
    };
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    if (raf) cancelAnimationFrame(raf);
    if (hoverRaf) cancelAnimationFrame(hoverRaf);
    ro.disconnect(); io.disconnect();
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('resize', onWindowResize);
    canvas.removeEventListener('pointerdown', onDown);
    canvas.removeEventListener('pointerup', onUp);
    canvas.removeEventListener('pointermove', onMove);
    canvas.removeEventListener('pointerleave', onLeave);
    canvas.removeEventListener('keydown', onKey);
    controls.dispose();
    clearModel();
    canvas.remove();
    stage.release(view);
  }

  const handle = {
    setModel, explode, toggleExplode, reset, pick, dispose, resize, info,
    get model() { return model; },
    /** Camera eye and orbit target, for tools that copy one viewer's view to another. */
    getView() { return { p: camera.position.toArray(), t: controls.target.toArray() }; },
    setView(v) {
      if (!v || !Array.isArray(v.p) || !Array.isArray(v.t)) return;
      camera.position.fromArray(v.p); controls.target.fromArray(v.t); controls.update(); wake();
    },
    /** Key of the picked part (its group), or null. */
    get picked() { return selected === null ? null : (parts.find((p) => p.group === selected)?.def.key ?? null); },
    get canvas() { return canvas; },
    /** The WebGL canvas behind this viewer (shared unless `dedicated`). For tests of context loss. */
    get glCanvas() { return stage.canvas; },
  };

  resize();
  if (opts.model != null) await setModel(opts.model);
  return handle;
}
