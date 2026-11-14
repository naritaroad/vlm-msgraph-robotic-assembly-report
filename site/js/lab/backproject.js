// Paper Eq. (4), (5), (6) as pure functions. No three.js, no DOM.
// Camera optical frame: x right, y down, z forward (computer-vision convention).
// K is a row-major 3x3 [fx,0,cx, 0,fy,cy, 0,0,1]. Gamma (camToWorld) is a row-major 4x4. Points are [x,y,z] in metres.

/** Intrinsic matrix K from focal lengths and principal point (pixels). */
export function makeK({ fx, fy = fx, cx, cy }) { return [fx, 0, cx, 0, fy, cy, 0, 0, 1]; }

/** Inverse of an upper-triangular pinhole K (zero skew). */
export function invK(K) {
  const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
  return [1 / fx, 0, -cx / fx, 0, 1 / fy, -cy / fy, 0, 0, 1];
}

/** Eq. (4): P_t(u,v) = d_t(u,v) * K^-1 * [u, v, 1]^T. d is the depth along the optical axis. */
export function eq4(u, v, d, K) {
  const Ki = invK(K);
  return [d * (Ki[0] * u + Ki[1] * v + Ki[2]), d * (Ki[3] * u + Ki[4] * v + Ki[5]), d * (Ki[6] * u + Ki[7] * v + Ki[8])];
}

/** Eq. (5): P^w = Gamma_t * [P; 1]. The paper prints a 4x4 times a 3-vector; the point is made homogeneous here. */
export function eq5(P, Gamma) {
  const h = [P[0], P[1], P[2], 1];
  const o = [0, 0, 0, 0];
  for (let r = 0; r < 4; r++) o[r] = Gamma[r * 4] * h[0] + Gamma[r * 4 + 1] * h[1] + Gamma[r * 4 + 2] * h[2] + Gamma[r * 4 + 3] * h[3];
  return [o[0] / o[3], o[1] / o[3], o[2] / o[3]];
}

/** Homogeneous result of Eq. (5), [x, y, z, w], for printing next to the formula. */
export function eq5h(P, Gamma) {
  const h = [P[0], P[1], P[2], 1];
  return [0, 1, 2, 3].map((r) => Gamma[r * 4] * h[0] + Gamma[r * 4 + 1] * h[1] + Gamma[r * 4 + 2] * h[2] + Gamma[r * 4 + 3] * h[3]);
}

/** Pinhole projection of a camera-frame point: { u, v, d }. Inverse of Eq. (4). */
export function project(P, K) { return { u: K[0] * (P[0] / P[2]) + K[2], v: K[4] * (P[1] / P[2]) + K[5], d: P[2] }; }

/** World point into the camera frame (inverse of a rigid Gamma). */
export function worldToCam(Pw, Gamma) {
  const x = Pw[0] - Gamma[3], y = Pw[1] - Gamma[7], z = Pw[2] - Gamma[11];
  return [Gamma[0] * x + Gamma[4] * y + Gamma[8] * z, Gamma[1] * x + Gamma[5] * y + Gamma[9] * z, Gamma[2] * x + Gamma[6] * y + Gamma[10] * z];
}

/**
 * The same world point by a second route, for the `check` field of the capture event:
 * camera centre + d * (R * ray), with ray = [(u-cx)/fx, (v-cy)/fy, 1]. No K inverse, no homogeneous product.
 * Also projects the Eq. (4)(5) result back to the pixel. Returns { P_world, err (m), reproj: {u,v,d}, pixelErr (px) }.
 */
export function crossCheck(u, v, d, K, Gamma) {
  const rx = (u - K[2]) / K[0], ry = (v - K[5]) / K[4];
  const P2 = [
    Gamma[3] + d * (Gamma[0] * rx + Gamma[1] * ry + Gamma[2]),
    Gamma[7] + d * (Gamma[4] * rx + Gamma[5] * ry + Gamma[6]),
    Gamma[11] + d * (Gamma[8] * rx + Gamma[9] * ry + Gamma[10])];
  const P1 = eq5(eq4(u, v, d, K), Gamma);
  const reproj = project(worldToCam(P1, Gamma), K);
  return {
    P_world: P2,
    err: Math.hypot(P1[0] - P2[0], P1[1] - P2[1], P1[2] - P2[2]),
    reproj,
    pixelErr: Math.hypot(reproj.u - u, reproj.v - v),
  };
}

/** Binary erosion of a mask (Uint8Array, 1 = inside) with a (2r+1)x(2r+1) square, r = px. Separable, O(n). */
export function erodeMask(mask, width, height, px) {
  const r = Math.round(px);
  if (r <= 0) return mask;
  const tmp = new Uint8Array(mask.length), out = new Uint8Array(mask.length);
  for (let y = 0; y < height; y++) {
    let run = 0;                                    // consecutive inside pixels ending at x
    const row = y * width;
    for (let x = 0; x < width; x++) {
      run = mask[row + x] ? run + 1 : 0;
      const c = x - r;                              // window [c-r, c+r] ends at x
      if (c >= r && run >= 2 * r + 1) tmp[row + c] = 1;
    }
  }
  for (let x = 0; x < width; x++) {
    let run = 0;
    for (let y = 0; y < height; y++) {
      run = tmp[y * width + x] ? run + 1 : 0;
      const c = y - r;
      if (c >= r && run >= 2 * r + 1) out[c * width + x] = 1;
    }
  }
  return out;
}

/** Mask of the pixels whose id equals `value`: { mask, count, cu, cv } (centroid in pixels). */
export function maskOf(id, value) {
  const mask = new Uint8Array(id.length);
  let count = 0;
  for (let i = 0; i < id.length; i++) if (id[i] === value) { mask[i] = 1; count++; }
  return { mask, count };
}

/**
 * Eq. (4) then Eq. (5) for every masked pixel of one view.
 * depth: Float32Array (m, along the optical axis, 0 or NaN = invalid). Returns [[x,y,z], ...] in the world frame.
 * `noise(d)` may return an additive depth error for a pixel (m).
 */
export function backprojectView({ depth, mask, width, height, K, camToWorld, stride = 1, noise = null }) {
  const pts = [];
  const ifx = 1 / K[0], ify = 1 / K[4], cx = K[2], cy = K[5], G = camToWorld;
  for (let v = 0; v < height; v += stride) for (let u = 0; u < width; u += stride) {
    const i = v * width + u;
    if (mask && !mask[i]) continue;
    let d = depth[i];
    if (!(d > 0)) continue;
    if (noise) d += noise(d);
    const x = d * (u - cx) * ifx, y = d * (v - cy) * ify;         // Eq. (4)
    pts.push([                                                     // Eq. (5)
      G[0] * x + G[1] * y + G[2] * d + G[3],
      G[4] * x + G[5] * y + G[6] * d + G[7],
      G[8] * x + G[9] * y + G[10] * d + G[11]]);
  }
  return pts;
}

/** Eq. (6): union of the per-view clouds of one instance. */
export function fuseViews(views) {
  const out = [];
  for (const v of views) for (const p of v) out.push(p);
  return out;
}

/** Voxel down-sampling: one point (the mean) per occupied cube of side `voxel`. Order is deterministic. */
export function voxelDownsample(points, voxel) {
  if (!(voxel > 0) || points.length === 0) return points.slice();
  const cells = new Map();
  const inv = 1 / voxel;
  for (const p of points) {
    const k = `${Math.floor(p[0] * inv)},${Math.floor(p[1] * inv)},${Math.floor(p[2] * inv)}`;
    let c = cells.get(k);
    if (!c) { c = [0, 0, 0, 0]; cells.set(k, c); }
    c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; c[3]++;
  }
  const out = [];
  for (const c of cells.values()) out.push([c[0] / c[3], c[1] / c[3], c[2] / c[3]]);
  return out;
}

/** Depth noise model of config.DEPTH_NOISE: sigma(d) = sigmaMm * 1e-3 * (d / d0)^2, in metres. */
export function depthSigma(d, sigmaMm, d0) { return sigmaMm * 1e-3 * (d / d0) * (d / d0); }
