// Point-to-point ICP with Horn's closed-form (quaternion) alignment. Used for the §3.2 memory step:
// rough translation from the centroid difference, then ICP for [R, T]. Points are [x,y,z] arrays.

export function centroid(P) {
  const c = [0, 0, 0];
  for (const p of P) { c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return c.map(v => v / P.length);
}

function jacobiEig4(A) {
  // symmetric 4x4 eigen decomposition; returns eigenvector of the largest eigenvalue
  const a = A.map(r => r.slice()); const V = [[1, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]];
  for (let sweep = 0; sweep < 50; sweep++) {
    let off = 0; for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) off += a[i][j] ** 2;
    if (off < 1e-20) break;
    for (let p = 0; p < 4; p++) for (let q = p + 1; q < 4; q++) {
      if (Math.abs(a[p][q]) < 1e-15) continue;
      const th = (a[q][q] - a[p][p]) / (2 * a[p][q]);
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
      const c = 1 / Math.sqrt(t * t + 1), s = t * c;
      for (let k = 0; k < 4; k++) { const akp = a[k][p], akq = a[k][q]; a[k][p] = c * akp - s * akq; a[k][q] = s * akp + c * akq; }
      for (let k = 0; k < 4; k++) { const apk = a[p][k], aqk = a[q][k]; a[p][k] = c * apk - s * aqk; a[q][k] = s * apk + c * aqk; }
      for (let k = 0; k < 4; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
    }
  }
  let best = 0; for (let i = 1; i < 4; i++) if (a[i][i] > a[best][best]) best = i;
  return [V[0][best], V[1][best], V[2][best], V[3][best]];
}

/** Best rigid transform (R 3x3 row-major, t) mapping A[i] -> B[i]. */
export function horn(A, B) {
  const ca = centroid(A), cb = centroid(B);
  let S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = 0; i < A.length; i++) {
    const a = [A[i][0] - ca[0], A[i][1] - ca[1], A[i][2] - ca[2]], b = [B[i][0] - cb[0], B[i][1] - cb[1], B[i][2] - cb[2]];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) S[r][c] += a[r] * b[c];
  }
  const [[Sxx, Sxy, Sxz], [Syx, Syy, Syz], [Szx, Szy, Szz]] = S;
  const N = [
    [Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
    [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
    [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
    [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
  const [w, x, y, z] = jacobiEig4(N);
  const R = [
    1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y),
    2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x),
    2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y)];
  const t = [cb[0] - (R[0] * ca[0] + R[1] * ca[1] + R[2] * ca[2]), cb[1] - (R[3] * ca[0] + R[4] * ca[1] + R[5] * ca[2]), cb[2] - (R[6] * ca[0] + R[7] * ca[1] + R[8] * ca[2])];
  return { R, t };
}

export function apply(R, t, p) { return [R[0] * p[0] + R[1] * p[1] + R[2] * p[2] + t[0], R[3] * p[0] + R[4] * p[1] + R[5] * p[2] + t[1], R[6] * p[0] + R[7] * p[1] + R[8] * p[2] + t[2]]; }
export function compose(R2, t2, R1, t1) { // (R2,t2) o (R1,t1)
  const R = [0, 0, 0, 0, 0, 0, 0, 0, 0];
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) R[r * 3 + c] = R2[r * 3] * R1[c] + R2[r * 3 + 1] * R1[3 + c] + R2[r * 3 + 2] * R1[6 + c];
  return { R, t: apply(R2, t2, t1) };
}

/** Nearest-neighbour (brute force; clouds are a few hundred points). */
function nearest(src, dst) {
  return src.map(p => {
    let best = 0, bd = Infinity;
    for (let j = 0; j < dst.length; j++) { const d = (p[0] - dst[j][0]) ** 2 + (p[1] - dst[j][1]) ** 2 + (p[2] - dst[j][2]) ** 2; if (d < bd) { bd = d; best = j; } }
    return [dst[best], bd];
  });
}

export function rms(src, dst) { const nn = nearest(src, dst); return Math.sqrt(nn.reduce((a, [, d]) => a + d, 0) / src.length); }

/** One ICP iteration on the current source; returns the incremental transform and the residual after it. */
export function icpStep(src, dst) {
  const nn = nearest(src, dst);
  const { R, t } = horn(src, nn.map(([q]) => q));
  const moved = src.map(p => apply(R, t, p));
  return { R, t, moved, rmse: rms(moved, dst) };
}

export function yawOf(R) { return Math.atan2(R[3], R[0]); }

// ------------------------------------------------------------------ v3 additions: grid nearest neighbour and a full ICP loop

/** Uniform grid over `dst` for nearest-neighbour queries. cell defaults to about twice the mean spacing. */
export function buildGrid(dst, cell = null) {
  let lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  for (const p of dst) for (let k = 0; k < 3; k++) { if (p[k] < lo[k]) lo[k] = p[k]; if (p[k] > hi[k]) hi[k] = p[k]; }
  if (!cell) {
    const vol = Math.max(1e-12, (hi[0] - lo[0] + 1e-4) * (hi[1] - lo[1] + 1e-4) * (hi[2] - lo[2] + 1e-4));
    cell = Math.max(1e-4, 1.5 * Math.cbrt(vol / Math.max(1, dst.length)));
  }
  const map = new Map();
  const key = (i, j, k) => i * 73856093 ^ j * 19349663 ^ k * 83492791;
  for (let n = 0; n < dst.length; n++) {
    const p = dst[n];
    const h = key(Math.floor((p[0] - lo[0]) / cell), Math.floor((p[1] - lo[1]) / cell), Math.floor((p[2] - lo[2]) / cell));
    const b = map.get(h); if (b) b.push(n); else map.set(h, [n]);
  }
  return { dst, lo, hi, cell, map, key };
}

/** Nearest point of the grid to p: [index, squared distance]. Exact (rings are searched until no closer point can exist). */
export function nearestInGrid(grid, p) {
  const { dst, lo, cell, map, key } = grid;
  const ci = Math.floor((p[0] - lo[0]) / cell), cj = Math.floor((p[1] - lo[1]) / cell), ck = Math.floor((p[2] - lo[2]) / cell);
  let best = -1, bd = Infinity;
  const maxRing = 1 + Math.ceil(Math.max(grid.hi[0] - lo[0], grid.hi[1] - lo[1], grid.hi[2] - lo[2]) / cell)
    + Math.max(0, Math.abs(ci), Math.abs(cj), Math.abs(ck));
  for (let ring = 0; ring <= maxRing; ring++) {
    if (best >= 0) { const reach = (ring - 1) * cell; if (reach > 0 && reach * reach > bd) break; }
    for (let i = ci - ring; i <= ci + ring; i++) for (let j = cj - ring; j <= cj + ring; j++) for (let k = ck - ring; k <= ck + ring; k++) {
      if (Math.max(Math.abs(i - ci), Math.abs(j - cj), Math.abs(k - ck)) !== ring) continue;
      const b = map.get(key(i, j, k));
      if (!b) continue;
      for (const n of b) {
        const q = dst[n];
        const d = (p[0] - q[0]) ** 2 + (p[1] - q[1]) ** 2 + (p[2] - q[2]) ** 2;
        if (d < bd) { bd = d; best = n; }
      }
    }
  }
  return [best, bd];
}

/**
 * Centroid alignment followed by point-to-point ICP (paper section 3.2: rough translation from the centroids, then ICP [32]).
 * Finds [R, T] with dst ~ R * src + T. Returns
 *   { R[9], T[3], T_rou[3], rmse, rmse0 (after the centroid step), iters, converged, history: [{ iter, rmse }] }.
 * onIter({ iter, rmse, R, T, converged }) is called after the centroid step (iter 0) and after every iteration.
 * `trim` in (0,1] keeps that fraction of the closest pairs when solving (1 = all pairs).
 * Rotationally symmetric parts (gears) have no unique angle; position and axis are still determined.
 */
export function icp(src, dst, { maxIters = 30, tol = 1e-7, trim = 1, onIter = null } = {}) {
  const I = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  if (!src.length || !dst.length) return { R: I, T: [0, 0, 0], T_rou: [0, 0, 0], rmse: NaN, rmse0: NaN, iters: 0, converged: false, history: [] };
  const cs = centroid(src), cd = centroid(dst);
  const T_rou = [cd[0] - cs[0], cd[1] - cs[1], cd[2] - cs[2]];
  let R = I, T = T_rou.slice();
  let cur = src.map((p) => [p[0] + T[0], p[1] + T[1], p[2] + T[2]]);
  const grid = buildGrid(dst);
  const match = () => {
    const pairs = new Array(cur.length);
    let sum = 0;
    for (let i = 0; i < cur.length; i++) { const [n, d] = nearestInGrid(grid, cur[i]); pairs[i] = [i, n, d]; sum += d; }
    return { pairs, rmse: Math.sqrt(sum / cur.length) };
  };
  let m = match();
  const rmse0 = m.rmse;
  const history = [{ iter: 0, rmse: rmse0 }];
  let converged = maxIters === 0;
  if (onIter) onIter({ iter: 0, rmse: rmse0, R, T, converged });
  let it = 0;
  for (it = 1; it <= maxIters; it++) {
    let pairs = m.pairs;
    if (trim < 1) { pairs = pairs.slice().sort((a, b) => a[2] - b[2]).slice(0, Math.max(3, Math.floor(pairs.length * trim))); }
    const A = pairs.map(([i]) => cur[i]), Bm = pairs.map(([, n]) => dst[n]);
    const st = horn(A, Bm);
    cur = cur.map((p) => apply(st.R, st.t, p));
    const C = compose(st.R, st.t, R, T); R = C.R; T = C.t;
    const prev = m.rmse;
    m = match();
    history.push({ iter: it, rmse: m.rmse });
    converged = Math.abs(prev - m.rmse) < tol;
    if (onIter) onIter({ iter: it, rmse: m.rmse, R, T, converged });
    if (converged) break;
  }
  return { R, T, T_rou, rmse: m.rmse, rmse0, iters: Math.min(it, maxIters), converged, history };
}

/** Rotation about a unit axis by an angle, 3x3 row-major (helper for tests and demos). */
export function axisAngle(axis, angle) {
  const [x, y, z] = axis, c = Math.cos(angle), s = Math.sin(angle), t = 1 - c;
  return [t * x * x + c, t * x * y - s * z, t * x * z + s * y, t * x * y + s * z, t * y * y + c, t * y * z - s * x, t * x * z - s * y, t * y * z + s * x, t * z * z + c];
}
