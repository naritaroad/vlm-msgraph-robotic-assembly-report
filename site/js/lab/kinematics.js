// xArm6 kinematics in the ROS frame (z up, metres).
// Joint origins and limits: xarm_ros/xarm_description/config/kinematics/default/xarm6_default_kinematics.yaml
// Gripper and TCP: xarm_ros/xarm_description/urdf/gripper/xarm_gripper.urdf.xacro (TCP z = 0.172 m).
// Pure math, no three.js, so Node tests can import it.

export const JOINTS = [
  { name: 'joint1', xyz: [0, 0, 0.267], rpy: [0, 0, 0], lo: -0.99 * Math.PI, hi: 0.99 * Math.PI },
  { name: 'joint2', xyz: [0, 0, 0], rpy: [-Math.PI / 2, 0, 0], lo: -2.059, hi: 2.0944 },
  { name: 'joint3', xyz: [0.0535, -0.2845, 0], rpy: [0, 0, 0], lo: -0.99 * Math.PI, hi: 0.19198 },
  { name: 'joint4', xyz: [0.0775, 0.3425, 0], rpy: [-Math.PI / 2, 0, 0], lo: -0.99 * Math.PI, hi: 0.99 * Math.PI },
  { name: 'joint5', xyz: [0, 0, 0], rpy: [Math.PI / 2, 0, 0], lo: -1.69297, hi: 0.99 * Math.PI },
  { name: 'joint6', xyz: [0.076, 0.097, 0], rpy: [-Math.PI / 2, 0, 0], lo: -0.99 * Math.PI, hi: 0.99 * Math.PI },
];
export const TCP_Z = 0.172;           // gripper base -> TCP
export const HOME = [0, -0.6, -0.6, 0, 1.2, 0];
export const VMAX = 3.14;             // rad/s, xArm6 joint velocity limit
export const GRIP_MAX = 0.85;         // drive_joint upper limit (rad); 0 = open
export const GRIP_STROKE = 0.085;     // m, finger opening at drive 0 (xArm Gripper spec)

// ---- 4x4 row-major matrices as flat arrays of 16 ----
export function mul(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  }
  return o;
}
export function ident() { return [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
export function trans(x, y, z) { return [1, 0, 0, x, 0, 1, 0, y, 0, 0, 1, z, 0, 0, 0, 1]; }
export function rotX(a) { const c = Math.cos(a), s = Math.sin(a); return [1, 0, 0, 0, 0, c, -s, 0, 0, s, c, 0, 0, 0, 0, 1]; }
export function rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, s, 0, 0, 1, 0, 0, -s, 0, c, 0, 0, 0, 0, 1]; }
export function rotZ(a) { const c = Math.cos(a), s = Math.sin(a); return [c, -s, 0, 0, s, c, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]; }
// URDF rpy: R = Rz(yaw) * Ry(pitch) * Rx(roll)
export function rpy(r, p, y) { return mul(rotZ(y), mul(rotY(p), rotX(r))); }

const ORIGINS = JOINTS.map(j => mul(trans(...j.xyz), rpy(...j.rpy)));

/** Forward kinematics. Returns the six link frames (after each joint) and the TCP frame. */
export function fk(q, base = ident()) {
  const frames = [];
  let T = base;
  for (let i = 0; i < 6; i++) {
    T = mul(T, mul(ORIGINS[i], rotZ(q[i])));
    frames.push(T);
  }
  const tcp = mul(T, trans(0, 0, TCP_Z));
  return { frames, tcp };
}

export function pos(T) { return [T[3], T[7], T[11]]; }
export function axisZ(T) { return [T[2], T[6], T[10]]; }
export function axisX(T) { return [T[0], T[4], T[8]]; }

export function axisY(T) { return [T[1], T[5], T[9]]; }
export function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
export function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
export function norm(a) { return Math.hypot(a[0], a[1], a[2]); }
export function unit(a) { const n = norm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; }

/** Inverse of a rigid 4x4 (rotation + translation). */
export function invRigid(T) {
  const x = T[3], y = T[7], z = T[11];
  return [
    T[0], T[4], T[8], -(T[0] * x + T[4] * y + T[8] * z),
    T[1], T[5], T[9], -(T[1] * x + T[5] * y + T[9] * z),
    T[2], T[6], T[10], -(T[2] * x + T[6] * y + T[10] * z),
    0, 0, 0, 1];
}
/** Apply a 4x4 to a point [x,y,z]. */
export function xform(T, p) {
  return [T[0] * p[0] + T[1] * p[1] + T[2] * p[2] + T[3], T[4] * p[0] + T[5] * p[1] + T[6] * p[2] + T[7], T[8] * p[0] + T[9] * p[1] + T[10] * p[2] + T[11]];
}
/** Rotate a direction by the 3x3 part of a 4x4. */
export function xdir(T, v) {
  return [T[0] * v[0] + T[1] * v[1] + T[2] * v[2], T[4] * v[0] + T[5] * v[1] + T[6] * v[2], T[8] * v[0] + T[9] * v[1] + T[10] * v[2]];
}
/** 4x4 from position p and unit axes x, z (y = z cross x). */
export function frameFrom(p, x, z) {
  const y = cross(z, x);
  return [x[0], y[0], z[0], p[0], x[1], y[1], z[1], p[1], x[2], y[2], z[2], p[2], 0, 0, 0, 1];
}
/** Quaternion [x,y,z,w] of the rotation part of a 4x4. */
export function quatOf(T) {
  const m00 = T[0], m01 = T[1], m02 = T[2], m10 = T[4], m11 = T[5], m12 = T[6], m20 = T[8], m21 = T[9], m22 = T[10];
  const tr = m00 + m11 + m22;
  let x, y, z, w;
  if (tr > 0) { const s = Math.sqrt(tr + 1) * 2; w = s / 4; x = (m21 - m12) / s; y = (m02 - m20) / s; z = (m10 - m01) / s; }
  else if (m00 > m11 && m00 > m22) { const s = Math.sqrt(1 + m00 - m11 - m22) * 2; w = (m21 - m12) / s; x = s / 4; y = (m01 + m10) / s; z = (m02 + m20) / s; }
  else if (m11 > m22) { const s = Math.sqrt(1 + m11 - m00 - m22) * 2; w = (m02 - m20) / s; x = (m01 + m10) / s; y = s / 4; z = (m12 + m21) / s; }
  else { const s = Math.sqrt(1 + m22 - m00 - m11) * 2; w = (m10 - m01) / s; x = (m02 + m20) / s; y = (m12 + m21) / s; z = s / 4; }
  const n = Math.hypot(x, y, z, w) || 1;
  return [x / n, y / n, z / n, w / n];
}
/** 4x4 from position [x,y,z] and quaternion [x,y,z,w]. */
export function matOf(p, q) {
  const [x, y, z, w] = q;
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), p[0],
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), p[1],
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), p[2],
    0, 0, 0, 1];
}

// Solve A y = b for a 6x6 system (Gauss-Jordan with partial pivoting).
function solve6(A, b) {
  const n = 6, M = A.map((row, i) => [...row, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    const d = M[c][c] || 1e-12;
    for (let r = 0; r < n; r++) if (r !== c) {
      const f = M[r][c] / d;
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k];
    }
  }
  return M.map((row, i) => row[n] / (row[i] || 1e-12));
}

export function clampQ(q) { return q.map((v, i) => Math.min(JOINTS[i].hi, Math.max(JOINTS[i].lo, v))); }

/** Geometric Jacobian (6x6, rows: vx vy vz wx wy wz) of the TCP in the frame `base` is expressed in. */
export function jacobian(q, base = ident()) {
  const { frames, tcp } = fk(q, base);
  const pt = pos(tcp);
  const J = [[], [], [], [], [], []];
  for (let i = 0; i < 6; i++) {
    const z = axisZ(frames[i]), o = pos(frames[i]);
    const v = cross(z, [pt[0] - o[0], pt[1] - o[1], pt[2] - o[2]]);
    J[0][i] = v[0]; J[1][i] = v[1]; J[2][i] = v[2]; J[3][i] = z[0]; J[4][i] = z[1]; J[5][i] = z[2];
  }
  return { J, tcp, frames };
}

/**
 * Damped-least-squares IK with the geometric Jacobian.
 * target = { p:[x,y,z], z:[unit tool z], x:[unit tool x] } in the frame `base` maps into (default: robot base).
 * Returns { q, err (m), rotErr (rad), iters, ok }. ok means position < posTol*20 and orientation < 2e-3 rad
 * with every joint inside its limits; callers must treat !ok as "unreachable" and not move.
 * `tol` is the position tolerance used to stop iterating (default 1e-6 m).
 */
export function ik(target, seed = HOME, { iters = 200, lambda = 0.02, base = ident(), tol = 1e-6, rotTol = 1e-5 } = {}) {
  let q = clampQ(seed.slice());
  const tx = unit(target.x), tz = unit(target.z), ty = cross(tz, tx);
  let errN = Infinity, rotN = Infinity, it = 0;
  for (; it < iters; it++) {
    const { J, tcp } = jacobian(q, base);
    const p = pos(tcp);
    const ep = [target.p[0] - p[0], target.p[1] - p[1], target.p[2] - p[2]];
    const cx = cross(axisX(tcp), tx), cy = cross(axisY(tcp), ty), cz = cross(axisZ(tcp), tz);
    const eo = [0.5 * (cx[0] + cy[0] + cz[0]), 0.5 * (cx[1] + cy[1] + cz[1]), 0.5 * (cx[2] + cy[2] + cz[2])];
    // eo is sin(angle)*axis; when the frames are more than 90 deg apart keep the step finite
    const flip = dot(axisX(tcp), tx) + dot(axisY(tcp), ty) + dot(axisZ(tcp), tz) < -0.9;
    errN = norm(ep); rotN = Math.asin(Math.min(1, norm(eo)));
    if (flip) rotN = Math.PI - rotN;
    if (errN < tol && rotN < rotTol) break;
    const e = [...ep, ...eo];
    if (flip && norm(eo) < 1e-6) { e[3] += 0.3; }
    const lam = lambda * Math.min(1, 0.05 + 4 * errN + rotN);
    const A = [];
    for (let r = 0; r < 6; r++) {
      A.push([]);
      for (let c = 0; c < 6; c++) {
        let s = 0; for (let k = 0; k < 6; k++) s += J[r][k] * J[c][k];
        A[r].push(s + (r === c ? lam * lam : 0));
      }
    }
    const y = solve6(A, e);
    const dq = [0, 1, 2, 3, 4, 5].map(j => { let s = 0; for (let r = 0; r < 6; r++) s += J[r][j] * y[r]; return s; });
    const step = Math.max(...dq.map(Math.abs));
    const scale = step > 0.25 ? 0.25 / step : 1;
    q = clampQ(q.map((v, j) => v + dq[j] * scale));
  }
  return { q, err: errN, rotErr: rotN, iters: it, ok: errN < Math.max(2e-5, tol * 20) && rotN < 2e-3 };
}

/** Finger opening (m) for a drive angle (rad). Linear approximation of the four-bar linkage. */
export function gripWidth(drive) { return GRIP_STROKE * (1 - drive / GRIP_MAX); }
export function driveForWidth(w) { return Math.min(GRIP_MAX, Math.max(0, GRIP_MAX * (1 - w / GRIP_STROKE))); }

/** ZYX Euler angles (rx, ry, rz) of a rotation, matching the paper's R[rx, ry, rz] in A_t. */
export function eulerZYX(T) {
  const r20 = T[8], r21 = T[9], r22 = T[10], r10 = T[4], r00 = T[0];
  const ry = Math.asin(-Math.max(-1, Math.min(1, r20)));
  return [Math.atan2(r21, r22), ry, Math.atan2(r10, r00)];
}
