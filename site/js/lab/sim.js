// createSim(): the steppable simulation. Physics (Rapier), kinematics, perception and control are tied together here.
// No three.js, no DOM: Node loads this file directly (tools/tests/).
//
// Perception has two sources that produce the same result object:
//   oracle = true  : no renderer. The true pose of each part goes through the same per-view distortions the image
//                    pipeline applies (assumed fx, hand-eye offset), plus Gaussian errors scaled from the depth noise.
//   oracle = false : the caller answers every 'observe' event with sim.provideObservation({ capture }) holding the
//                    RGB-D + id image of that view (rig.capture() in the browser, a ray-cast camera in Node tests);
//                    the sim then runs Eq. (4)(5)(6) -> voxel grid -> top-face centroid -> centroid + ICP itself.
// Tests may also inject a finished result with sim.provideObservation({ result }).

import { fk, mul, pos, axisX, axisZ, xform, invRigid, eulerZYX, trans, matOf, clampQ, unit, JOINTS } from './kinematics.js';
import { createPhysics, homePose, seatPose, shaftTop, partDims, coverToWorld } from './physics.js';
import {
  makeRng, eq7Waypoints, resolveName, actionFor, judge, graspFromCloud, topDownPose, ikWorld, scanViews, cameraWorld,
  jointMove, lineMove, armClearance, tiltOf,
} from './control.js';
import { makeK, eq4, eq5, project, worldToCam, crossCheck, erodeMask, maskOf, backprojectView, fuseViews, voxelDownsample, depthSigma } from './backproject.js';
import { icp, centroid, apply as applyRT } from './icp.js';

const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const I3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// ------------------------------------------------------------------ perception pipeline (pure)

/** Camera-frame offset that models a hand-eye calibration error of `errMm` (fixed direction per seed). */
export function handEyeDelta(seed, errMm) {
  const r = makeRng(seed).fork('handeye');
  const v = unit([r.gauss(), r.gauss(), r.gauss()]);
  return v.map((c) => c * errMm * 1e-3);
}

/** Intrinsics the pipeline assumes for a capture: the capture's own K with fx (and fy in proportion) replaced by camera.fx. */
export function assumedK(K, width, params, config) {
  const s = width / config.CAMERA.width;
  const fx = params['camera.fx'] * s;
  return makeK({ fx, fy: fx * (K[4] / K[0]), cx: K[2], cy: K[5] });
}

/** Tooth phase of a seated gear (same rule as parts.js seatPhase): red and yellow are turned by half a pitch. */
export function meshPhase(config, key) {
  const part = config.PARTS.find((p) => p.key === key);
  if (!part || part.kind !== 'gear' || key === 'green' || key === 'blue') return 0;
  return Math.PI / config.GEAR[part.size].teeth;
}

/** Synthetic detector score of config.DETECTOR. */
export function detectorScore(config, maskPixels, hiddenFraction) {
  const D = config.DETECTOR;
  if (!(maskPixels > 0)) return 0;
  return Math.max(0, Math.min(1, D.base - D.occlusionPenalty * hiddenFraction - D.sizePenalty / Math.sqrt(maskPixels)));
}

/**
 * One part from k captures: mask -> erosion -> depth noise -> Eq. (4) -> Eq. (5) -> Eq. (6) -> voxel grid -> top face.
 * captures: [{ depth, id, K, camToWorld, width, height }]. Returns
 * { key, detected, score, maskPixels, nRaw, cloud, centroid, grasp, events: [capture..., cloud] }.
 */
export function perceivePart(captures, key, config, params, { rng, delta = [0, 0, 0] }) {
  const part = config.PARTS.find((p) => p.key === key);
  const dims = part ? partDims(config, part) : null;
  const idv = config.IDS[key];
  const views = [], events = [];
  let pixSum = 0, rawSum = 0, expSum = 0, nRawPts = 0;
  const k = captures.length;
  captures.forEach((cap, j) => {
    const { width, height } = cap;
    const scale640 = (config.CAMERA.width / width) ** 2;
    const m0 = maskOf(cap.id, idv);
    const erode = params['mask.erodePx'] * (width / config.CAMERA.width);
    const mask = erodeMask(m0.mask, width, height, erode);
    let n = 0, su = 0, sv = 0;
    for (let i = 0; i < mask.length; i++) if (mask[i]) { n++; su += i % width; sv += (i / width) | 0; }
    pixSum += n * scale640; rawSum += m0.count * scale640;
    const Ku = assumedK(cap.K, width, params, config);
    const G = mul(cap.camToWorld, trans(delta[0], delta[1], delta[2]));
    const sig = params['depth.sigmaMm'], d0 = config.DEPTH_NOISE.d0;
    const noise = sig > 0 ? (d) => rng.gauss() * depthSigma(d, sig, d0) : null;
    const pts = backprojectView({ depth: cap.depth, mask, width, height, K: Ku, camToWorld: G, noise });
    nRawPts += pts.length;
    views.push(pts);
    if (n > 0) {
      // the mask pixel nearest the mask centroid: one worked example of Eq. (4) and (5) for this view
      const cu = su / n, cv = sv / n;
      let bi = -1, bd = Infinity;
      for (let i = 0; i < mask.length; i++) if (mask[i] && cap.depth[i] > 0) { const d = (i % width - cu) ** 2 + (((i / width) | 0) - cv) ** 2; if (d < bd) { bd = d; bi = i; } }
      if (bi >= 0) {
        const u = bi % width, v = (bi / width) | 0, d = cap.depth[bi];
        const Pc = eq4(u, v, d, Ku), Pw = eq5(Pc, G), ck = crossCheck(u, v, d, Ku, G);
        events.push({ type: 'capture', view: j, k, K: Ku, camToWorld: G, pixel: { u, v, d }, P_cam: Pc, P_world: Pw, check: ck.P_world, checkErr: ck.err, reproj: ck.reproj, part: key });
        if (dims) expSum += Math.PI * ((cap.K[0] * dims.pitchR) / d) ** 2 * scale640;
      }
    }
  });
  const fused = fuseViews(views);                                  // Eq. (6)
  const cloud = voxelDownsample(fused, config.SCAN.voxel);
  const maskPixels = pixSum / k;
  const visible = expSum > 0 ? (rawSum / k) / (expSum / k) : 0;
  const hidden = Math.max(0, Math.min(1, (0.75 - visible) / 0.75));  // bores, lightening holes and tooth gaps are not occlusion
  const score = detectorScore(config, maskPixels, dims ? hidden : 0);
  const detected = cloud.length >= 8 && maskPixels >= config.SCAN.minPixels && score >= params['detect.threshold'];
  const cen = cloud.length ? centroid(cloud) : [NaN, NaN, NaN];
  const grasp = cloud.length ? graspFromCloud(cloud, { topBand: config.GRASP.topBand, anisotropy: config.GRASP.anisotropy, defaultAxis: defaultJaw(config) }) : null;
  events.push({ type: 'cloud', part: key, nPoints: cloud.length, views: k, centroid: cen, nRaw: nRawPts, score, detected });
  return { key, detected, score, maskPixels, hidden, nRaw: nRawPts, cloud, centroid: cen, grasp, events };
}

/**
 * Centroid alignment + ICP of a current cloud onto its memory cloud; one 'icp' event per iteration.
 * SCAN.icpTopOnly keeps only the top-face points of both clouds (the side faces seen at home and on the seat are
 * different, which biases a full-cloud fit); SCAN.icpTrim drops the worst pairs each iteration.
 */
export function alignToMemory(cur, mem, key, params, config) {
  const events = [];
  const S = config.SCAN;
  const top = (cloud) => {
    if (!S.icpTopOnly) return cloud;
    const g = graspFromCloud(cloud, { topBand: config.GRASP.topBand });
    const t = cloud.filter((p) => Math.abs(p[1] - g.topY) <= (S.icpBand ?? config.GRASP.topBand));
    return t.length >= 8 ? t : cloud;
  };
  const r = icp(top(cur.cloud), top(mem.cloud), {
    maxIters: params['icp.maxIters'], trim: S.icpTrim ?? 1,
    onIter: (s) => events.push({ type: 'icp', part: key, iter: s.iter, rmse: s.rmse, T_rou: null, R: s.R.slice(), T: s.T.slice(), converged: s.converged }),
  });
  for (const e of events) e.T_rou = r.T_rou.slice();
  return { ...r, events };
}

/** Closing direction for round parts: the cover's short axis in the world. */
export function defaultJaw(config) {
  const yaw = config.COVER.world.yaw, a = config.GRASP.defaultJawAxis;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * a[0] + s * a[2], 0, -s * a[0] + c * a[2]];
}

/** Part poses of memory stage `key`: canonical parts up to and including `key` on their seats, the rest at home. */
export function memoryStage(config, key) {
  const poses = {};
  let seated = true;
  for (const part of config.PARTS) {
    poses[part.key] = seated ? seatPose(config, part) : homePose(config, part);
    if (part.key === key) seated = false;
  }
  return poses;
}

// ------------------------------------------------------------------ createSim

export async function createSim(config, RAPIER, { seed = config.SEED, oracle = true } = {}) {
  const PH = config.PHYSICS, RB = config.ROBOT, B = RB.baseToWorld, GR = config.GRASP;
  const dt = PH.dt;
  const params = {};
  for (const [k, d] of Object.entries(config.PARAMS)) params[k] = d.v;

  let physics = createPhysics(config, RAPIER, { q0: RB.home, width0: RB.gripper.strokeMax });
  let rng, t, tick, q, qd, width, widthCmd, events, program, prim, paused, plan, planState, memory, memoryKey, pending, lastScan;
  let manual, tcpHist, waypointState, stepState, viewCache = new Map(), stall;
  let perceptionHook = null;

  function emit(type, payload) { events.push({ type, t, ...payload }); }
  const log = (level, text) => emit('log', { level, text });

  function resetState(newSeed) {
    if (newSeed != null) seed = newSeed;
    rng = makeRng(seed >>> 0);
    physics.rebuild();
    t = 0; tick = 0;
    q = RB.home.slice(); qd = [0, 0, 0, 0, 0, 0];
    width = RB.gripper.strokeMax; widthCmd = width;
    events = []; program = null; prim = null; paused = false;
    planState = { next: 0, results: [], success: 0, fail: 0, done: 0 };
    memory = null; memoryKey = ''; pending = null; lastScan = null;
    manual = { qGoal: q.slice() };
    tcpHist = []; waypointState = null; stepState = null; stall = false;
    physics.setRobot(q, width);
  }
  resetState(seed);
  plan = { id: 'paper', triples: config.PAPER_PLAN.map((x) => x.slice()) };

  // ---------------------------------------------------------------- helpers

  const partOf = (key) => config.PARTS.find((p) => p.key === key);
  const topCentre = (pose, h) => { const M = matOf(pose.p, pose.quat); return xform(M, [0, h, 0]); };
  const tcpNow = () => fk(q, B).tcp;
  const toolPoseNow = () => { const T = tcpNow(); return { p: pos(T), x: axisX(T), z: axisZ(T) }; };

  function getViews(k) {
    if (viewCache.has(k)) return viewCache.get(k);
    const out = [];
    let seedQ = RB.home;
    scanViews(config, k).forEach((v, j) => {
      const r = ikWorld(v.tool, seedQ, B);
      if (r.ok && armClearance(r.q, config) > config.ARM_COLLISION.tableClearance) { out.push({ index: j, q: r.q, camToWorld: cameraWorld(r.q, config) }); seedQ = r.q; }
    });
    viewCache.set(k, out);
    return out;
  }
  const trueK = () => makeK({ fx: config.CAMERA.fx, fy: config.CAMERA.fy, cx: config.CAMERA.cx, cy: config.CAMERA.cy });
  const usedK = () => assumedK(trueK(), config.CAMERA.width, params, config);
  const perceptionKey = () => ['views.k', 'depth.sigmaMm', 'camera.fx', 'mask.erodePx', 'handeye.errMm', 'detect.threshold'].map((k) => params[k]).join('|') + '|' + seed;

  // ---------------------------------------------------------------- oracle perception

  /** A true world point as the pipeline would reconstruct it from the given views (no random part). */
  function distortPoint(P, views) {
    const Kt = trueK(), Ku = usedK(), delta = handEyeDelta(seed, params['handeye.errMm']);
    const acc = [0, 0, 0];
    let depth = 0;
    for (const v of views) {
      const px = project(worldToCam(P, v.camToWorld), Kt);
      const Pc = eq4(px.u, px.v, px.d, Ku);
      const Pw = eq5(Pc, mul(v.camToWorld, trans(delta[0], delta[1], delta[2])));
      acc[0] += Pw[0]; acc[1] += Pw[1]; acc[2] += Pw[2]; depth += px.d;
    }
    const n = views.length;
    return { P: [acc[0] / n, acc[1] / n, acc[2] / n], depth: depth / n };
  }
  /** Oracle estimate of a top-face centre: distortions + Gaussian error scaled from the depth noise (config.ORACLE). */
  function oracleCentre(P, views, r) {
    const d = distortPoint(P, views);
    const O = config.ORACLE;
    const sd = depthSigma(d.depth, params['depth.sigmaMm'], config.DEPTH_NOISE.d0);
    const g = Math.tanh(sd / O.knee), k4 = Math.pow(views.length, 0.25);
    const sxz = Math.hypot(O.floor * g, (O.cXZ * sd) / k4), sy = (O.cY * sd) / k4;
    return { P: [d.P[0] + r.gauss() * sxz, d.P[1] + r.gauss() * sy, d.P[2] + r.gauss() * sxz], depth: d.depth, sd, g };
  }
  function oraclePixels(key, depth) {
    const dims = partDims(config, partOf(key));
    const rpx = Math.max(0, (config.CAMERA.fx * dims.pitchR) / depth - params['mask.erodePx']);
    return Math.PI * rpx * rpx;
  }
  function oracleHidden(key, poses) {
    const me = poses[key], dm = partDims(config, partOf(key));
    let hidden = 0;
    for (const other of config.PARTS) {
      if (other.key === key) continue;
      const o = poses[other.key], doo = partDims(config, other);
      if (o.p[1] <= me.p[1] + dm.height * 0.5) continue;                 // not above
      const dist = Math.hypot(o.p[0] - me.p[0], o.p[2] - me.p[2]);
      const full = doo.tipR - dm.pitchR, none = doo.tipR + dm.pitchR;
      const f = dist <= full ? 1 : dist >= none ? 0 : (none - dist) / (none - full);
      hidden = Math.max(hidden, f);
    }
    return hidden;
  }
  function oraclePart(key, poses, views, r) {
    const dims = partDims(config, partOf(key));
    const c = oracleCentre(topCentre(poses[key], dims.height), views, r);
    const maskPixels = oraclePixels(key, c.depth);
    const hidden = oracleHidden(key, poses);
    const score = detectorScore(config, maskPixels * (1 - hidden), hidden);
    const detected = maskPixels * (1 - hidden) >= config.SCAN.minPixels && score >= params['detect.threshold'];
    return { key, detected, score, maskPixels, hidden, center: c.P, depth: c.depth, sd: c.sd, g: c.g, axis: defaultJaw(config) };
  }
  const currentPoses = () => { const o = {}; for (const p of config.PARTS) o[p.key] = physics.partPose(p.key); return o; };

  function ensureMemoryOracle(views) {
    const key = perceptionKey();
    if (memory && memoryKey === key) return;
    memory = {}; memoryKey = key;
    const r = rng.fork('memory|' + key);
    for (const part of config.PARTS) {
      const m = oraclePart(part.key, memoryStage(config, part.key), views, r);
      memory[part.key] = { center: m.center, detected: m.detected, cloud: null };
    }
  }

  function oracleResult(sk, ok, views, index) {
    ensureMemoryOracle(views);
    const r = rng.fork(`scan|${index}|${planState.done}|${tick}`);
    const poses = currentPoses();
    const cur = oraclePart(sk, poses, views, r);
    const mem = memory[sk];
    const O = config.ORACLE;
    const e = [r.gauss() * O.icp * cur.g, r.gauss() * 0.2 * O.icp * cur.g, r.gauss() * O.icp * cur.g];
    const place = add(mem.center, e);
    const T = sub(place, cur.center);
    const res = {
      part: sk, detected: cur.detected && mem.detected, score: cur.score, oracle: true,
      pick: { center: cur.center, axis: cur.axis, topY: cur.center[1] },
      place: { center: place, R: I3.slice(), T, T_rou: sub(mem.center, cur.center), rmse: Math.hypot(...e), converged: true, iters: 0 },
      cloud: { nPoints: Math.round(cur.maskPixels * views.length), views: views.length, centroid: cur.center },
      object: null,
    };
    if (ok !== 'cover') {
      const oc = oraclePart(ok, poses, views, r);
      res.object = { key: ok, detected: oc.detected, center: oc.center, memCenter: memory[ok].center };
    }
    // events: one worked pixel per view (the projection of the true top centre), the cloud summary, the alignment summary
    const dims = partDims(config, partOf(sk));
    const Ptrue = topCentre(poses[sk], dims.height);
    const Ku = usedK(), Kt = trueK(), delta = handEyeDelta(seed, params['handeye.errMm']);
    views.forEach((v, j) => {
      const px = project(worldToCam(Ptrue, v.camToWorld), Kt);
      const G = mul(v.camToWorld, trans(delta[0], delta[1], delta[2]));
      const Pc = eq4(px.u, px.v, px.d, Ku), Pw = eq5(Pc, G), ck = crossCheck(px.u, px.v, px.d, Ku, G);
      emit('capture', { view: j, k: views.length, K: Ku, camToWorld: G, pixel: px, P_cam: Pc, P_world: Pw, check: ck.P_world, checkErr: ck.err, reproj: ck.reproj, part: sk, oracle: true });
    });
    emit('cloud', { part: sk, nPoints: res.cloud.nPoints, views: views.length, centroid: cur.center, score: cur.score, detected: cur.detected, oracle: true });
    emit('icp', { part: sk, iter: 0, rmse: res.place.rmse, T_rou: res.place.T_rou, R: res.place.R, T: res.place.T, converged: true, oracle: true });
    return res;
  }

  // ---------------------------------------------------------------- image pipeline (captures supplied from outside)

  function pipelineMemory(key, captures) {
    const r = rng.fork('memory|' + key + '|' + perceptionKey());
    const m = perceivePart(captures, key, config, params, { rng: r, delta: handEyeDelta(seed, params['handeye.errMm']) });
    memory[key] = { center: m.grasp ? m.grasp.center : m.centroid, detected: m.detected, cloud: m.cloud };
  }
  function pipelineResult(sk, ok, captures, index) {
    const r = rng.fork(`scan|${index}|${planState.done}|${tick}`);
    const delta = handEyeDelta(seed, params['handeye.errMm']);
    const cur = perceivePart(captures, sk, config, params, { rng: r, delta });
    for (const e of cur.events) { const { type, ...rest } = e; emit(type, rest); }
    const mem = memory[sk];
    const res = {
      part: sk, detected: cur.detected && !!mem && mem.detected, score: cur.score, oracle: false,
      pick: cur.grasp ? { center: cur.grasp.center, axis: cur.grasp.axis, topY: cur.grasp.topY, ratio: cur.grasp.ratio, candidates: cur.grasp.candidates } : null,
      place: null, object: null,
      cloud: { nPoints: cur.cloud.length, views: captures.length, centroid: cur.centroid, points: cur.cloud, memory: mem ? mem.cloud : null },
    };
    if (res.detected) {
      const al = alignToMemory(cur, mem, sk, params, config);
      for (const e of al.events) { const { type, ...rest } = e; emit(type, rest); }
      res.place = { center: applyRT(al.R, al.T, cur.grasp.center), R: al.R, T: al.T, T_rou: al.T_rou, rmse: al.rmse, converged: al.converged, iters: al.iters };
    }
    if (ok !== 'cover') {
      const oc = perceivePart(captures, ok, config, params, { rng: r, delta });
      res.object = { key: ok, detected: oc.detected && !!memory[ok], center: oc.grasp ? oc.grasp.center : null, memCenter: memory[ok] ? memory[ok].center : null };
    }
    return res;
  }

  // ---------------------------------------------------------------- primitives (each: update() -> undefined | result)

  function primMove(traj, { guard = null, onDone = null } = {}) {
    let tau = 0;
    return {
      name: traj.kind,
      update() {
        if (guard) { const g = guard(); if (g) { qd = [0, 0, 0, 0, 0, 0]; return { ok: false, stopped: g }; } }
        tau = Math.min(traj.T, tau + dt);
        const s = traj.sample(tau);
        q = s.q; qd = s.qd;
        if (tau >= traj.T) { qd = [0, 0, 0, 0, 0, 0]; if (onDone) onDone(); return { ok: true }; }
        return undefined;
      },
    };
  }
  function primWait(seconds, until = null) {
    let el = 0;
    return { name: 'wait', update() { el += dt; if (el >= seconds && (!until || until(el))) return { ok: true, elapsed: el }; return undefined; } };
  }
  function primGrip(target) {
    widthCmd = Math.max(GR.minWidth, Math.min(RB.gripper.strokeMax, target));
    const closing = widthCmd < width;
    let extra = 0;
    return {
      name: closing ? 'close' : 'open',
      update() {
        if (closing) {
          if (physics.holding) { extra += dt; if (extra > 0.05) return { ok: true, grasped: physics.holding }; return undefined; }
          if (stall) return { ok: true, grasped: null, stalled: true };
          if (Math.abs(width - widthCmd) < 1e-9) return { ok: true, grasped: null };
          return undefined;
        }
        if (Math.abs(width - widthCmd) < 1e-9) return { ok: true };
        return undefined;
      },
    };
  }
  function primObserve(request) {
    pending = { request, obs: null };
    emit('observe', request);
    return { name: 'observe', update() { if (pending && pending.obs) { const o = pending.obs; pending = null; return o; } return undefined; } };
  }

  // gripper servo, run every tick: closing looks for a grasp, opening lets go
  function gripperTick() {
    stall = false;
    if (width > widthCmd + 1e-12) {
      if (!physics.holding) {
        const g = physics.graspCandidate();
        if (g.best) {
          physics.attach(g.best.key);
          widthCmd = Math.max(GR.minWidth, width - GR.squeeze);
          emit('log', { level: 'info', text: `grasp: both pads on ${g.best.key}, normals ${(g.best.angle * 180 / Math.PI).toFixed(1)} deg apart` });
        } else {
          // a pad that digs into a part that cannot move away means the gripper has stalled
          let deep = 0;
          for (const side of g.contacts) for (const c of side) if (c.dist < deep) deep = c.dist;
          if (deep < -(PH.stallDepth ?? 0.0006)) { stall = true; widthCmd = width; }
        }
      }
      if (!stall) width = Math.max(widthCmd, width - RB.gripper.closeSpeed * dt);
    } else if (width < widthCmd - 1e-12) {
      if (physics.holding) physics.detach();
      width = Math.min(widthCmd, width + RB.gripper.closeSpeed * dt);
    }
  }

  // ---------------------------------------------------------------- motion planning helpers (used inside programs)

  function planJoint(qTarget) {
    const tr = jointMove(q, qTarget, { vmax: RB.jointVelMax, amax: RB.jointAccMax });
    for (let i = 1; i < 10; i++) {
      const s = tr.sample((tr.T * i) / 10).q;
      if (armClearance(s, config) < config.ARM_COLLISION.tableClearance) return { ok: false, reason: 'collision' };
      const tcp = fk(s, B).tcp;
      if (tcp[7] < config.TABLE.topY + 0.03) return { ok: false, reason: 'collision' };
    }
    return { ok: true, traj: tr };
  }
  const clearCheck = (qq) => (armClearance(qq, config) < config.ARM_COLLISION.tableClearance ? 'collision' : null);
  function planLine(poseB, speedScale = 1) { return lineMove(toolPoseNow(), poseB, q, config, { speedScale, check: clearCheck }); }

  function* moveToJoints(qTarget) {
    const pl = planJoint(qTarget);
    if (pl.ok) return yield primMove(pl.traj);
    // via home: both legs are checked again
    const a = planJoint(RB.home);
    if (!a.ok) return { ok: false, reason: pl.reason };
    yield primMove(a.traj);
    const b = planJoint(qTarget);
    if (!b.ok) return { ok: false, reason: b.reason };
    return yield primMove(b.traj);
  }
  function* moveToPose(pose) {
    let r = ikWorld(pose, q, B);
    if (!r.ok) r = ikWorld(pose, RB.home, B);
    if (!r.ok) return { ok: false, reason: 'unreachable', at: pose.p };
    return yield* moveToJoints(r.q);
  }
  function* lineTo(pose, { speedScale = 1, guard = null } = {}) {
    const tr = planLine(pose, speedScale);
    if (!tr.ok) return { ok: false, reason: tr.reason === 'collision' ? 'collision' : 'unreachable', at: tr.at };
    return yield primMove(tr, { guard });
  }
  function reportMoveFailure(r, what) {
    log('warn', `${what}: ${r.reason}${r.at ? ` at (${r.at.map((v) => v.toFixed(3)).join(', ')}) m` : ''}; the arm did not move`);
    emit('ik', { ok: false, reason: r.reason, at: r.at || null, what });
  }

  // ---------------------------------------------------------------- scan

  function* scanScene(index, sk, ok) {
    const k = Math.round(params['views.k']);
    const views = getViews(k);
    if (!views.length) { log('warn', 'scan: no reachable view'); return { failed: 'unreachable' }; }
    if (views.length < k) log('warn', `scan: ${k - views.length} of ${k} views are out of reach and were skipped`);
    if (!oracle) {
      // memory first (once per parameter set): the caller renders each stage from each view
      const key = perceptionKey();
      if (!memory || memoryKey !== key) {
        memory = {}; memoryKey = key;
        for (const part of config.PARTS) {
          const caps = [];
          for (const v of views) {
            const o = yield primObserve({ purpose: 'memory', stage: part.key, poses: memoryStage(config, part.key), view: v.index, k: views.length, q: v.q, camToWorld: v.camToWorld, width: config.CAMERA.width, height: config.CAMERA.height });
            if (o.capture) caps.push(o.capture);
          }
          pipelineMemory(part.key, caps);
        }
        emit('memory', { parts: Object.fromEntries(Object.entries(memory).map(([kk, m]) => [kk, { center: m.center, nPoints: m.cloud ? m.cloud.length : 0, detected: m.detected }])), note: 'assembled-state observation: Not stated in the paper; staged by us' });
      }
    }
    const caps = [];
    let injected = null;
    for (const v of views) {
      const mv = yield* moveToJoints(v.q);
      if (mv && mv.ok === false) { reportMoveFailure(mv, 'scan view'); continue; }
      yield primWait(config.SCAN.dwell);
      if (!oracle) {
        const o = yield primObserve({ purpose: 'scan', step: index, part: sk, object: ok, view: v.index, k: views.length, q: q.slice(), camToWorld: cameraWorld(q, config), width: config.CAMERA.width, height: config.CAMERA.height });
        if (o.result) { injected = o.result; break; }
        if (o.capture) caps.push(o.capture);
      }
    }
    let result;
    if (oracle) { result = oracleResult(sk, ok, views, index); if (perceptionHook) result = perceptionHook(result, { index, part: sk, object: ok }) || result; }
    else if (injected) result = injected;
    else if (!caps.length) return { failed: 'not detected' };
    else result = pipelineResult(sk, ok, caps, index);
    lastScan = { index, result, t };
    emit('perception', { step: index, part: sk, detected: result.detected, score: result.score, pick: result.pick, place: result.place, object: result.object, oracle: !!result.oracle });
    return result;
  }

  // ---------------------------------------------------------------- one plan step

  function nearestShaft(P, maxDist = 0.015) {
    let best = null;
    for (const name of Object.keys(config.COVER.shafts)) {
      const s = shaftTop(config, name), d = Math.hypot(s[0] - P[0], s[2] - P[2]);
      if (d < maxDist && (!best || d < best.d)) best = { name, top: s, d };
    }
    return best;
  }
  function setWaypoints(phase, P, T, coeffs, points, index) {
    waypointState = { phase, P, T, coeffs, points, index };
    emit('waypoints', { phase, P, T, coeffs, points, index });
  }
  function stepEvent(index, triple, status, extra = {}) {
    stepState = { index, triple, status, ...extra };
    emit('step', { index, triple, status, reason: extra.reason ?? null, error: extra.error ?? null });
  }
  function finish(index, triple, status, reason, error = null) {
    const res = { index, triple, status, reason: reason ?? null, error };
    planState.results[index] = res;
    planState.done = planState.results.filter(Boolean).length;
    planState.success = planState.results.filter((r) => r && r.status === 'success').length;
    planState.fail = planState.results.filter((r) => r && r.status === 'fail').length;
    stepEvent(index, triple, status, { reason, error });
    emit('plan', { id: plan.id, n: plan.triples.length, done: planState.done, success: planState.success, fail: planState.fail });
    return res;
  }

  function* retreat(P, jaw) {
    widthCmd = RB.gripper.strokeMax;
    yield primGrip(RB.gripper.strokeMax);
    const r = yield* lineTo(topDownPose(P, jaw));
    if (r && r.ok === false) reportMoveFailure(r, 'retreat');
  }

  function* stepProgram(index) {
    const triple = plan.triples[index];
    const [s, p, o] = triple;
    stepEvent(index, triple, 'start');
    const sk = resolveName(s, config.ALIASES);
    let ok = resolveName(o, config.ALIASES);
    if (!sk) return finish(index, triple, 'skipped', 'unknown object');
    if (sk === 'cover') return finish(index, triple, 'skipped', 'fixed part');
    // The object of the triple is not needed to compute the place pose: that comes from the subject's own memory
    // (assembled-state cloud). With match.strict = 0 an object that is not a node of the scene is tolerated.
    let objectUnknown = false;
    if (!ok || sk === ok) {
      if (params['match.strict'] >= 0.5) return finish(index, triple, 'skipped', 'unknown object');
      objectUnknown = true; ok = 'cover';
      log('info', `step ${index + 1}: object "${o}" is not a part in the scene; placing ${sk} by its remembered pose`);
    }
    let action = actionFor(p, config.RELATIONS);
    if (!action) return finish(index, triple, 'skipped', 'unknown relation');
    if (objectUnknown && action === 'onto') action = 'insert';
    const part = partOf(sk), dims = partDims(config, part), lift = GR.lift[part.kind];
    const seat = seatPose(config, part);
    if (judge(physics.partPose(sk), seat, config.SUCCESS).ok) return finish(index, triple, 'skipped', 'already placed');

    // ---- perception
    const obs = yield* scanScene(index, sk, ok);
    if (obs.failed) return finish(index, triple, 'fail', obs.failed);
    if (!obs.detected || !obs.pick) return finish(index, triple, 'fail', 'not detected');
    if (obs.object && !obs.object.detected) return finish(index, triple, 'fail', 'object not detected');

    // ---- pick
    stepEvent(index, triple, 'pick');
    const H = params['approach.height'], coeffs = [params['eq7.a'], params['eq7.b'], params['eq7.c']];
    const jawPick = obs.pick.axis, jaw0 = defaultJaw(config);
    const graspP = [obs.pick.center[0], Math.max(config.TABLE.topY + 0.001, obs.pick.center[1] - dims.height + lift), obs.pick.center[2]];
    const P = add(graspP, [0, H, 0]), T = [0, -H, 0];
    const pts = eq7Waypoints(P, T, coeffs);
    setWaypoints('pick', P, T, coeffs, pts, 0);
    widthCmd = RB.gripper.strokeMax;
    let r = yield* moveToPose(topDownPose(P, jaw0));
    if (r.ok === false) { reportMoveFailure(r, 'pick approach'); return finish(index, triple, 'fail', r.reason); }
    yield primGrip(RB.gripper.strokeMax);
    setWaypoints('pick', P, T, coeffs, pts, 1);
    r = yield* lineTo(topDownPose(P, jawPick));                         // second point: turn to the grasp direction in place
    if (r.ok === false) { reportMoveFailure(r, 'pick turn'); return finish(index, triple, 'fail', r.reason); }
    const padGuard = () => { const c = physics.padContacts(-0.0003); return c[0].length || c[1].length ? 'contact' : null; };
    for (let i = 2; i < 6; i++) {
      setWaypoints('pick', P, T, coeffs, pts, i);
      r = yield* lineTo(topDownPose(pts[i], jawPick), { guard: padGuard });
      if (r.ok === false && !r.stopped) { reportMoveFailure(r, 'pick descent'); yield* retreat(P, jawPick); return finish(index, triple, 'fail', r.reason); }
      if (r.stopped) { log('warn', 'pick: a pad touched a part on the way down; stopped there'); break; }
    }
    const g = yield primGrip(GR.minWidth);
    if (g.grasped !== sk) {
      if (g.grasped) log('warn', `pick: caught ${g.grasped} instead of ${sk}`);
      yield* retreat(P, jawPick);
      return finish(index, triple, 'fail', 'no grasp');
    }

    // ---- carry
    stepEvent(index, triple, 'carry');
    let placeC = obs.place.center.slice();
    if (action === 'onto') {
      placeC = obs.object ? [obs.object.center[0], obs.object.center[1] + dims.height, obs.object.center[2]]
        : xform(coverToWorld(config), [(config.COVER.outline[0].x + config.COVER.outline[1].x) / 2, 0, config.COVER.floor + dims.height]);
    } else if (obs.object) {
      placeC = add(placeC, sub(obs.object.center, obs.object.memCenter));  // the seat moves with the object it is attached to
    }
    const sh = nearestShaft(placeC);
    const bottomY = sh ? Math.max(placeC[1] - dims.height, sh.top[1] + GR.releaseClear) : placeC[1] - dims.height + GR.releaseClear;
    const relP = [placeC[0], bottomY + lift, placeC[2]];
    const P2 = add(relP, [0, H, 0]), T2 = [0, -H, 0];
    const pts2 = eq7Waypoints(P2, T2, coeffs);
    // lift straight up to the transfer height, cross to above the target at that height, then go to P2
    const ySafe = Math.max(config.TABLE.topY + GR.safeHeight, P[1]);
    const liftPose = topDownPose([graspP[0], ySafe, graspP[2]], jawPick);
    const putBack = function* (why, rr) {
      reportMoveFailure(rr, why);
      let b = yield* lineTo(liftPose, { speedScale: 2 });
      if (b.ok !== false) b = yield* lineTo(topDownPose(graspP, jawPick));
      yield* retreat(P, jawPick);
      return finish(index, triple, 'fail', rr.reason);
    };
    r = yield* lineTo(liftPose);
    if (r.ok === false) { reportMoveFailure(r, 'lift'); yield* retreat(P, jawPick); return finish(index, triple, 'fail', r.reason); }
    if (physics.holding !== sk) return finish(index, triple, 'fail', 'dropped');
    setWaypoints('place', P2, T2, coeffs, pts2, 0);
    r = yield* lineTo(topDownPose([P2[0], Math.max(ySafe, P2[1]), P2[2]], jawPick), { speedScale: 2 });
    if (r.ok !== false && P2[1] < ySafe) r = yield* lineTo(topDownPose(P2, jawPick));
    if (r.ok === false) return yield* putBack('carry', r);

    // ---- place
    stepEvent(index, triple, 'place');
    let jawPlace = jaw0;
    if (action === 'mesh' && part.kind === 'gear') {
      // turn about the axis to tooth-on-gap: the true yaw of the held gear is used (teeth are not perceived or simulated)
      const pitch = (2 * Math.PI) / dims.teeth;
      const yawNow = 2 * Math.atan2(physics.partPose(sk).quat[1], physics.partPose(sk).quat[3]);
      const base = Math.atan2(jawPick[0], jawPick[2]), want = Math.atan2(jaw0[0], jaw0[2]);
      let d = (config.COVER.world.yaw + meshPhase(config, sk)) - (yawNow + (want - base));
      d -= Math.round(d / pitch) * pitch;
      const a = want + d;
      jawPlace = [Math.sin(a), 0, Math.cos(a)];
    }
    setWaypoints('place', P2, T2, coeffs, pts2, 1);
    r = yield* lineTo(topDownPose(P2, jawPlace));
    if (r.ok === false) return yield* putBack('place turn', r);
    const heldGuard = () => (physics.heldTouching(-0.0003) ? 'contact' : null);
    for (let i = 2; i < 6; i++) {
      setWaypoints('place', P2, T2, coeffs, pts2, i);
      r = yield* lineTo(topDownPose(pts2[i], jawPlace), { guard: heldGuard });
      if (r.ok === false && !r.stopped) { reportMoveFailure(r, 'place descent'); break; }
      if (r.stopped) { log('info', 'place: the held part touched something; released there'); break; }
    }
    const tRelease = t;
    yield primGrip(Math.min(RB.gripper.strokeMax, width + 0.03));
    stepEvent(index, triple, 'settle');
    r = yield* lineTo(topDownPose(P2, jawPlace));
    if (r.ok === false) reportMoveFailure(r, 'place retreat');
    yield primGrip(RB.gripper.strokeMax);
    const atRest = () => { const v = physics.partSpeed(sk); return v.lin < PH.settleSpeed && v.ang < 0.1; };
    let quiet = 0;
    yield primWait(Math.max(0, PH.settleTime - (t - tRelease)), (el) => { quiet = atRest() ? quiet + dt : 0; return quiet >= 0.15 || t - tRelease > PH.settleMax; });

    if (action === 'screw') yield* screwTurns(sk, 2);

    const verdict = judge(physics.partPose(sk), seat, config.SUCCESS);
    return finish(index, triple, verdict.ok ? 'success' : 'fail', verdict.ok ? null : 'not seated', verdict.error);
  }

  /** 'screw': grip the part where it rests and turn it about its axis, half a turn per stroke. Best effort. */
  function* screwTurns(key, turns) {
    const part = partOf(key), lift = GR.lift[part.kind];
    const pose = physics.partPose(key);
    if (tiltOf(pose.quat) > 0.1) { log('warn', 'screw: the part is not upright; no turns made'); return; }
    // turn about the shaft axis when the part sits on one (the part rests off-centre by up to the bore clearance)
    const sh = nearestShaft(pose.p, 0.002);
    const gp = [sh ? sh.top[0] : pose.p[0], pose.p[1] + lift, sh ? sh.top[2] : pose.p[2]], up = add(gp, [0, 0.03, 0]);
    const y0 = topDownPose(gp, defaultJaw(config));                    // standard orientation (joint 6 near zero)
    const yawPose = (p, a) => {                                        // y0 turned by a about the vertical
      const c = Math.cos(a), sn = Math.sin(a), x = y0.x;
      return { p: p.slice(), x: [c * x[0] + sn * x[2], 0, -sn * x[0] + c * x[2]], z: [0, -1, 0] };
    };
    const guard = () => { const d = physics.heldDeepest(); if (d && d.dist < -0.0015) { log("info", `screw guard: ${d.other} ${(d.dist * 1000).toFixed(2)} mm`); return "contact"; } return null; };
    let strokes = 0;
    for (let i = 0; i < turns * 2; i++) {
      let r = yield* lineTo(yawPose(up, 0));                           // back through the middle: a 180 deg slerp has no defined direction
      if (r.ok !== false) r = yield* lineTo(yawPose(up, -Math.PI / 2));
      if (r.ok !== false) r = yield* lineTo(yawPose(gp, -Math.PI / 2));
      if (r.ok === false) { reportMoveFailure(r, 'screw'); break; }
      const g = yield primGrip(GR.minWidth);
      if (g.grasped !== key) { log('warn', 'screw: could not grip the part'); break; }
      r = yield* lineTo(yawPose(gp, 0), { guard });                    // two quarter turns, so the direction is defined
      if (r.ok) r = yield* lineTo(yawPose(gp, Math.PI / 2), { guard });
      yield primGrip(Math.min(RB.gripper.strokeMax, width + 0.02));
      if (r.ok === false) { log('warn', `screw: stopped turning (${r.stopped || r.reason})`); break; }
      strokes++;
      r = yield* lineTo(yawPose(up, Math.PI / 2));
      if (r.ok === false) break;
    }
    log('info', `screw: ${strokes / 2} turn(s) made`);
    yield primGrip(RB.gripper.strokeMax);
    yield* lineTo(yawPose(add(gp, [0, params['approach.height'], 0]), 0));
    yield primWait(0.3);
  }

  function* planProgram(from, to) {
    emit('plan', { id: plan.id, n: plan.triples.length, done: planState.done, success: planState.success, fail: planState.fail });
    for (let i = from; i <= to && i < plan.triples.length; i++) {
      planState.next = i + 1;
      yield* stepProgram(i);
    }
    widthCmd = RB.gripper.strokeMax;
    const r = yield* moveToJoints(RB.home);
    if (r && r.ok === false) reportMoveFailure(r, 'return home');
    emit('plan', { id: plan.id, n: plan.triples.length, done: planState.done, success: planState.success, fail: planState.fail, finished: true });
  }

  // ---------------------------------------------------------------- stepping

  function advanceProgram(result) {
    const r = program.next(result);
    if (r.done) { program = null; prim = null; manual.qGoal = q.slice(); } else prim = r.value;
  }
  function startProgram(gen) {
    if (program) program.return();
    program = gen; prim = null; paused = false;
    advanceProgram(undefined);
  }

  function manualTick() {
    // joint servo toward qGoal with velocity and acceleration limits
    const vmax = RB.jointVelMax, amax = RB.jointAccMax;
    for (let i = 0; i < 6; i++) {
      const e = manual.qGoal[i] - q[i];
      const vStop = Math.sqrt(2 * amax * Math.abs(e)) * Math.sign(e);          // speed from which we can still stop at the goal
      let v = Math.max(-vmax, Math.min(vmax, vStop));
      v = Math.max(qd[i] - amax * dt, Math.min(qd[i] + amax * dt, v));
      if (Math.abs(e) < 1e-6 && Math.abs(v) < amax * dt) { q[i] = manual.qGoal[i]; qd[i] = 0; } else { qd[i] = v; q[i] += v * dt; }
    }
  }

  function step1() {
    if (program && !paused) {
      // a primitive may finish immediately; allow a few zero-time transitions per tick
      for (let guard = 0; guard < 8 && program; guard++) {
        if (!prim) break;
        const res = prim.update();
        if (res === undefined) break;
        advanceProgram(res);
        if (prim && (prim.name === 'joint' || prim.name === 'line' || prim.name === 'wait')) break;
      }
    } else if (!program) manualTick();
    else qd = [0, 0, 0, 0, 0, 0];
    gripperTick();
    physics.setRobot(q, width);
    physics.step();
    t += dt; tick++;
    tcpHist.push(physics.robot.tcp);
    if (tcpHist.length > 17) tcpHist.shift();
  }

  /** Advance by dtSeconds in fixed steps of PHYSICS.dt. Returns the events produced. */
  let carry = 0;
  function advance(dtSeconds) {
    carry += dtSeconds;
    let n = Math.floor(carry / dt + 1e-9);
    carry -= n * dt;
    if (n > 2400) n = 2400;                                            // never more than 10 s per call
    for (let i = 0; i < n; i++) {
      step1();
      if (pending && !pending.obs) { carry = 0; break; }               // wait for provideObservation() before going on
    }
    const out = events; events = [];
    return out;
  }

  function actionVector() {
    // A_t = [dx, dy, dz, rx, ry, rz, s]: TCP displacement (m) and rotation (ZYX Euler, rad) over the last 1/15 s, world frame; s = pad opening command (m)
    if (tcpHist.length < 2) return [0, 0, 0, 0, 0, 0, widthCmd];
    const A0 = tcpHist[0], A1 = tcpHist[tcpHist.length - 1];
    const d = sub(pos(A1), pos(A0));
    const e = eulerZYX(mul(invRigid(A0), A1));
    return [d[0], d[1], d[2], e[0], e[1], e[2], widthCmd];
  }

  function state() {
    const rb = physics.robot;
    const parts = {};
    for (const p of config.PARTS) parts[p.key] = physics.partPose(p.key);
    const tcp = rb.tcp;
    const g = physics.padContacts();
    return {
      t, tick, q: q.slice(), qdot: qd.slice(),
      gripper: { width, command: widthCmd, contactL: g[0].length > 0, contactR: g[1].length > 0, holding: physics.holding },
      holding: physics.holding,
      parts, links: rb.links.map((m) => m.slice()), flange: rb.flange.slice(), pads: rb.pads.map((m) => m.slice()), tcpMatrix: tcp.slice(),
      tcp: { p: pos(tcp), rpy: eulerZYX(tcp) },
      camToWorld: cameraWorld(q, config),
      A: actionVector(),
      waypoint: waypointState, step: stepState,
      running: !!program, paused, awaitingObservation: !!(pending && !pending.obs),
      plan: { id: plan.id, n: plan.triples.length, next: planState.next, done: planState.done, success: planState.success, fail: planState.fail, results: planState.results.slice() },
      seed, oracle,
    };
  }

  const sim = {
    config, dt,
    get physics() { return physics; },
    get state() { return state(); },
    get time() { return t; },
    get busy() { return !!program; },
    reset({ seed: s } = {}) { resetState(s ?? seed); emit('log', { level: 'info', text: `reset, seed ${seed}` }); },
    setParam(path, value) {
      const d = config.PARAMS[path];
      if (!d) { log('warn', `unknown parameter ${path}`); return false; }
      const v = Math.max(d.min, Math.min(d.max, Number(value)));
      if (!Number.isFinite(v)) return false;
      params[path] = path === 'views.k' || path === 'icp.maxIters' || path === 'mask.erodePx' ? Math.round(v) : v;
      return true;
    },
    getParams() { return { ...params }; },
    loadPlan(p) {
      plan = { id: p.id ?? 'plan', triples: (p.triples || []).map((x) => x.slice(0, 3)), model: p.model, variant: p.variant, run: p.run, source: p.source };
      planState = { next: 0, results: [], success: 0, fail: 0, done: 0 };
      emit('plan', { id: plan.id, n: plan.triples.length, done: 0, success: 0, fail: 0 });
    },
    advance,
    provideObservation(obs) {
      if (!pending) return false;
      pending.obs = obs && (obs.capture || obs.result) ? obs : { capture: null };
      return true;
    },
    /** Finished perception result the oracle would give for (subject, object) right now; tests modify and inject it. */
    oracleObservation(subject, object = 'cover', index = 0) {
      const sk = resolveName(subject, config.ALIASES) ?? subject, ok = resolveName(object, config.ALIASES) ?? object;
      const keep = events; events = [];
      const res = oracleResult(sk, ok, getViews(Math.round(params['views.k'])), index);
      events = keep;
      return res;
    },
    /** Tests: fn(result, { index, part, object }) may change the oracle's perception result before it is used. */
    setPerceptionHook(fn) { perceptionHook = fn; },
    scanViews: () => getViews(Math.round(params['views.k'])).map((v) => ({ index: v.index, q: v.q.slice(), camToWorld: v.camToWorld.slice() })),
    memoryStage: (key) => memoryStage(config, key),
    get memory() { return memory; },
    get lastScan() { return lastScan; },
    command: {
      runPlan({ from = 0, to = plan.triples.length - 1 } = {}) { startProgram(planProgram(from, to)); },
      stepPlan() { const i = planState.next; if (i >= plan.triples.length) { log('info', 'plan finished; nothing to step'); return false; } startProgram(planProgram(i, i)); return true; },
      pause() { paused = true; }, resume() { paused = false; },
      stop() { if (program) { program.return(); program = null; prim = null; pending = null; } paused = false; qd = [0, 0, 0, 0, 0, 0]; manual.qGoal = q.slice(); widthCmd = width; log('info', 'stopped'); },
      setJoint(i, rad) { if (program) return false; manual.qGoal[i] = Math.max(JOINTS[i].lo, Math.min(JOINTS[i].hi, rad)); return true; },
      setJoints(qq) { if (program) return false; manual.qGoal = clampQ(qq.slice()); return true; },
      /** Move the TCP by a small world-frame step (m, rad about world axes). Reports an 'ik' event and stays put if unreachable. */
      jog({ dx = 0, dy = 0, dz = 0, drx = 0, dry = 0, drz = 0 } = {}) {
        if (program) return false;
        const T = fk(manual.qGoal, B).tcp;
        const rot = (v) => { // rotate v by small world rotations rx, ry, rz
          let [x, y, z] = v;
          let c = Math.cos(drx), s = Math.sin(drx); [y, z] = [c * y - s * z, s * y + c * z];
          c = Math.cos(dry); s = Math.sin(dry); [x, z] = [c * x + s * z, -s * x + c * z];
          c = Math.cos(drz); s = Math.sin(drz); [x, y] = [c * x - s * y, s * x + c * y];
          return [x, y, z];
        };
        const pose = { p: add(pos(T), [dx, dy, dz]), x: rot(axisX(T)), z: rot(axisZ(T)) };
        const r = ikWorld(pose, manual.qGoal, B);
        if (!r.ok || armClearance(r.q, config) < 0) { emit('ik', { ok: false, reason: r.ok ? 'collision' : 'unreachable', at: pose.p, what: 'jog' }); log('warn', 'jog: target out of reach; not moved'); return false; }
        manual.qGoal = r.q; return true;
      },
      /** Move the TCP to a world pose { p, x, z } (gizmo drag). */
      moveTcp(pose) {
        if (program) return false;
        const r = ikWorld(pose, manual.qGoal, B);
        if (!r.ok || armClearance(r.q, config) < 0) { emit('ik', { ok: false, reason: r.ok ? 'collision' : 'unreachable', at: pose.p, what: 'gizmo' }); return false; }
        manual.qGoal = r.q; return true;
      },
      setGripper(w) { if (program) return false; widthCmd = Math.max(GR.minWidth, Math.min(RB.gripper.strokeMax, w)); return true; },
      home() { if (program) return false; manual.qGoal = RB.home.slice(); return true; },
    },
    dispose() { physics.dispose(); },
  };
  return sim;
}
