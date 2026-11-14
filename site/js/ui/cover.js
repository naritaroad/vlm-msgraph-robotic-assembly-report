// cover.js — the 3D loop on the cover: the xArm6 waves, then puts the four gears and the nut on the cover plate,
// the gears turn once, and it starts over.
//
// This is a scripted animation, not the lab: no physics and no perception. It reuses the lab's arm meshes, part
// geometry and kinematics (inverse kinematics for every key pose), on a transparent canvas so the page's own
// background shows through in both themes. It runs only while the cover is on screen.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import * as config from '../lab/config.js';
import * as kin from '../lab/kinematics.js';
import { createRobot } from '../lab/robot.js';
import { createParts, poseFor, gearRadii } from '../lab/parts.js';
import { layout } from '../lab/world.js';

const ease = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * t * (t * (6 * t - 15) + 10));     // quintic
const lerp = (a, b, t) => a + (b - a) * t;
const lerpQ = (a, b, t) => a.map((v, i) => lerp(v, b[i], t));

function materials() {
  const P = (o) => new THREE.MeshPhysicalMaterial(o), S = (o) => new THREE.MeshStandardMaterial(o);
  const dark = S({ color: 0x2b2f36, roughness: 0.55, metalness: 0.3 });
  const base = {
    armWhite: P({ color: 0xf1f1ee, roughness: 0.32, clearcoat: 0.7, clearcoatRoughness: 0.14 }),
    armDark: S({ color: 0x2a2d33, roughness: 0.5, metalness: 0.4 }),
    armRing: S({ color: 0x565a60, roughness: 0.3, metalness: 1 }),
    aluminium: S({ color: 0xb9bdc4, roughness: 0.34, metalness: 1 }),
    gripperBody: P({ color: 0x54585f, roughness: 0.5, metalness: 0.25, clearcoat: 0.25 }),
    gripperBlack: S({ color: 0x1b1d21, roughness: 0.6 }),
    lensGlass: P({ color: 0x05060a, roughness: 0.04, clearcoat: 1 }),
    coverPlastic: P({ color: 0xe9e7e1, roughness: 0.5, clearcoat: 0.12 }),
    polishedSteel: S({ color: 0xd2d5d9, roughness: 0.16, metalness: 1 }),
    gearPlastic: (hex) => P({ color: new THREE.Color(hex), roughness: 0.36, clearcoat: 0.45, clearcoatRoughness: 0.28 }),
    nutPlastic: (hex) => P({ color: new THREE.Color(hex), roughness: 0.4, clearcoat: 0.3 }),
    led: (hex, k = 1) => new THREE.MeshStandardMaterial({ color: 0x000000, emissive: hex, emissiveIntensity: k }),
  };
  return new Proxy(base, { get: (t, k) => (k in t ? t[k] : dark) });
}

export async function createCover({ bus } = {}) {
  const host = document.getElementById('cover-3d');
  const section = document.getElementById('cover');
  if (!host || !section) return null;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fail = () => { host.classList.add('is-fallback'); return null; };

  let renderer;
  try {
    const probe = document.createElement('canvas');
    if (!probe.getContext('webgl2')) return fail();
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
  } catch { return fail(); }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;   // PCFSoftShadowMap is deprecated in r186
  renderer.setClearColor(0x000000, 0);
  host.append(renderer.domElement);

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environmentIntensity = 0.85;

  const key = new THREE.DirectionalLight(0xffffff, 2.6);
  key.position.set(-0.6, 2.6, 1.6);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -1, right: 1, top: 1, bottom: -1, near: 0.5, far: 6 });
  key.shadow.bias = -0.0004; key.shadow.normalBias = 0.01; key.shadow.radius = 4;
  key.target.position.set(0.35, 0.74, 0.1);
  scene.add(key, key.target);
  const rim = new THREE.DirectionalLight(0x9cc3ff, 1.1);
  rim.position.set(1.8, 1.4, -1.6);
  scene.add(rim);

  // ── the workbench under the parts; the arm stands on the lab's wheeled base beside it. Heights follow the lab and
  //    §4.2 (arm base on the chassis at 0.52 m, worktop at 0.74 m), so the arm reaches up onto the table as in the paper's
  //    setup. The bench ends at x = 0.44, just short of the chassis (which starts at x ≈ 0.47); no shelf or pegboard behind
  //    it, so the raised arm never passes through anything while it waves. ──
  const T = config.TABLE, R = config.ROBOT;
  const stoneMat = new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0.35 });
  let bench = null;
  try {
    const m = await import(new URL('../models/labbench.js', import.meta.url).href);
    bench = m.buildLabBench(THREE, { theme: document.documentElement.dataset.theme, back: false, x: [-0.5, 0.44] });
  } catch (e) { bench = null; }
  if (!bench) {                                           // fallback: a plain slab with rounded edges
    bench = new THREE.Group();
    const slab = new THREE.Mesh(new RoundedBoxGeometry(0.92, 0.05, 0.72, 4, 0.02), stoneMat);
    slab.position.set(0.16, T.topY - 0.025, 0.06);
    slab.receiveShadow = true;
    bench.add(slab);
  }
  bench.traverse((o) => { if (o.isMesh) { o.receiveShadow = true; o.castShadow = o.castShadow ?? true; } });
  scene.add(bench);
  const paintTheme = () => {
    const dark = document.documentElement.dataset.theme === 'dark';
    stoneMat.color.set(dark ? 0x2a3757 : 0x8193b3);
    bench.userData.setTheme?.(dark ? 'dark' : 'light');
    scene.environmentIntensity = dark ? 0.72 : 0.85;
    rim.intensity = dark ? 1.6 : 0.8;
  };
  paintTheme();
  bus?.on?.('theme', paintTheme);
  new MutationObserver(paintTheme).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

  // ── arm and parts, from the lab's own modules ──
  const lib = materials();
  let robot, parts;
  try {
    robot = await createRobot(config, lib, layout(config));
    parts = createParts(config, lib);
  } catch (e) { console.warn('[cover]', e); renderer.dispose(); renderer.domElement.remove(); return fail(); }
  robot.mobileBase.group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  scene.add(robot.group, parts.group);

  // ── camera: the arm on the right, the parts in front of it, a slow sway ──
  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 20);
  const look = new THREE.Vector3(0.6, 0.8, 0.04);
  const camBase = new THREE.Vector3(-0.72, 1.45, 2.9);
  function resize() {
    const w = host.clientWidth, h = host.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 40 : w / h < 1.25 ? 34 : 29;        // narrower boxes need a wider lens
    camera.updateProjectionMatrix();
  }
  new ResizeObserver(resize).observe(host);
  resize();

  // ── key poses ──
  const B = R.baseToWorld;
  const DOWN = [0, -1, 0], JAW = [-1, 0, 0];
  const TAU = Math.PI * 2;
  // IK may return the wrist joints a full turn away from the previous pose; take the turn closest to it,
  // otherwise the gripper spins round between two key poses and seems to jump or vanish.
  const unwrap = (q, ref) => q.map((v, i) => {
    if (i !== 3 && i !== 5) return v;
    let x = v;
    while (x - ref[i] > Math.PI) x -= TAU;
    while (x - ref[i] < -Math.PI) x += TAU;
    return x;
  });
  const solve = (p, seed) => {
    const s = kin.ik({ p, z: DOWN, x: JAW }, seed, { base: B });
    if (!s.ok) console.warn('[cover] IK did not converge for', p.map((v) => v.toFixed(3)).join(','));
    return unwrap(s.q, seed);
  };
  const OPEN = R.gripper.strokeMax;
  const HOME = R.home.slice();
  const D = Math.PI / 180;
  // The wave: the base turns so the arm's bending plane faces the camera, the upper arm is raised, the elbow
  // bent and the hand points up (the presenter's reference pictures). Elbow and wrist pitch then swing the forearm
  // and hand left and right in the plane the audience sees, like a person waving, instead of tilting the
  // gripper toward or away from the camera. Poses picked from renders of the cover camera (tmp/wave_probe.py).
  // wrist roll −90°: the flat face of the gripper ("palm") faces the camera and the wrist camera sits behind it
  const WAVE = [135, 12, -140, 0, -52, -90].map((x) => x * D);
  const waveAt = (s) => [WAVE[0], WAVE[1], WAVE[2] + s * 14 * D, WAVE[3], WAVE[4] - s * 32 * D, WAVE[5]];
  const heightOf = (def) => (def.kind === 'gear' ? config.GEAR.faceWidth : config.NUT.height);
  const widthOf = (def) => (def.kind === 'gear'
    ? Math.min(OPEN - 0.004, 2 * gearRadii(config.GEAR[def.size].teeth, config.GEAR.module * 1e3, config.GEAR.pressureAngle).tip * 1e-3 - 0.002)
    : config.NUT.acrossFlats - 0.001);

  // timeline: a list of segments { dur, from, to, grip:[a,b], end(), spin }
  const segs = [];
  let q = WAVE.slice(), grip = OPEN;
  // NB: `grip` in extra is the target opening; the segment stores [from, to]. Spreading extra after it used to
  // overwrite the pair with a single number, the lerp then gave NaN and the gripper vanished for that segment.
  const move = (to, dur, { grip: g, ...extra } = {}) => {
    const tt = unwrap(to, q), g1 = g ?? grip;
    // no joint faster than 1.5 rad/s on average (the quintic peak is ~1.9x that): long swings take longer
    const reach = Math.max(...tt.map((v, i) => Math.abs(v - q[i]))) / 1.5;
    segs.push({ ...extra, dur: Math.max(dur, reach), from: q.slice(), to: tt, grip: [grip, g1] });
    q = tt; grip = g1;
  };
  const hold = (dur, extra = {}) => move(q, dur, extra);
  const wave = (n) => {
    move(waveAt(1), 0.42);
    for (let i = 0; i < n; i++) { move(waveAt(-1), 0.56); move(waveAt(1), 0.56); }
    move(WAVE, 0.36);
  };
  const order = config.PARTS.map((d) => d.key);
  const plan = order.map((k) => {
    const def = config.PARTS.find((d) => d.key === k);
    const home = poseFor(config, k, 'home'), seat = poseFor(config, k, 'seat');
    return { k, def, home, seat, h: heightOf(def), w: widthOf(def) };
  });

  // 1. wave to the audience
  hold(0.5);
  wave(2);
  move(HOME, 1.0);
  // 2. the five steps of Fig. 7: pick from the table, place on the cover
  for (const s of plan) {
    const gy = s.h * 0.5;
    const above = (pp, up) => [pp[0], pp[1] + gy + up, pp[2]];
    const qA = solve(above(s.home.position, 0.11), q);
    const qB = solve(above(s.home.position, 0.0), qA);
    const qC = solve(above(s.seat.position, 0.13), qA);
    const qD = solve(above(s.seat.position, 0.0), qC);
    move(qA, 0.62, { grip: OPEN });
    move(qB, 0.4);
    hold(0.22, { grip: s.w, end: () => robot.tcp.attach(parts.parts[s.k].object) });
    move(qA, 0.36);
    move(qC, 0.7);
    move(qD, 0.5);
    hold(0.2, { grip: Math.min(OPEN, s.w + 0.02), end: () => { parts.group.attach(parts.parts[s.k].object); parts.setPose(s.k, s.seat.position, s.seat.quaternion); } });
    move(qC, 0.36, { grip: OPEN });
  }
  move(HOME, 0.8);
  // 3. the gears turn once, as in a working gearbox
  hold(2.2, { spin: true });
  hold(0.3, { unspin: true });
  // 4. take it apart again, last part first, each back to where it lay
  for (const s of [...plan].reverse()) {
    const gy = s.h * 0.5;
    const above = (pp, up) => [pp[0], pp[1] + gy + up, pp[2]];
    const qC = solve(above(s.seat.position, 0.13), q);
    const qD = solve(above(s.seat.position, 0.0), qC);
    const qA = solve(above(s.home.position, 0.11), qC);
    const qB = solve(above(s.home.position, 0.0), qA);
    move(qC, 0.6, { grip: OPEN });
    move(qD, 0.42);
    hold(0.22, { grip: s.w, end: () => robot.tcp.attach(parts.parts[s.k].object) });
    move(qC, 0.36);
    move(qA, 0.7);
    move(qB, 0.46);
    hold(0.2, { grip: Math.min(OPEN, s.w + 0.02), end: () => { parts.group.attach(parts.parts[s.k].object); parts.setPose(s.k, s.home.position, s.home.quaternion); } });
    move(qA, 0.36, { grip: OPEN });
  }
  // 5. back to the wave pose; the loop starts again from exactly here, so nothing jumps
  move(HOME, 0.7);
  move(WAVE, 1.1);

  const total = segs.reduce((s, x) => s + x.dur, 0);
  let t = 0, idx = 0, tSeg = 0, spinAngle = 0;

  function restart() {
    for (const k of order) parts.group.attach(parts.parts[k].object);
    parts.setState('home');
    parts.spin(0);
    t = 0; idx = 0; tSeg = 0; spinAngle = 0;
    robot.setJoints(WAVE); robot.setGripper(OPEN);
  }
  function apply(seg, u) {
    const e = ease(u);
    robot.setJoints(lerpQ(seg.from, seg.to, e));
    robot.setGripper(lerp(seg.grip[0], seg.grip[1], e));
  }
  function step(dt) {
    let left = dt;
    while (left > 0) {
      if (idx >= segs.length) { idx = 0; tSeg = 0; t = 0; }   // the last segment ends in the first one's pose
      const seg = segs[idx];
      const d = Math.min(seg.dur - tSeg, left);
      tSeg += d; left -= d; t += d;
      apply(seg, tSeg / seg.dur);
      if (seg.spin) { spinAngle += d * 2.4; parts.spin(spinAngle); }
      if (seg.unspin) {                                          // settle on a pose where the teeth mesh as seated
        const full = Math.round(spinAngle / TAU) * TAU;
        spinAngle += (full - spinAngle) * Math.min(1, d * 8);
        parts.spin(spinAngle);
      }
      if (tSeg >= seg.dur - 1e-9) { seg.end?.(); idx++; tSeg = 0; if (seg.unspin) { spinAngle = 0; parts.spin(0); } }
    }
  }

  function still() {                       // reduced motion: the finished gearbox, the arm at rest
    restart();
    parts.setState('seat');
    robot.setJoints(HOME);
  }

  // ── loop: only while the cover is on screen and the tab is visible ──
  let raf = 0, last = 0, visible = true, sway = 0;
  const draw = () => {
    camera.position.set(camBase.x + Math.sin(sway) * 0.12, camBase.y + Math.sin(sway * 0.7) * 0.03, camBase.z + Math.cos(sway) * 0.05 - 0.05);
    camera.lookAt(look);
    robot.sync?.();
    renderer.render(scene, camera);
  };
  const frame = (now) => {
    raf = 0;
    if (!visible || document.hidden) return;
    const dt = Math.min(0.05, last ? (now - last) / 1000 : 0.016);
    last = now;
    sway += dt * 0.22;
    step(dt);
    draw();
    raf = requestAnimationFrame(frame);
  };
  const play = () => { if (!raf && !reduced) { last = 0; raf = requestAnimationFrame(frame); } };
  new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible) play(); }, { threshold: 0.05 }).observe(section);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) play(); });

  if (reduced) { still(); resize(); draw(); new ResizeObserver(() => { resize(); draw(); }).observe(host); }
  else { restart(); draw(); play(); }
  host.classList.add('is-ready');

  return { restart, total, segs, renderer, scene, camera, robot, parts, draw, step, get t() { return t; }, get idx() { return idx; } };
}
