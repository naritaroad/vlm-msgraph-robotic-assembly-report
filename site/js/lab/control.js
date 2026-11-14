// Control layer: seeded random numbers, Eq. (7) waypoints, trajectories with velocity and acceleration limits,
// name and predicate mapping, the success test, and the geometric grasp rule. Pure functions, no three.js, no DOM.

import { fk, ik, mul, pos, axisX, axisZ, quatOf, matOf, invRigid, xform, unit, cross, dot, JOINTS } from './kinematics.js';
import { armCapsules } from './physics.js';

// ------------------------------------------------------------------ random numbers (only used for perception noise)

/** mulberry32: 32-bit seeded generator, returns a function giving uniform numbers in [0, 1). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a hash of a string to a 32-bit seed, so each noise source gets its own reproducible stream. */
export function hashSeed(seed, label) {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  for (let i = 0; i < label.length; i++) { h ^= label.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h >>> 0;
}

/** Seeded source with uniform() and gauss() (Box-Muller, mean 0, sigma 1). fork(label) gives an independent stream. */
export function makeRng(seed) {
  const u = mulberry32(seed);
  let spare = null;
  return {
    seed,
    uniform: u,
    gauss() {
      if (spare !== null) { const s = spare; spare = null; return s; }
      let a = 0; while (a < 1e-12) a = u();
      const r = Math.sqrt(-2 * Math.log(a)), th = 2 * Math.PI * u();
      spare = r * Math.sin(th);
      return r * Math.cos(th);
    },
    fork(label) { return makeRng(hashSeed(seed, label)); },
  };
}

// ------------------------------------------------------------------ Eq. (7)

/**
 * Eq. (7): <P, P x R, P + aT, P + bT, P + cT, P + T>. Returns six points.
 * The second point has the same position as P: the paper's "P x R" is read as "turn to the grasp direction in place"
 * (the text says the position does not change), so only the orientation differs there.
 */
export function eq7Waypoints(P, T, [a, b, c] = [0.8, 0.92, 0.96]) {
  const at = (k) => [P[0] + k * T[0], P[1] + k * T[1], P[2] + k * T[2]];
  return [at(0), at(0), at(a), at(b), at(c), at(1)];
}

// ------------------------------------------------------------------ names, predicates

export const normName = (s) => String(s ?? '').toLowerCase().replace(/[_\-]+/g, ' ').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

/** Map a free-text name from a triple onto a part key ('red', ..., 'cover') with the alias table. null if unknown. */
export function resolveName(name, ALIASES) {
  const n = normName(name).replace(/^(the|a|an) /, '');
  for (const [key, list] of Object.entries(ALIASES)) if (list.some((a) => normName(a) === n)) return key;
  return null;
}

/**
 * Predicate -> action (docs/lab.md section 4).
 *  'insert': pick, then lower along the shaft axis        (attached to, inserted into, goes through)
 *  'mesh'  : same, turning about the axis to tooth-on-gap before release (meshed with)
 *  'screw' : same, then two turns about the axis after release           (screw)
 *  'onto'  : put on top of the object                                    (the other listed relations)
 *  null    : not in the Fig. 5 list -> not executed, 'unknown relation'
 */
export function actionFor(predicate, RELATIONS) {
  const p = normName(predicate);
  if (!RELATIONS.map(normName).includes(p)) return null;
  if (p === 'attached to' || p === 'inserted into' || p === 'goes through') return 'insert';
  if (p === 'meshed with') return 'mesh';
  if (p === 'screw') return 'screw';
  return 'onto';
}

// ------------------------------------------------------------------ success test

/** Tilt (rad) of a body's +y axis from world +y. */
export function tiltOf(quat) {
  const yy = 1 - 2 * (quat[0] * quat[0] + quat[2] * quat[2]);
  return Math.acos(Math.max(-1, Math.min(1, yy)));
}

/**
 * A step succeeds only by the part's final pose (config.SUCCESS): horizontal distance, height difference and tilt
 * against the seat pose. Returns { ok, error: { pos_mm, height_mm, tilt_deg } }. No random numbers.
 */
export function judge(pose, seat, SUCCESS) {
  const pos_mm = Math.hypot(pose.p[0] - seat.p[0], pose.p[2] - seat.p[2]) * 1000;
  const height_mm = (pose.p[1] - seat.p[1]) * 1000;
  const tilt_deg = (tiltOf(pose.quat) * 180) / Math.PI;
  const ok = pos_mm < SUCCESS.posMm && Math.abs(height_mm) < SUCCESS.heightMm && tilt_deg < SUCCESS.tiltDeg;
  return { ok, error: { pos_mm, height_mm, tilt_deg } };
}

// ------------------------------------------------------------------ grasp rule (stands in for AnyGrasp)

/**
 * Top-down grasp from a part's point cloud (world, y up).
 * centre = centroid of the top face (points within `topBand` of the top plane); jaw axis = perpendicular to the
 * principal horizontal axis of the top face, or `defaultAxis` when the face is round (eigenvalue ratio < anisotropy).
 * Returns { center:[x,y,z], topY, axis:[x,0,z] (unit, closing direction), ratio, nTop, candidates:[axis,...] }.
 */
export function graspFromCloud(points, { topBand = 0.0015, anisotropy = 1.3, defaultAxis = [0, 0, 1] } = {}) {
  if (!points.length) return null;
  const ys = points.map((p) => p[1]).sort((a, b) => a - b);
  const topY = ys[Math.min(ys.length - 1, Math.floor(ys.length * 0.9))];
  const top = points.filter((p) => Math.abs(p[1] - topY) <= topBand);
  const use = top.length >= 8 ? top : points;
  let cx = 0, cy = 0, cz = 0;
  for (const p of use) { cx += p[0]; cy += p[1]; cz += p[2]; }
  cx /= use.length; cy /= use.length; cz /= use.length;
  let sxx = 0, sxz = 0, szz = 0;
  for (const p of use) { const dx = p[0] - cx, dz = p[2] - cz; sxx += dx * dx; sxz += dx * dz; szz += dz * dz; }
  const tr = sxx + szz, det = sxx * szz - sxz * sxz, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
  const l1 = tr / 2 + disc, l2 = Math.max(1e-18, tr / 2 - disc);
  const ratio = l1 / l2;
  let axis = unit([defaultAxis[0], 0, defaultAxis[2]]);
  const ang = 0.5 * Math.atan2(2 * sxz, sxx - szz);            // principal axis angle in the x-z plane
  const principal = [Math.cos(ang), 0, Math.sin(ang)];
  const perp = [-principal[2], 0, principal[0]];
  if (ratio >= anisotropy) axis = perp;
  const candidates = [0, 45, 90, 135].map((d) => { const a = (d * Math.PI) / 180; return [Math.cos(a), 0, Math.sin(a)]; });
  return { center: [cx, cy, cz], topY: cy, axis, ratio, nTop: use.length, principal, candidates };
}

// ------------------------------------------------------------------ tool poses

/**
 * Tool frame for a top-down grasp in the world: tool z = down (-y), pads close along `jaw` (tool y).
 * Returns { p, x, z } (world) for ik(). The sign of the jaw axis is chosen so the tool x axis points away from the
 * robot base (keeps joint 6 near zero).
 */
export function topDownPose(p, jaw, awayDir = [-1, 0, 0]) {
  const z = [0, -1, 0];
  let y = unit([jaw[0], 0, jaw[2]]);
  let x = cross(y, z);
  if (dot(x, awayDir) < 0) { y = [-y[0], 0, -y[2]]; x = cross(y, z); }
  return { p: p.slice(), x, z };
}

/** World tool pose { p, x, z } -> the same pose in the robot base frame (for ik()). */
export function toBase(pose, baseToWorld) {
  const W = invRigid(baseToWorld);
  const r = (v) => [W[0] * v[0] + W[1] * v[1] + W[2] * v[2], W[4] * v[0] + W[5] * v[1] + W[6] * v[2], W[8] * v[0] + W[9] * v[1] + W[10] * v[2]];
  return { p: xform(W, pose.p), x: r(pose.x), z: r(pose.z) };
}

/** IK for a world tool pose. Returns { q, ok, err, rotErr }. */
export function ikWorld(pose, seed, baseToWorld) { return ik(toBase(pose, baseToWorld), seed); }

/** World TCP matrix for joint angles. */
export function tcpWorld(q, baseToWorld) { return fk(q, baseToWorld).tcp; }

/** Camera optical frame (world 4x4) for joint angles, from config.CAMERA.mount. */
export function cameraWorld(q, config) {
  const flange = fk(q, config.ROBOT.baseToWorld).frames[5];
  return mul(flange, cameraMount(config));
}
export function cameraMount(config) {
  const m = config.CAMERA.mount, [r, p, y] = m.rpy;
  const cz = Math.cos(y), sz = Math.sin(y), cyy = Math.cos(p), sy = Math.sin(p), cx = Math.cos(r), sx = Math.sin(r);
  // R = Rz(yaw) * Ry(pitch) * Rx(roll)
  return [
    cz * cyy, cz * sy * sx - sz * cx, cz * sy * cx + sz * sx, m.xyz[0],
    sz * cyy, sz * sy * sx + cz * cx, sz * sy * cx - cz * sx, m.xyz[1],
    -sy, cyy * sx, cyy * cx, m.xyz[2],
    0, 0, 0, 1];
}

/**
 * The k scan views of config.SCAN: camera poses on a circle above SCAN.center, each looking at the centre, with the
 * image "down" direction toward the robot. Returns [{ camToWorld, tool: { p, x, z } }]; tool is the TCP pose that
 * puts the camera there.
 */
export function scanViews(config, k) {
  const S = config.SCAN, out = [];
  const M = cameraMount(config), Mi = invRigid(M);
  const tcpInFlange = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, config.ROBOT.gripper.tcpOffset, 0, 0, 0, 1];
  const toRobot = unit([config.ROBOT.basePosition[0] - S.center[0], 0, config.ROBOT.basePosition[2] - S.center[2]]);
  for (let j = 0; j < k; j++) {
    const phi = (2 * Math.PI * j) / k + Math.PI / 2;
    const rho = k === 1 ? 0 : S.radius;
    const eye = [S.center[0] + rho * Math.cos(phi), S.center[1] + S.height, S.center[2] + rho * Math.sin(phi)];
    const zc = unit([S.center[0] - eye[0], S.center[1] - eye[1], S.center[2] - eye[2]]);
    let yc = [toRobot[0] - dot(toRobot, zc) * zc[0], toRobot[1] - dot(toRobot, zc) * zc[1], toRobot[2] - dot(toRobot, zc) * zc[2]];
    yc = unit(yc);
    const xc = cross(yc, zc);
    const cam = [xc[0], yc[0], zc[0], eye[0], xc[1], yc[1], zc[1], eye[1], xc[2], yc[2], zc[2], eye[2], 0, 0, 0, 1];
    const flange = mul(cam, Mi);
    const tcp = mul(flange, tcpInFlange);
    out.push({ camToWorld: cam, tool: { p: pos(tcp), x: axisX(tcp), z: axisZ(tcp) } });
  }
  return out;
}

// ------------------------------------------------------------------ trajectories

/** Quintic time scaling: s(0)=0, s(1)=1, zero velocity and acceleration at both ends. */
export function quintic(tau) {
  const t = Math.max(0, Math.min(1, tau));
  return { s: t * t * t * (10 - 15 * t + 6 * t * t), ds: 30 * t * t * (1 - t) * (1 - t), dds: 60 * t * (1 - t) * (1 - 2 * t) };
}
const QUINTIC_VPEAK = 1.875, QUINTIC_APEAK = 5.7735;

/** Shortest duration of a quintic move over `dist` with peak velocity <= vmax and peak acceleration <= amax. */
export function quinticDuration(dist, vmax, amax) {
  return Math.max((QUINTIC_VPEAK * dist) / vmax, Math.sqrt((QUINTIC_APEAK * dist) / amax));
}

/**
 * Joint-space quintic from q0 to q1 under ROBOT.jointVelMax and ROBOT.jointAccMax.
 * Returns { kind:'joint', T, sample(t) -> { q, qd }, q0, q1 }.
 */
export function jointMove(q0, q1, { vmax, amax, minT = 0.05 }) {
  let T = minT;
  for (let i = 0; i < 6; i++) T = Math.max(T, quinticDuration(Math.abs(q1[i] - q0[i]), vmax, amax));
  return {
    kind: 'joint', T, q0: q0.slice(), q1: q1.slice(),
    sample(t) {
      const { s, ds } = quintic(t / T);
      return { q: q0.map((v, i) => v + (q1[i] - v) * s), qd: q0.map((v, i) => ((q1[i] - v) * ds) / T) };
    },
  };
}

function slerp(a, b, t) {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  let bb = b;
  if (d < 0) { d = -d; bb = [-b[0], -b[1], -b[2], -b[3]]; }
  if (d > 0.9999995) { const o = a.map((v, i) => v + (bb[i] - v) * t); const n = Math.hypot(...o); return o.map((v) => v / n); }
  const th = Math.acos(d), s = Math.sin(th), wa = Math.sin((1 - t) * th) / s, wb = Math.sin(t * th) / s;
  return a.map((v, i) => wa * v + wb * bb[i]);
}
const poseMat = (pose) => { const y = cross(pose.z, pose.x); return [pose.x[0], y[0], pose.z[0], pose.p[0], pose.x[1], y[1], pose.z[1], pose.p[1], pose.x[2], y[2], pose.z[2], pose.p[2], 0, 0, 0, 1]; };

/**
 * Straight line in Cartesian space from tool pose A to tool pose B (world), orientation by slerp, IK at every knot.
 * Timing is a quintic with the TCP speed limited to tcpSpeedMax and every joint inside its velocity and
 * acceleration limits. Returns { ok:false, reason, at } when a knot has no IK solution or a joint would jump;
 * the caller reports that and does not move.
 */
export function lineMove(poseA, poseB, qStart, config, { speedScale = 1, knotStep = 0.002, check = null } = {}) {
  const R = config.ROBOT, B = R.baseToWorld;
  const L = Math.hypot(poseB.p[0] - poseA.p[0], poseB.p[1] - poseA.p[1], poseB.p[2] - poseA.p[2]);
  const qa = quatOf(poseMat(poseA)), qb = quatOf(poseMat(poseB));
  const ang = 2 * Math.acos(Math.min(1, Math.abs(qa[0] * qb[0] + qa[1] * qb[1] + qa[2] * qb[2] + qa[3] * qb[3])));
  const n = Math.max(2, Math.ceil(L / knotStep), Math.ceil(ang / 0.02));
  const knots = [qStart.slice()];
  let q = qStart.slice();
  const travel = [0, 0, 0, 0, 0, 0];
  for (let i = 1; i <= n; i++) {
    const s = i / n;
    const M = matOf([poseA.p[0] + (poseB.p[0] - poseA.p[0]) * s, poseA.p[1] + (poseB.p[1] - poseA.p[1]) * s, poseA.p[2] + (poseB.p[2] - poseA.p[2]) * s], slerp(qa, qb, s));
    const pose = { p: pos(M), x: axisX(M), z: axisZ(M) };
    const r = ikWorld(pose, q, B);
    if (!r.ok) return { ok: false, reason: 'ik', at: pose.p, err: r.err };
    let jump = 0;
    for (let j = 0; j < 6; j++) { const d = Math.abs(r.q[j] - q[j]); travel[j] += d; if (d > jump) jump = d; }
    if (jump > 0.35) return { ok: false, reason: 'ik jump', at: pose.p, err: jump };
    if (check) { const c = check(r.q); if (c) return { ok: false, reason: c, at: pose.p }; }
    q = r.q; knots.push(q);
  }
  let T = Math.max(0.05, quinticDuration(L, R.tcpSpeedMax * speedScale, 4.0), quinticDuration(ang, 2.0, 12.0));
  for (let j = 0; j < 6; j++) T = Math.max(T, quinticDuration(travel[j], R.jointVelMax, R.jointAccMax));
  return {
    ok: true, kind: 'line', T, length: L, knots, q0: knots[0], q1: knots[n],
    sample(t) {
      const { s, ds } = quintic(t / T);
      const f = s * n, i = Math.min(n - 1, Math.floor(f)), a = f - i;
      const k0 = knots[i], k1 = knots[i + 1];
      return { q: k0.map((v, j) => v + (k1[j] - v) * a), qd: k0.map((v, j) => ((k1[j] - v) * n * ds) / T) };
    },
  };
}

/**
 * Lowest clearance (m) between the arm capsules and the table top / cover for joint angles q.
 * Negative means the arm would pass through. Used at planning time: the kinematic arm is not stopped by physics.
 */
export function armClearance(q, config) {
  const { frames } = fk(q, config.ROBOT.baseToWorld);
  const caps = armCapsules(config, frames, frames[5]);
  const T = config.TABLE, C = config.COVER;
  const tx0 = T.center[0] - T.size[0] / 2, tx1 = T.center[0] + T.size[0] / 2, tz0 = T.center[1] - T.size[2] / 2, tz1 = T.center[1] + T.size[2] / 2;
  const coverTop = C.world.position[1] + Math.max(...Object.values(C.shafts).map((s) => s.top));
  const cr = Math.max(...C.outline.map((o) => Math.abs(o.x) + o.r)) + C.wall;
  let min = Infinity;
  for (const c of caps) for (let i = 0; i <= 6; i++) {
    const t = i / 6, x = c.a[0] + (c.b[0] - c.a[0]) * t, y = c.a[1] + (c.b[1] - c.a[1]) * t, z = c.a[2] + (c.b[2] - c.a[2]) * t;
    if (x > tx0 - c.r && x < tx1 + c.r && z > tz0 - c.r && z < tz1 + c.r) {
      let surf = T.topY;
      if (Math.hypot(x - C.world.position[0], z - C.world.position[2]) < cr + c.r) surf = coverTop;
      min = Math.min(min, y - c.r - surf);
    }
  }
  return min;
}

/** Joint limits check. */
export function withinLimits(q, margin = 0) { return q.every((v, i) => v >= JOINTS[i].lo + margin && v <= JOINTS[i].hi - margin); }
