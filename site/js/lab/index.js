// createLab(): joins the simulation core (sim.js, no three.js) to the picture layer (rig.js) and exposes the
// Lab API and events of docs/lab.md section 5. Nothing here touches the DOM outside `container`.
//
// Perception in the browser is the image pipeline: every 'observe' request from the sim is answered with
// rig.capture() (RGB, metric depth, object-id image from the wrist camera), and the sim runs Eq. (4)(5)(6),
// centroid and ICP on those arrays. The object-id image stands in for Grounding DINO + Grounded SAM 2.

import * as config from './config.js';
import RAPIER from '../../vendor/rapier/rapier.js';
import { createSim, perceivePart, alignToMemory, handEyeDelta } from './sim.js';
import { buildRig } from './rig.js';
import { makeRng, eq7Waypoints, topDownPose, resolveName } from './control.js';
import { pos, axisX, axisZ } from './kinematics.js';
import { apply as applyRT } from './icp.js';

const TELEMETRY_MS = 66;
const sleepFrames = (n, raf = requestAnimationFrame) => new Promise((res) => { const tick = () => (--n <= 0 ? res() : raf(tick)); raf(tick); });

export async function createLab(container, { quality = 'auto', seed = config.SEED, reducedMotion = false } = {}) {
  await RAPIER.init();
  const sim = await createSim(config, RAPIER, { seed, oracle: false });
  const rig = await buildRig(container, config, { quality, reducedMotion });
  const ov = rig.overlays;
  const listeners = new Map();
  const emit = (type, data) => { for (const fn of listeners.get(type) || []) { try { fn(data); } catch (e) { console.error('[lab]', type, e); } } };
  const log = (text, level = 'info') => emit('log', { level, text });

  let speed = config.PARAMS.speed.v;
  let userPaused = false;                 // lab.pause(): the plan waits, the picture keeps drawing
  let actToken = 0;                       // a newer act() cancels the running one
  let spinning = false;
  let lastTele = 0;
  let gizmo = null;
  const show = { ray: false, clouds: false };
  for (const [k, d] of Object.entries(config.PARAMS)) sim.setParam(k, d.v);

  // ------------------------------------------------------------------ sim -> rig
  function syncRig(st, { parts = true } = {}) {
    rig.robot.setJoints(st.q);
    rig.robot.setGripper(st.gripper.width);
    if (parts && !spinning) for (const [k, pose] of Object.entries(st.parts)) rig.setPartPose(k, pose.p, pose.quat);
  }
  function capture(width = config.CAMERA.width, height = config.CAMERA.height) {
    const g = gizmo?.helper; const was = g?.visible;
    if (g) g.visible = false;
    const c = rig.capture({ width, height });
    if (g) g.visible = was;
    return c;
  }
  /** Picture-only pose for one shot: parts at `poses`, arm at `q`. The sim does not move. Restored afterwards. */
  function stagedCapture(q, poses, width, height) {
    const st = sim.state;
    if (poses) for (const [k, p] of Object.entries(poses)) rig.setPartPose(k, p.p, p.quat);
    rig.robot.setJoints(q); rig.robot.setGripper(config.ROBOT.gripper.strokeMax);
    const c = capture(width, height);
    syncRig(st);
    return c;
  }
  function answerObserve(e) {
    if (e.purpose === 'memory') sim.provideObservation({ capture: stagedCapture(e.q, e.poses, e.width, e.height) });
    else { syncRig(sim.state); sim.provideObservation({ capture: capture(e.width, e.height) }); }
  }

  // ------------------------------------------------------------------ events
  const camOrigin = (M) => [M[3], M[7], M[11]];
  function onSimEvent(e) {
    const { type, t, ...d } = e;
    switch (type) {
      case 'waypoints': ov.waypoints.set({ points: d.points, index: d.index }); break;
      case 'capture': if (show.ray) ov.ray.set({ origin: camOrigin(d.camToWorld), point: d.P_world, label: `(${Math.round(d.pixel.u)}, ${Math.round(d.pixel.v)})` }); break;
      case 'perception': {
        const r = sim.lastScan?.result;
        if (r?.cloud?.points && show.clouds) ov.clouds.set(r.part, { positions: r.cloud.points });
        if (r?.pick) ov.grasp.set({ pose: topDownPose(r.pick.center, r.pick.axis), width: config.ROBOT.gripper.strokeMax });
        break;
      }
      case 'step':
        if (d.status === 'start') { ov.waypoints.clear(); ov.grasp.clear(); ov.contacts.clear(); }
        if (['success', 'fail', 'skipped'].includes(d.status)) { ov.waypoints.clear(); ov.grasp.clear(); }
        break;
      default: break;
    }
    emit(type, d);
  }

  function frame(dt) {
    grab.carry();
    let budget = userPaused ? 0 : dt * speed;
    for (let guard = 0; guard < 3; guard++) {
      const evs = sim.advance(budget);
      budget = 0;
      let observed = false;
      for (const e of evs) { if (e.type === 'observe') { answerObserve(e); observed = true; } else onSimEvent(e); }
      if (!observed) break;
      budget = sim.dt;                                  // one tick so the answer is consumed
    }
    const st = sim.state;
    syncRig(st);
    if (gizmo && !gizmo.dragging) gizmo.follow(st);
    const now = performance.now();
    if (now - lastTele >= TELEMETRY_MS) {
      lastTele = now;
      emit('telemetry', {
        q: st.q, qdot: st.qdot, tcp: st.tcp,
        grip: { width: st.gripper.width, contactL: st.gripper.contactL, contactR: st.gripper.contactR, holding: st.gripper.holding },
        A: st.A, fps: rig.stats().fps, running: st.running, paused: userPaused,
      });
    }
  }

  // ------------------------------------------------------------------ demo helpers (article buttons)
  const rngFor = (label) => makeRng(sim.state.seed).fork(label);
  const params = () => sim.getParams();
  const delta = () => handEyeDelta(sim.state.seed, params()['handeye.errMm']);
  const alive = (tok) => tok === actToken;

  async function moveArm(q, tok, timeout = 420) {
    if (sim.busy) return false;
    sim.command.setJoints(q);
    for (let i = 0; i < timeout; i++) {
      await sleepFrames(1);
      if (!alive(tok)) return false;
      const cur = sim.state.q;
      if (Math.max(...cur.map((v, j) => Math.abs(v - q[j]))) < 0.004) return true;
    }
    return false;
  }
  /** k views of the current table, the arm really moving to each view. onView(j, captures) after every shot. */
  async function scanNow(tok, onView) {
    const views = sim.scanViews();
    const caps = [];
    for (const v of views) {
      const ok = await moveArm(v.q, tok);
      if (!alive(tok)) return null;
      if (!ok) { log('scan view out of reach or interrupted', 'warn'); continue; }
      await sleepFrames(4);
      syncRig(sim.state);
      caps.push(capture());
      if (onView) await onView(caps.length - 1, caps, views.length);
    }
    return caps;
  }
  /** Assembled-state observation of one part: picture-only staging, no arm motion. */
  function memoryCaptures(key) {
    const poses = sim.memoryStage(key);
    return sim.scanViews().map((v) => stagedCapture(v.q, poses));
  }
  const firstOpenPart = () => {
    const done = new Set(sim.state.plan.results.filter((r) => r && r.status === 'success').map((r) => r.part));
    return (config.PARTS.find((p) => !done.has(p.key)) || config.PARTS[0]).key;
  };
  const partArg = (args) => resolveName(args?.[0] ?? '', config.ALIASES) || (config.PARTS.some((p) => p.key === args?.[0]) ? args[0] : firstOpenPart());

  const acts = {
    async overview(tok) {
      ov.hideAll(); rig.setLabels(true); rig.setScreenFeed(true);
      rig.setCameraPreset('hero', { animate: !reducedMotion });
      // no automatic spin: the turntable runs only when the person turns it on (HUD button or lab.orbit(true))
    },
    async labels() {
      rig.setLabels(true);
      const plan = sim.state.plan;
      const tr = (lab.plan?.triples || config.PAPER_PLAN).slice(0, plan.n || 5);
      const list = tr.map(([s, p, o]) => ({ from: resolveName(s, config.ALIASES), to: resolveName(o, config.ALIASES), text: p })).filter((e) => e.from && e.to);
      ov.edges.set(list); ov.edges.show();
    },
    async frustum(tok) {
      ov.frustum.show(); ov.axes.show(['camera', 'world']); rig.setScreenFeed(true);
      rig.setCameraPreset('side', { animate: !reducedMotion });
      const v = sim.scanViews()[0];
      if (v) await moveArm(v.q, tok);
    },
    async backproject(tok, args) {
      const key = partArg(args);
      show.ray = true; ov.frustum.show(); ov.axes.show(['camera', 'world']);
      const v = sim.scanViews()[0];
      if (v && !(await moveArm(v.q, tok))) return;
      await sleepFrames(4); syncRig(sim.state);
      const res = perceivePart([capture()], key, config, params(), { rng: rngFor('backproject'), delta: delta() });
      const cap = res.events.find((e) => e.type === 'capture');
      if (!cap) { log(`${key}: not in view`, 'warn'); return; }
      const { type, ...d } = cap;
      ov.ray.set({ origin: camOrigin(d.camToWorld), point: d.P_world, label: `(${d.pixel.u}, ${d.pixel.v})  d = ${d.pixel.d.toFixed(3)} m` });
      emit('capture', d);
    },
    async fuse(tok) {
      show.clouds = true; ov.clouds.clear(); ov.clouds.show(); ov.frustum.show();
      rig.setCameraPreset('close', { animate: !reducedMotion });
      const rng = rngFor('fuse');
      await scanNow(tok, async (j, caps, k) => {
        for (const part of config.PARTS) {
          const r = perceivePart(caps, part.key, config, params(), { rng, delta: delta() });
          if (r.cloud.length) ov.clouds.set(part.key, { positions: r.cloud });
          const cl = r.events.find((e) => e.type === 'cloud');
          if (cl) { const { type, ...d } = cl; emit('cloud', { ...d, views: j + 1, k, perView: caps.length }); }
          const cp = r.events.filter((e) => e.type === 'capture').pop();
          if (cp && part.key === firstOpenPart()) { const { type, ...d } = cp; emit('capture', d); }
        }
        await sleepFrames(20);
      });
    },
    async memory(tok) {
      show.clouds = true; ov.memory.show(); ov.memory.ghost(true); ov.clouds.show();
      rig.setCameraPreset('close', { animate: !reducedMotion });
      const rng = rngFor('memory');
      for (const part of config.PARTS) {
        if (!alive(tok)) return;
        const m = perceivePart(memoryCaptures(part.key), part.key, config, params(), { rng, delta: delta() });
        if (m.cloud.length) ov.memory.set(part.key, { positions: m.cloud });
        emit('cloud', { part: part.key, nPoints: m.cloud.length, views: sim.scanViews().length, centroid: m.centroid, state: 'assembled', score: m.score, detected: m.detected });
        await sleepFrames(6);
      }
      const caps = await scanNow(tok);
      if (!caps || !caps.length) return;
      for (const part of config.PARTS) {
        const c = perceivePart(caps, part.key, config, params(), { rng, delta: delta() });
        if (c.cloud.length) ov.clouds.set(part.key, { positions: c.cloud });
        emit('cloud', { part: part.key, nPoints: c.cloud.length, views: caps.length, centroid: c.centroid, state: 'disassembled', score: c.score, detected: c.detected });
      }
    },
    async icp(tok, args) {
      const key = partArg(args);
      rig.setCameraPreset('close', { animate: !reducedMotion });
      const rng = rngFor('icp');
      const mem = perceivePart(memoryCaptures(key), key, config, params(), { rng, delta: delta() });
      const caps = await scanNow(tok);
      if (!caps || !caps.length || !alive(tok)) return;
      const cur = perceivePart(caps, key, config, params(), { rng, delta: delta() });
      if (!cur.cloud.length || !mem.cloud.length) { log(`${key}: no points for ICP`, 'warn'); return; }
      const al = alignToMemory(cur, mem, key, params(), config);
      ov.clouds.hide(); ov.memory.hide();
      const steps = al.events.filter((e) => e.type === 'icp');
      // iteration 0 = the two clouds as observed; then centroid shift; then each ICP iterate
      ov.icp.set({ key, source: cur.cloud, target: mem.cloud, label: 'as observed' });
      await sleepFrames(40);
      for (const s of steps) {
        if (!alive(tok)) return;
        const moved = cur.cloud.map((p) => applyRT(s.R, s.T, p));
        ov.icp.set({ key, source: moved, target: mem.cloud, label: `iter ${s.iter}  rmse ${(s.rmse * 1000).toFixed(2)} mm` });
        const { type, ...d } = s;
        emit('icp', { ...d, centroidSrc: cur.centroid, centroidDst: mem.centroid });
        await sleepFrames(reducedMotion ? 1 : 14);
      }
    },
    async grasp(tok, args) {
      const key = partArg(args);
      rig.setCameraPreset('close', { animate: !reducedMotion });
      const caps = await scanNow(tok);
      if (!caps || !caps.length || !alive(tok)) return;
      const r = perceivePart(caps, key, config, params(), { rng: rngFor('grasp'), delta: delta() });
      if (!r.grasp) { log(`${key}: no grasp`, 'warn'); return; }
      const sel = topDownPose(r.grasp.center, r.grasp.axis);
      ov.grasp.set({ pose: sel, width: config.ROBOT.gripper.strokeMax, candidates: r.grasp.candidates.map((a) => ({ pose: topDownPose(r.grasp.center, a) })) });
      ov.clouds.set(key, { positions: r.cloud }); ov.clouds.show();
      emit('grasp', { part: key, center: r.grasp.center, axis: r.grasp.axis, ratio: r.grasp.ratio, nTop: r.grasp.nTop, candidates: r.grasp.candidates.length, standsInFor: 'AnyGrasp' });
    },
    async waypoints(tok, args) {
      const key = partArg(args);
      rig.setCameraPreset('close', { animate: !reducedMotion });
      const p = params();
      const pose0 = sim.state.parts[key];
      const part = config.PARTS.find((x) => x.key === key);
      const h = part.kind === 'nut' ? config.NUT.height : config.GEAR.faceWidth;
      const goal = [pose0.p[0], pose0.p[1] + h + 0.004, pose0.p[2]];             // just above the top face: the arm does not grip in this demo
      const T = [0, -p['approach.height'], 0];
      const P = [goal[0], goal[1] - T[1], goal[2]];
      const coeffs = [p['eq7.a'], p['eq7.b'], p['eq7.c']];
      const pts = eq7Waypoints(P, T, coeffs);
      const tcp = sim.state.tcpMatrix;
      const tool = { x: axisX(tcp), z: [0, -1, 0] };
      const grasp = topDownPose(P, [0, 0, 1]);
      for (let i = 0; i < pts.length; i++) {
        if (!alive(tok)) return;
        ov.waypoints.set({ points: pts, index: i });
        emit('waypoints', { phase: 'pick', P, T, coeffs, points: pts, index: i, demo: true });
        const pose = i === 0 ? { p: pts[0], x: tool.x, z: tool.z } : { p: pts[i], x: grasp.x, z: grasp.z };
        if (!sim.command.moveTcp(pose)) { log('waypoint out of reach', 'warn'); return; }
        for (let n = 0; n < 240 && alive(tok); n++) {
          await sleepFrames(1);
          const now = pos(sim.state.tcpMatrix);
          if (Math.hypot(now[0] - pts[i][0], now[1] - pts[i][1], now[2] - pts[i][2]) < 0.0015 && n > 10) break;
        }
        await sleepFrames(8);
      }
    },
    async run() { show.clouds = true; ov.clouds.clear(); userPaused = false; sim.command.runPlan({}); },
    async spin(tok) {
      const res = sim.state.plan.results;
      const seated = config.PARTS.filter((p) => p.kind === 'gear').every((p) => res.some((r) => r && r.part === p.key && r.status === 'success'));
      if (!seated) { log('spin: the gears are not all seated yet', 'warn'); emit('spin', { ok: false }); return; }
      rig.setCameraPreset('close', { animate: !reducedMotion });
      spinning = true; emit('spin', { ok: true });
      for (let i = 0; i <= 300 && alive(tok); i++) { rig.spinGears((i / 300) * Math.PI * 4); await sleepFrames(1); }
      rig.spinGears(0); spinning = false;
    },
  };

  // ------------------------------------------------------------------ TCP gizmo
  async function makeGizmo() {
    const { TransformControls } = await import('three/addons/controls/TransformControls.js');
    const T = rig.THREE;
    const target = new T.Object3D(); rig.scene.add(target);
    const tc = new TransformControls(rig.camera, rig.renderer.domElement);
    tc.setMode('translate'); tc.setSize(0.7); tc.attach(target);
    const helper = tc.getHelper ? tc.getHelper() : tc;
    rig.scene.add(helper);
    const g = { helper, dragging: false, follow(st) { const p = st.tcp.p; target.position.set(p[0], p[1], p[2]); } };
    tc.addEventListener('dragging-changed', (e) => { g.dragging = e.value; rig.controls.enabled = !e.value; });
    tc.addEventListener('objectChange', () => {
      const M = sim.state.tcpMatrix;
      sim.command.moveTcp({ p: [target.position.x, target.position.y, target.position.z], x: axisX(M), z: axisZ(M) });
    });
    g.dispose = () => { tc.detach(); rig.scene.remove(helper); rig.scene.remove(target); tc.dispose(); rig.controls.enabled = true; };
    return g;
  }

  // ------------------------------------------------------------------ picking up a part with the pointer
  // Press a gear or the nut on the table, carry it a few centimetres above the table, let go: physics takes over.
  // Not while the arm is carrying out a step, and not the part the gripper is holding.
  const grab = (() => {
    const T = rig.THREE, canvas = rig.renderer.domElement;
    const ray = new T.Raycaster(), ndc = new T.Vector2(), hitP = new T.Vector3();
    const HOVER = 0.075;                                   // m above the table while carried: clears parts and shafts
    const plane = new T.Plane(new T.Vector3(0, 1, 0), -(config.TABLE.topY + HOVER));
    const keys = config.PARTS.map((p) => p.key);
    const half = [config.TABLE.size[0] / 2 - 0.04, config.TABLE.size[2] / 2 - 0.04];
    let held = null, enabled = true, hoverKey = null, lastMove = 0;

    const setRay = (e) => {
      const r = canvas.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, rig.camera);
    };
    const pick = (e) => {
      setRay(e);
      let best = null;
      for (const k of keys) {
        const o = rig.getPartObject(k);
        if (!o) continue;
        const hit = ray.intersectObject(o, true)[0];
        if (hit && (!best || hit.distance < best.distance)) best = { key: k, distance: hit.distance, point: hit.point };
      }
      if (best) return best;
      // a press inside a bore or a lightening hole still means that part: test the footprint on the table
      const flat = new T.Plane(new T.Vector3(0, 1, 0), -(config.TABLE.topY + 0.006));
      if (!ray.ray.intersectPlane(flat, hitP)) return null;
      for (const def of config.PARTS) {
        const pose = sim.state.parts[def.key];
        if (!pose || Math.abs(pose.p[1] - config.TABLE.topY) > 0.02) continue;          // only parts lying on the table
        const r = def.kind === 'gear' ? (config.GEAR[def.size].teeth * config.GEAR.module) / 2 : config.NUT.acrossFlats / 2;
        const d = Math.hypot(hitP.x - pose.p[0], hitP.z - pose.p[2]);
        if (d <= r && (!best || d < best.distance)) best = { key: def.key, distance: d, point: hitP.clone() };
      }
      return best;
    };
    const free = () => enabled && !sim.busy && !gizmo?.dragging && rig.getCameraPreset?.() !== 'wrist';
    const body = (k) => sim.physics.parts.get(k)?.body;
    const carry = () => {
      if (!held) return;
      const x = Math.min(config.TABLE.center[0] + half[0], Math.max(config.TABLE.center[0] - half[0], held.target[0]));
      const z = Math.min(config.TABLE.center[1] + half[1], Math.max(config.TABLE.center[1] - half[1], held.target[2]));
      held.y += (config.TABLE.topY + HOVER - held.y) * 0.35;         // ease up to carrying height
      sim.physics.setPartPose(held.key, [x, held.y, z], held.quat);
    };

    function down(e) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey || !free()) return;
      const hit = pick(e);
      if (!hit || sim.state.gripper.holding === hit.key) return;
      const pose = sim.state.parts[hit.key];
      if (!pose) return;
      e.stopImmediatePropagation(); e.preventDefault();
      rig.controls.enabled = false;
      setRay(e);
      const on = ray.ray.intersectPlane(plane, hitP);
      const start = on ? [hitP.x, 0, hitP.z] : [pose.p[0], 0, pose.p[2]];
      held = { key: hit.key, id: e.pointerId, y: pose.p[1], quat: [0, pose.quat[1], 0, pose.quat[3]], off: [pose.p[0] - start[0], pose.p[2] - start[2]], target: [pose.p[0], 0, pose.p[2]] };
      const n = Math.hypot(held.quat[1], held.quat[3]) || 1; held.quat[1] /= n; held.quat[3] /= n;        // keep it flat
      body(hit.key)?.setGravityScale(0, true);
      try { canvas.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
      canvas.style.cursor = 'grabbing';
      emit('grab', { part: hit.key, state: 'held' });
    }
    function move(e) {
      if (held) {
        if (e.pointerId !== held.id) return;
        setRay(e);
        if (ray.ray.intersectPlane(plane, hitP)) held.target = [hitP.x + held.off[0], 0, hitP.z + held.off[1]];
        e.stopImmediatePropagation();
        return;
      }
      const now = performance.now();
      if (now - lastMove < 80 || e.buttons) return;                   // hover feedback, a few times a second
      lastMove = now;
      const k = free() ? pick(e)?.key ?? null : null;
      if (k !== hoverKey) { hoverKey = k; canvas.style.cursor = k ? 'grab' : ''; }
    }
    function up(e) {
      if (!held || e.pointerId !== held.id) return;
      const k = held.key;
      held = null;
      const b = body(k);
      b?.setGravityScale(1, true); b?.wakeUp?.();
      rig.controls.enabled = rig.getCameraPreset?.() !== 'wrist';
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* already released */ }
      canvas.style.cursor = '';
      const p = sim.state.parts[k]?.p;
      emit('grab', { part: k, state: 'released', p });
      log(`${k} moved by hand to x ${p ? p[0].toFixed(3) : '–'}, z ${p ? p[2].toFixed(3) : '–'} m`);
    }
    canvas.addEventListener('pointerdown', down, { capture: true });
    canvas.addEventListener('pointermove', move, { capture: true });
    canvas.addEventListener('pointerup', up, { capture: true });
    canvas.addEventListener('pointercancel', up, { capture: true });
    return {
      carry,
      get held() { return held?.key ?? null; },
      setEnabled(v) { enabled = !!v; },
      dispose() {
        for (const [t, f] of [['pointerdown', down], ['pointermove', move], ['pointerup', up], ['pointercancel', up]]) canvas.removeEventListener(t, f, { capture: true });
      },
    };
  })();

  // ------------------------------------------------------------------ API
  const lab = {
    config, plan: null,
    on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); return () => listeners.get(type).delete(fn); },
    reset({ seed: s } = {}) {
      actToken++; spinning = false; userPaused = false; show.ray = false;
      sim.reset({ seed: s ?? sim.state.seed });
      for (const [k, v] of Object.entries(currentParams)) sim.setParam(k, v);
      if (lab.plan) sim.loadPlan(lab.plan);
      ov.clearAll(); ov.hideAll(); ov.labels.hide();
      syncRig(sim.state);
    },
    setParam(path, value) {
      const d = config.PARAMS[path];
      if (!d) return false;
      const v = Math.max(d.min, Math.min(d.max, Number(value)));
      if (!Number.isFinite(v)) return false;
      currentParams[path] = v;
      if (path === 'speed') speed = v;
      if (path === 'camera.fx') ov.frustum.set({});
      return sim.setParam(path, v);
    },
    getParams: () => ({ ...sim.getParams() }),
    loadPlan(plan) { actToken++; lab.plan = { ...plan, triples: plan.triples.map((t) => t.slice(0, 3)) }; if (sim.busy) sim.command.stop(); sim.loadPlan(lab.plan); },
    run({ from, to } = {}) { actToken++; userPaused = false; show.clouds = true; sim.command.runPlan({ ...(from != null ? { from } : {}), ...(to != null ? { to } : {}) }); },
    step() { actToken++; userPaused = false; show.clouds = true; return sim.command.stepPlan(); },
    pause() { userPaused = true; }, resume() { userPaused = false; },
    stop() { actToken++; sim.command.stop(); },
    manual: {
      setJoint: (i, rad) => { actToken++; return sim.command.setJoint(i, rad); },
      jog: (d) => { actToken++; return sim.command.jog(d); },
      setGripper: (w) => { actToken++; return sim.command.setGripper(w); },
      home: () => { actToken++; return sim.command.home(); },
      async enableGizmo(on) {
        if (on && !gizmo) { gizmo = await makeGizmo(); gizmo.follow(sim.state); }
        else if (!on && gizmo) { gizmo.dispose(); gizmo = null; }
      },
    },
    async act(name, args = []) {
      const fn = acts[name];
      if (!fn) { log(`unknown act ${name}`, 'warn'); return false; }
      if (sim.busy && name !== 'labels' && name !== 'run') { log(`busy: "${name}" waits until the plan step ends (Pause does not free the arm; Reset does)`, 'warn'); return false; }
      const tok = ++actToken;
      try { await fn(tok, args); } catch (e) { console.error('[lab act]', name, e); log(`${name}: ${e.message}`, 'warn'); return false; }
      return true;
    },
    camera: (name) => { rig.setOrbit(false); return rig.setCameraPreset(name, { animate: !reducedMotion }); },
    /** Turntable around the current target: orbit(true|false); orbit() returns the state. Any drag stops it. */
    orbit: (on) => { if (on !== undefined) rig.setOrbit(on); return rig.getOrbit(); },
    onOrbit: (fn) => rig.onOrbit(fn),
    setQuality: (q) => rig.setQuality(q),
    setLabels: (on) => rig.setLabels(on),
    setPaused: (v) => rig.setPaused(v),
    resize: () => rig.resize(),
    snapshot: (type = 'image/jpeg', q = 0.92) => rig.snapshot(type, q),
    getState() { const st = sim.state; return { ...st, grip: st.gripper, params: sim.getParams(), quality: rig.getQuality() }; },
    stats: () => rig.stats(),
    /** For tools and tests in the page: direct handles. Not part of the article contract. */
    debug: { sim, rig },
    /** Carrying parts with the pointer: lab.grab.setEnabled(false) turns it off; lab.grab.held is the part in hand. */
    grab,
    dispose() { actToken++; rig.stop(); grab.dispose(); gizmo?.dispose(); sim.dispose(); rig.dispose(); listeners.clear(); },
  };
  const currentParams = sim.getParams();

  syncRig(sim.state);
  rig.setScreenFeed(true);
  rig.start(frame);
  queueMicrotask(() => emit('ready', { gpu: rig.gpu, quality: rig.getQuality() }));
  return lab;
}
