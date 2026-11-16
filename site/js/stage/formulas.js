// formulas.js — "current values substituted" under every equation block.
//
// init(ctx) scans the page for  figure.eq .eq-live[data-live]  and  .shapes[data-shapes]  and keeps them
// in step with the events on ctx.bus (lab:capture, lab:cloud, lab:icp, lab:grasp, lab:waypoints,
// lab:telemetry, lab:param, score:update).
//
// Everything that produces TeX or numbers is a pure function (numbers in, TeX string out) so that
// tools/tests/formulas.test.mjs can run it in Node. Only init() and the small renderer touch the DOM.
//
// Units: events carry metres and radians (docs/lab.md). This file converts to mm and degrees for display
// and always prints the unit.

import { CAMERA, PARAMS } from '../lab/config.js';

const R = String.raw;
const DEG = 180 / Math.PI;

// ───────────────────────────────────────────────────────────── numbers

/** Fixed-point string; never prints "-0.000". Non-finite values print as an en dash. */
export function fmt(v, d = 3) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '\u2013';
  const s = v.toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}
/** Like fmt, but exact integers print without decimals (0, 1, 385). Used inside matrices. */
export function fmtM(v, d = 3) {
  if (typeof v === 'number' && Number.isFinite(v) && Math.abs(v - Math.round(v)) < 1e-9) return String(Math.round(v));
  return fmt(v, d);
}
// Every live number is wrapped so the renderer can find it again and flash the ones that changed.
const mark = (s) => (s === '\u2013' ? R`\text{–}` : R`\htmlClass{lv-n}{${s}}`);
const N = (v, d = 3) => mark(fmt(v, d));
const NM = (v, d = 3) => mark(fmtM(v, d));
const I = (v) => mark(Number.isFinite(v) ? String(Math.round(v)) : '\u2013');
/** Remove the change-tracking wrappers: the plain TeX a reader would type. */
export function stripMarks(tex) {
  let s = String(tex).replace(/\\htmlClass\{lv-n\}\{([^{}]*)\}/g, '$1');
  for (;;) {                                           // \htmlData{sym=…}{X} -> X, braces balanced
    const i = s.indexOf('\\htmlData{');
    if (i < 0) break;
    const a = s.indexOf('}', i) + 1;
    if (s[a] !== '{') { s = s.slice(0, i) + s.slice(a); continue; }
    let depth = 0, j = a;
    for (; j < s.length; j++) { if (s[j] === '{') depth++; else if (s[j] === '}') { depth--; if (!depth) break; } }
    s = s.slice(0, i) + s.slice(a + 1, j) + s.slice(j + 1);
  }
  return s;
}

const unit = (u) => (u ? R`\,\mathrm{${u}}` : '');
/** A number, or a block of numbers, that stands for the symbol `key`: pressing it opens that symbol's card. */
const V = (key, tex) => R`\htmlData{sym=${key}, val=1}{${tex}}`;
/** (a, b, c) as a row. */
export function texRow(v, d = 3) { return R`(${v.map((x) => N(x, d)).join(R`,\ `)})`; }
/** Column vector. */
export function texCol(v, d = 3, f = N) { return R`\begin{bmatrix}${v.map((x) => f(x, d)).join(R`\\`)}\end{bmatrix}`; }
/** Row-major flat array -> rows × cols matrix. */
export function texMat(m, rows, cols, d = 3) {
  const out = [];
  for (let r = 0; r < rows; r++) out.push(Array.from({ length: cols }, (_, c) => NM(m[r * cols + c], d)).join('&'));
  return R`\begin{bmatrix}${out.join(R`\\`)}\end{bmatrix}`;
}

// ───────────────────────────────────────────────────────────── small linear algebra (row-major)

export function invK(K) {
  const [fx, , cx, , fy, cy] = K;
  return [1 / fx, 0, -cx / fx, 0, 1 / fy, -cy / fy, 0, 0, 1];
}
/** Eq. (4): P = d · K⁻¹ · [u, v, 1]ᵀ, camera optical frame (x right, y down, z forward). */
export function backproject(K, u, v, d) {
  const [fx, , cx, , fy, cy] = K;
  return [((u - cx) * d) / fx, ((v - cy) * d) / fy, d];
}
/** Eq. (5) with the homogeneous 1 written out: [P^w; 1] = Γ · [P; 1]. */
export function transformPoint(M, p) {
  return [0, 1, 2].map((r) => M[r * 4] * p[0] + M[r * 4 + 1] * p[1] + M[r * 4 + 2] * p[2] + M[r * 4 + 3]);
}
export function mul4(a, b) {
  const o = new Array(16);
  for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++) {
    o[r * 4 + c] = a[r * 4] * b[c] + a[r * 4 + 1] * b[4 + c] + a[r * 4 + 2] * b[8 + c] + a[r * 4 + 3] * b[12 + c];
  }
  return o;
}
const sub = (a, b) => a.map((x, i) => x - b[i]);
const norm = (a) => Math.hypot(...a);
/** Rotation of a 3×3 (row-major) about the vertical axis (world y up), radians. Exact for a pure R_y. */
export function yawAboutY(R9) { return Math.atan2(R9[2] - R9[6], R9[0] + R9[8]); }
/** Total rotation angle of a 3×3 rotation matrix, radians. */
export function rotAngle(R9) { return Math.acos(Math.max(-1, Math.min(1, (R9[0] + R9[4] + R9[8] - 1) / 2))); }

/** Eq. (7): the six waypoints ⟨P, P×R, P+aT, P+bT, P+cT, P+T⟩. The second keeps the position of the first. */
export function waypoints(P, T, coeffs = [0.8, 0.92, 0.96]) {
  const at = (s) => P.map((p, i) => p + s * T[i]);
  return [P.slice(), P.slice(), at(coeffs[0]), at(coeffs[1]), at(coeffs[2]), at(1)];
}
/** Fractions of |T| travelled by the four moving segments: a, b−a, c−b, 1−c. */
export function segmentFractions(coeffs = [0.8, 0.92, 0.96]) {
  const [a, b, c] = coeffs;
  return [a, b - a, c - b, 1 - c];
}

// ───────────────────────────────────────────────────────────── statistics (Derived)

const LF = [0];
function lnFact(n) { for (let i = LF.length; i <= n; i++) LF[i] = LF[i - 1] + Math.log(i); return LF[n]; }
const lnChoose = (n, k) => (k < 0 || k > n ? -Infinity : lnFact(n) - lnFact(k) - lnFact(n - k));

/** P(top-left cell = x) for a 2×2 table with fixed margins: row sums r1, r2 and first column sum c1. */
export function hypergeomPmf(x, r1, r2, c1) {
  return Math.exp(lnChoose(r1, x) + lnChoose(r2, c1 - x) - lnChoose(r1 + r2, c1));
}
/**
 * Fisher's exact test, two-sided, for the table [[a, b], [c, d]].
 * p = sum of the probabilities of every table (same margins) that is no more likely than the observed one.
 */
export function fisherExact(a, b, c, d) {
  const r1 = a + b, r2 = c + d, c1 = a + c;
  const lo = Math.max(0, c1 - r2), hi = Math.min(r1, c1);
  const pObs = hypergeomPmf(a, r1, r2, c1);
  let p = 0;
  for (let x = lo; x <= hi; x++) {
    const px = hypergeomPmf(x, r1, r2, c1);
    if (px <= pObs * (1 + 1e-7)) p += px;
  }
  return { p: Math.min(1, p), pObs, lo, hi, r1, r2, c1 };
}
function binomPmf(i, n, p) { return Math.exp(lnChoose(n, i) + i * Math.log(p) + (n - i) * Math.log(1 - p)); }
function binomGE(k, n, p) { let s = 0; for (let i = k; i <= n; i++) s += binomPmf(i, n, p); return s; }
function binomLE(k, n, p) { let s = 0; for (let i = 0; i <= k; i++) s += binomPmf(i, n, p); return s; }
function bisect(f, target, increasing) {
  let lo = 1e-12, hi = 1 - 1e-12;
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2;
    if ((f(mid) < target) === increasing) lo = mid; else hi = mid;
  }
  return (lo + hi) / 2;
}
/** Clopper–Pearson exact interval for k successes in n trials. Returns [lower, upper] as proportions. */
export function clopperPearson(k, n, conf = 0.95) {
  const a = (1 - conf) / 2;
  const lower = k === 0 ? 0 : bisect((p) => binomGE(k, n, p), a, true);
  const upper = k === n ? 1 : bisect((p) => binomLE(k, n, p), a, false);
  return [lower, upper];
}

// ───────────────────────────────────────────────────────────── plain-text formatting for output[data-bind]

/**
 * Text for an <output data-bind> cell. Internal units are metres and radians:
 * unit "mm" multiplies by 1000 and unit "deg" by 180/π, except when the key already says so
 * (keys ending in _mm or _deg, e.g. capture.delta_mm, step.error.tilt_deg).
 * Vectors print as (a, b, c); 9- and 16-element arrays print as matrix rows.
 */
export function formatBind(value, { unit: u = '', digits, key = '' } = {}) {
  if (value === null || value === undefined) return '\u2013';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'string') return value;
  const pre = /_(mm|deg)$/.test(key);
  const k = pre ? 1 : u === 'mm' ? 1000 : u === 'deg' || u === '\u00B0' ? DEG : 1;
  const d = digits ?? (u === 'mm' || u === 'deg' || u === '°' ? 1 : Number.isInteger(value) ? 0 : u === 'px' ? 1 : 3);
  const one = (x) => fmt(x * k, d).replace('-', '\u2212');
  const suffix = u ? (u === 'deg' ? '\u00B0' : ' ' + u) : '';
  if (typeof value === 'number') return one(value) + suffix;
  if (Array.isArray(value)) {
    if (value.length && Array.isArray(value[0])) return value.map((r) => formatBind(r, { unit: '', digits: d, key })).join(' ') + suffix;
    const n = value.length;
    if (n === 9 || n === 16) {
      const c = n === 9 ? 3 : 4;
      const rows = [];
      for (let r = 0; r < c; r++) rows.push(value.slice(r * c, r * c + c).map((x) => fmtM(x * k, d).replace('-', '\u2212')).join(' '));
      return '[' + rows.join('; ') + ']' + suffix;
    }
    return '(' + value.map(one).join(', ') + ')' + suffix;
  }
  return String(value);
}

// ───────────────────────────────────────────────────────────── TeX builders (pure)

/** Eq. (4): matrix form. cap = { K[9], pixel:{u,v,d} }. */
export function texEq4(cap) {
  const { K, pixel: { u, v, d } } = cap;
  const P = backproject(K, u, v, d);
  const Ki = invK(K);
  return R`\begin{aligned}P_t(u,v)&=d_t\cdot K^{-1}\,\boldsymbol{p}\\[2pt]&=\underbrace{${V('d_t', N(d, 3))}}_{d_t\ (\mathrm{m})}\cdot\underbrace{${V('K', texMat(Ki, 3, 3, 5))}}_{K^{-1}}\underbrace{${V('p_bold', texCol([u, v, 1], 1, NM))}}_{[u,\,v,\,1]^{\top}}\\[2pt]&=${V('P_t', texCol(P, 3))}\mathrm{m}\end{aligned}`;
}
/** Eq. (4): one coordinate per line. */
export function texEq4Steps(cap) {
  const { K, pixel: { u, v, d } } = cap;
  const [fx, , cx, , fy, cy] = K;
  const P = backproject(K, u, v, d);
  return R`\begin{aligned}x&=\frac{(u-c_x)\,d}{f_x}=\frac{(${NM(u, 1)}-${NM(cx, 1)})\times${N(d, 3)}}{${NM(fx, 1)}}=${N(P[0], 3)}\ \mathrm{m}\\[2pt]y&=\frac{(v-c_y)\,d}{f_y}=\frac{(${NM(v, 1)}-${NM(cy, 1)})\times${N(d, 3)}}{${NM(fy, 1)}}=${N(P[1], 3)}\ \mathrm{m}\\[2pt]z&=d=${N(P[2], 3)}\ \mathrm{m}\end{aligned}`;
}
/** Eq. (5) exactly as printed: the shapes do not match. */
export function texEq5Printed() {
  return R`P^{w}_t(u,v)=\underbrace{\Gamma_t}_{4\times 4}\cdot\underbrace{\boldsymbol{P}_t}_{3\times 1}\qquad\text{columns }4\neq\text{rows }3`;
}
/** Eq. (5) with the homogeneous 1: [P^w; 1] = Γ_t [P; 1]. cap = { K, pixel, camToWorld[16] }. */
export function texEq5h(cap) {
  const { K, pixel: { u, v, d }, camToWorld: G } = cap;
  const P = backproject(K, u, v, d);
  const W = transformPoint(G, P);
  return R`\begin{aligned}\begin{bmatrix}P^{w}_t\\1\end{bmatrix}&=\Gamma_t\begin{bmatrix}\boldsymbol{P}_t\\1\end{bmatrix}=\underbrace{${V('Gamma_t', texMat(G, 4, 4, 3))}}_{\Gamma_t\ (4\times 4)}\underbrace{${V('P_bold_t', texCol([...P, 1], 3, NM))}}_{(4\times 1)}\\[2pt]&=${texCol([...W, 1], 3, NM)}\ \Rightarrow\ P^{w}_t=${V('P_w_t', texRow(W, 3))}\ \mathrm{m}\end{aligned}`;
}
/** Intrinsic matrix with its symbols and current values, and its inverse. */
export function texK(K) {
  return R`K=\begin{bmatrix}f_x&0&c_x\\0&f_y&c_y\\0&0&1\end{bmatrix}=${texMat(K, 3, 3, 1)}\mathrm{px}`;
}
export function texKinv(K) {
  return R`\begin{aligned}K^{-1}&=\begin{bmatrix}1/f_x&0&-c_x/f_x\\0&1/f_y&-c_y/f_y\\0&0&1\end{bmatrix}\\[2pt]&=${texMat(invK(K), 3, 3, 5)}\end{aligned}`;
}

const PART_LETTER = { red: 'R', green: 'G', yellow: 'Y', blue: 'B', nut: 'N', cover: 'C' };
const partSub = (part) => R`\mathrm{${PART_LETTER[part] || String(part || 'i').replace(/[^A-Za-z0-9]/g, '').slice(0, 6) || 'i'}}`;

/**
 * Eq. (6): how many points each of the k views contributes, the merged count, the count after voxel
 * down-sampling. clouds = [{ part, perView:[n…], nMerged, nPoints, views, voxelMm, current }].
 */
export function texEq6(clouds, { maskReading = false } = {}) {
  const lines = clouds.map((c) => {
    const lab = c.current ? R`\htmlClass{lv-cur}{\mathcal{P}_{${partSub(c.part)}}}` : R`\mathcal{P}_{${partSub(c.part)}}`;
    const per = Array.isArray(c.perView) && c.perView.length ? c.perView : null;
    const merged = c.nMerged ?? (per ? per.reduce((a, b) => a + b, 0) : null);
    const k = per ? per.length : c.views;
    let rhs;
    if (per) {
      rhs = per.map((n, j) => R`\underbrace{${I(n)}}_{j=${j + 1}}`).join('+') + R`=${I(merged)}`;
    } else {
      rhs = R`k=${I(k)}\ \text{views}`;
      if (merged != null) rhs += R`,\ ${I(merged)}`;
    }
    const vox = c.voxelMm != null ? R`\xrightarrow{\ \text{voxel }${fmtM(c.voxelMm, 1)}\,\mathrm{mm}\ }` : R`\ \rightarrow\ `;
    return R`\lvert${lab}\rvert&:\ ${rhs}${c.nPoints != null ? vox + I(c.nPoints) : ''}\ \text{points}`;
  });
  const head = maskReading
    ? R`\mathcal{P}_i=\bigcup_{j=1}^{k}\{P^{w}_j(u,v)\mid (u,v)\in m_i^{(j)}\}`
    : R`\mathcal{P}_i=\bigcup_{j=1}^{k}\{P^{w}_j(u,v)\mid I^{rgb}_j(u,v)\in m_i\}`;
  return R`\begin{aligned}&${head}\\[2pt]${lines.join(R`\\[2pt]`)}\end{aligned}`;
}

/** Rough translation: difference of the two centroids. Centroids in metres. */
export function texTr(cSrc, cDst) {
  const T = sub(cDst, cSrc);
  return R`\begin{aligned}T_{rou}&=\bar{c}_{s}-\bar{c}_{dis}=${V('c_bar', texCol(cDst, 3))}-${V('c_bar', texCol(cSrc, 3))}=${V('T_rou', texCol(T, 3))}\mathrm{m}\\[2pt]\lVert T_{rou}\rVert&=${N(norm(T) * 1000, 1)}\ \mathrm{mm}\end{aligned}`;
}
export function texTrOnly(T) {
  return R`T_{rou}=\bar{c}_{s}-\bar{c}_{dis}=${texCol(T, 3)}\mathrm{m},\quad\lVert T_{rou}\rVert=${N(norm(T) * 1000, 1)}\ \mathrm{mm}`;
}

export const TEX_ICP_OBJECTIVE = R`\min_{R,\,T}\ \sum_i\lVert R\,p_i+T-q_i\rVert^2`;
/** ICP progress. icp = { iter, rmse (m), R[9], T[3] (m), converged }, maxIters optional. */
export function texIcp(icp, maxIters) {
  const it = maxIters != null ? R`${I(icp.iter)}/${I(maxIters)}` : I(icp.iter);
  const th = icp.R ? yawAboutY(icp.R) * DEG : NaN;
  const all = icp.R ? rotAngle(icp.R) * DEG : NaN;
  const T = icp.T || [NaN, NaN, NaN];
  return R`\begin{aligned}\text{iteration}&=${it},\qquad\mathrm{rmse}=${N(icp.rmse * 1000, 2)}\ \mathrm{mm}\\[2pt]R&\approx R_{\text{vertical}}(\theta),\quad\theta=${N(th, 2)}^{\circ}\quad(\text{total rotation }${N(all, 2)}^{\circ})\\[2pt]T&=${texRow(T.map((x) => x * 1000), 1)}\ \mathrm{mm},\quad\lVert T\rVert=${N(norm(T) * 1000, 1)}\ \mathrm{mm}\end{aligned}`;
}

export const TEX_GOBJ_SHAPES = R`\underbrace{\Gamma_{obj}}_{4\times 4}=\underbrace{\Gamma^{c}_{b}}_{4\times 4}\times\underbrace{\Gamma_{grasp}}_{4\times 4}`;
/** Γ_obj = Γ^c_b × Γ_grasp, one matrix per line. Both inputs 4×4 row-major. */
export function texGobj(camToBase, graspInCam) {
  const O = mul4(camToBase, graspInCam);
  return [
    R`\Gamma^{c}_{b}=${texMat(camToBase, 4, 4, 3)}`,
    R`\Gamma_{grasp}=${texMat(graspInCam, 4, 4, 3)}`,
    R`\Gamma_{obj}=\Gamma^{c}_{b}\times\Gamma_{grasp}=${texMat(O, 4, 4, 3)}`,
  ];
}

/** A_t ∈ ℝ⁷ = [dx, dy, dz | rx, ry, rz | s]. A in metres and radians. */
export function texA(A) {
  const c = (i, d) => N(A[i], d);
  return R`A_t=\left[\begin{array}{ccc|ccc|c}dx&dy&dz&rx&ry&rz&s_t\\${c(0, 4)}&${c(1, 4)}&${c(2, 4)}&${c(3, 3)}&${c(4, 3)}&${c(5, 3)}&${NM(A[6], 2)}\\\rlap{\scriptsize\text{translation, m}}&&&\rlap{\scriptsize\text{Euler angles, rad}}&&&\scriptsize\text{grip}\end{array}\right]\in\mathbb{R}^{7}`;
}
export function texADeg(A) {
  return R`T=${texRow([A[0], A[1], A[2]].map((x) => x * 1000), 2)}\ \mathrm{mm},\qquad R=(${[3, 4, 5].map((i) => N(A[i] * DEG, 2) + R`^{\circ}`).join(R`,\ `)})`;
}

/**
 * Eq. (7): six waypoints with the numbers put in. wp = { P[3], T[3], coeffs[3], index }.
 * reading 'printed' keeps the paper's P×R for the second point; 'rotate' writes it as "same point, new orientation".
 */
export function texEq7(wp, { reading = 'printed' } = {}) {
  const { P, T, coeffs = [0.8, 0.92, 0.96], index } = wp;
  const pts = waypoints(P, T, coeffs);
  const w = (i) => (i === index ? R`\htmlClass{lv-cur}{\blacktriangleright\,w_${i}}` : R`\phantom{\blacktriangleright\,}w_${i}`);
  const second = reading === 'printed'
    ? R`${w(1)}&=\vec{P}\times\vec{R}&&\text{same position }${texRow(pts[1], 3)}\ \mathrm{m}`
    : R`${w(1)}&=(\vec{P},\ R_{grasp})&&\text{same position, gripper turned}`;
  const names = [R`\vec{P}+${V('eq7_coeffs', N(coeffs[0], 2))}\,\vec{T}`, R`\vec{P}+${V('eq7_coeffs', N(coeffs[1], 2))}\,\vec{T}`, R`\vec{P}+${V('eq7_coeffs', N(coeffs[2], 2))}\,\vec{T}`, R`\vec{P}+\vec{T}`];
  const rest = names.map((nm, j) => R`${w(j + 2)}&=${nm}&&=${texRow(pts[j + 2], 4)}\ \mathrm{m}`);
  return R`\begin{aligned}${w(0)}&=\vec{P}&&=${V('P_vec', texRow(pts[0], 3))}\ \mathrm{m}\\${second}\\${rest.join(R`\\`)}\end{aligned}`;
}
/** Eq. (7): length of each moving segment in mm and as a fraction of |T|. */
export function texEq7Segments(wp) {
  const { T, coeffs = [0.8, 0.92, 0.96] } = wp;
  const L = norm(T) * 1000;
  const fr = segmentFractions(coeffs);
  const seg = fr.map((f) => R`\underbrace{${N(f * L, 1)}}_{${N(f, 2)}\lVert T\rVert}`).join(R`\ \rightarrow\ `);
  return R`\begin{aligned}\vec{T}&=${texRow(T, 3)}\ \mathrm{m},\quad\lVert T\rVert=${N(L, 1)}\ \mathrm{mm}\\[2pt]\text{segments}&:\ ${seg}\ \ \mathrm{mm}\end{aligned}`;
}

/** R = hits / n_gt. */
export function texR(score, level = 'Triple') {
  const { hits, n_gt } = score;
  const r = n_gt ? hits / n_gt : NaN;
  return R`R@\text{${level}}=\frac{\text{hits}}{n_{gt}}=\frac{${I(hits)}}{${I(n_gt)}}=${V('R_at_k', N(r, 3))}=${N(r * 100, 1)}\%`;
}
/** The three levels for one reading (set or ordered). */
export function texRLevels(vals, label) {
  const one = (nm, v) => R`R@\text{${nm}}=${N(v, 3)}`;
  return R`\text{${label}:}\quad ${one('Triple', vals.triple)},\quad ${one('Pair', vals.pair)},\quad ${one('Action', vals.action)}`;
}
/** mR = mean of the per-task recalls. */
export function texMR(values) {
  const M = values.length;
  const m = M ? values.reduce((a, b) => a + b, 0) / M : NaN;
  const shown = values.slice(0, 8).map((v) => N(v, 3)).join('+') + (M > 8 ? R`+\dots` : '');
  return R`mR=\frac{1}{M}\sum_{m=1}^{M}R_m=\frac{1}{${I(M)}}\left(${shown}\right)=${N(m, 3)}`;
}

/** Fisher table for Table 2. rows = [{ product, without, with }], n = trials per cell. */
export function fisherTable(rows, n = 20) {
  const out = rows.map((r) => ({ label: String(r.product), without: r.without, with: r.with, n, ...fisherExact(r.without, n - r.without, r.with, n - r.with) }));
  const sw = rows.reduce((a, r) => a + r.without, 0), sp = rows.reduce((a, r) => a + r.with, 0), N2 = n * rows.length;
  const total = { label: 'all', without: sw, with: sp, n: N2, ...fisherExact(sw, N2 - sw, sp, N2 - sp) };
  return { rows: out, total };
}
const pTex = (p) => (p < 0.001 ? R`${mark(p.toExponential(1).replace('e', R`\times 10^{`) + '}')}` : N(p, 3));
export function texFisherDef(row) {
  // Worked for one product: a successes without, c successes with, n trials each.
  const a = row.without, c = row.with, n = row.n;
  return R`\begin{aligned}P(x)&=\frac{\binom{${n}}{x}\binom{${n}}{${a + c}-x}}{\binom{${2 * n}}{${a + c}}}\qquad(${a}/${n}\ \text{without},\ ${c}/${n}\ \text{with})\\[4pt]p&=\sum_{x:\ P(x)\le P(${a})}P(x)=${pTex(row.p)}\end{aligned}`;
}
export function texFisherTable(ft) {
  const line = (r) => R`\text{${r.label}}&${r.without}/${r.n}&${r.with}/${r.n}&${pTex(r.p)}`;
  return R`\begin{array}{lccc}\text{product}&\text{without base}&\text{with base}&p\ \text{(two-sided)}\\\hline ${ft.rows.map(line).join(R`\\`)}\\\hline ${line(ft.total)}\end{array}`;
}

/** Clopper–Pearson table for Table 3. rows = [{ step, prompt, success }], n = trials per step. */
export function ciTable(rows, n = 10) {
  const out = rows.map((r) => { const [lo, hi] = clopperPearson(r.success, n); return { label: String(r.step), prompt: r.prompt, k: r.success, n, lo, hi }; });
  const k = rows.reduce((a, r) => a + r.success, 0), N2 = n * rows.length;
  const [lo, hi] = clopperPearson(k, N2);
  return { rows: out, total: { label: 'all', prompt: '', k, n: N2, lo, hi } };
}
export function texCiDef(row) {
  const { k, n, lo, hi } = row;
  return R`\begin{aligned}\sum_{i=${k}}^{${n}}\binom{${n}}{i}p_L^{\,i}(1-p_L)^{${n}-i}&=0.025\ \Rightarrow\ p_L=${N(lo * 100, 1)}\%\\[2pt]\sum_{i=0}^{${k}}\binom{${n}}{i}p_U^{\,i}(1-p_U)^{${n}-i}&=0.025\ \Rightarrow\ p_U=${N(hi * 100, 1)}\%\qquad(k=${k},\ n=${n})\end{aligned}`;
}
export function texCiTable(ct) {
  const line = (r) => R`\text{${r.label}}&${r.k}/${r.n}&${N((r.k / r.n) * 100, 0)}\%&${N(r.lo * 100, 1)}\%\ \text{–}\ ${N(r.hi * 100, 1)}\%`;
  return R`\begin{array}{lccc}\text{step}&\text{successes}&\hat{p}&95\%\ \text{interval}\\\hline ${ct.rows.map(line).join(R`\\`)}\\\hline ${line(ct.total)}\end{array}`;
}

// ───────────────────────────────────────────────────────────── data-shape diagram (pure, returns SVG markup)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/**
 * Shapes of the data that flow through Eq. (4)–(6): I^rgb h×w×3, I^depth h×w, one pixel (u,v), K 3×3,
 * Γ_t 4×4, one 3D point, the cloud N×3, and A_t with 7 numbers.
 * s = { h, w, u, v, d, N, k, keys }. Colours come from CSS classes (widgets-lab.css); no colour is hard-coded here.
 *
 * Every symbol, dimension label and value is a hot spot: <g data-sym="key" tabindex="0" role="button">, so pop.js
 * opens the same symbol card as in the formulas (a value or a size adds data-val: the card then shows "Now").
 * The box behind each label (.sh-hitbox) gives the hover and focus ring; the dotted line under it says it can be
 * pressed, like a term in the text. keys = { rgb, depth } names the cards for the two images (see SHAPE_KEYS).
 */
export const SHAPE_KEYS = Object.freeze({ rgb: 'O_t', depth: 'O_t' });
export function shapesSvg(s = {}) {
  const h = s.h ?? CAMERA.height, w = s.w ?? CAMERA.width;
  const u = s.u ?? Math.round(w * 0.64), v = s.v ?? Math.round(h * 0.41);
  const Np = s.N, k = s.k ?? CAMERA.defaultViews;
  const keys = { ...SHAPE_KEYS, ...(s.keys || {}) };
  const sym = (base, x, y, { sup, sub: sb, cls = 'sh-sym' } = {}) => `<text class="${cls}" x="${x}" y="${y}">${base}${sup ? `<tspan class="sh-sup" dy="-8">${esc(sup)}</tspan>` : ''}${sb ? `<tspan class="sh-sub" dy="5">${esc(sb)}</tspan>` : ''}</text>`;
  const grid = (x, y, n, m, c, cls, key = '') => {
    let g = `<g class="${cls}"${key ? ` data-sym="${key}"` : ''}><rect x="${x}" y="${y}" width="${m * c}" height="${n * c}"/>`;
    for (let i = 1; i < n; i++) g += `<line x1="${x}" y1="${y + i * c}" x2="${x + m * c}" y2="${y + i * c}"/>`;
    for (let j = 1; j < m; j++) g += `<line x1="${x + j * c}" y1="${y}" x2="${x + j * c}" y2="${y + n * c}"/>`;
    return g + '</g>';
  };
  // a pressable label: box [x, y, bw, bh] behind it, dotted underline at its foot
  const hot = (key, [x, y, bw, bh], label, inner, { val = false, line = true } = {}) =>
    `<g class="sh-hot" data-sym="${key}"${val ? ' data-val="1"' : ''} tabindex="0" role="button" aria-label="${esc(label)}">`
    + `<rect class="sh-hitbox" x="${x}" y="${y}" width="${bw}" height="${bh}" rx="4"/>${inner}`
    + (line ? `<line class="sh-ul" x1="${x + 3}" y1="${y + bh - 1.5}" x2="${x + bw - 3}" y2="${y + bh - 1.5}"/>` : '') + '</g>';
  const arrow = (x1, y1, x2, y2) => `<line class="sh-arrow" x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" marker-end="url(#sh-ah)"/>`;
  // two image sheets, 140 wide, same aspect as the camera image
  const iw = 140, ih = Math.round((iw * h) / w);
  const rgbX = 16, depX = 200, imgY = 52;
  const px = (x0) => +(x0 + (u / w) * iw).toFixed(1), py = +(imgY + (v / h) * ih).toFixed(1);
  const C = 22, rowY = 236;                       // cell size and top of the 3-row grids
  const uv = `(${fmtM(u, 0)}, ${fmtM(v, 0)}) px`;
  const nPts = Np != null ? fmtM(Np, 0) : 'N';
  let o = `<svg class="shapes-svg" viewBox="0 0 560 420" role="group" aria-label="Data shapes: RGB image ${h} by ${w} by 3, depth image ${h} by ${w}, K 3 by 3, camera pose 4 by 4, one 3D point, point cloud N by 3, action 7. Each label opens its explanation.">`;
  o += '<defs><marker id="sh-ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="sh-ahp" d="M0 0L10 5L0 10z"/></marker></defs>';
  // I^rgb: three stacked sheets; I^depth: one sheet
  o += `<g data-sym="${keys.rgb}"><rect class="sh-sheet sh-ch3" x="${rgbX + 12}" y="${imgY - 12}" width="${iw}" height="${ih}"/><rect class="sh-sheet sh-ch2" x="${rgbX + 6}" y="${imgY - 6}" width="${iw}" height="${ih}"/><rect class="sh-sheet sh-ch1" x="${rgbX}" y="${imgY}" width="${iw}" height="${ih}"/></g>`;
  o += hot(keys.rgb, [rgbX - 4, 5, 44, 28], 'I rgb, the colour image', sym('I', rgbX, 26, { sup: 'rgb' }));
  o += hot(keys.rgb, [rgbX + 40, 10, 120, 23], `I rgb size: ${h} × ${w} × 3`, `<text class="sh-dim" x="${rgbX + 44}" y="26">${h} × ${w} × 3</text>`, { val: true });
  o += `<rect class="sh-sheet sh-depth" x="${depX}" y="${imgY}" width="${iw}" height="${ih}" data-sym="${keys.depth}"/>`;
  o += hot(keys.depth, [depX - 4, 5, 58, 28], 'I depth, the depth image', sym('I', depX, 26, { sup: 'depth' }));
  o += hot(keys.depth, [depX + 54, 10, 86, 23], `I depth size: ${h} × ${w}`, `<text class="sh-dim" x="${depX + 58}" y="26">${h} × ${w}</text>`, { val: true });
  o += `<g data-sym="uv"><circle class="sh-px" cx="${px(rgbX)}" cy="${py}" r="5"/><circle class="sh-px" cx="${px(depX)}" cy="${py}" r="5"/></g>`;
  o += hot('uv', [357, 60, 124, 43], `pixel (u, v) = ${uv}`, `<text class="sh-val" x="362" y="76">(u, v) =</text><text class="sh-val" x="362" y="96">${uv}</text>`, { val: true });
  o += s.d != null
    ? hot('d_t', [357, 108, 100, 23], `depth d = ${fmt(s.d, 3)} m`, `<text class="sh-val" x="362" y="124">d = ${fmt(s.d, 3)} m</text>`, { val: true })
    : hot('d_t', [357, 108, 100, 23], 'depth d, in metres', '<text class="sh-val" x="362" y="124">d in metres</text>');
  // the pixel and its depth go into Eq. (4)
  o += arrow(px(rgbX), py + 7, 40, rowY - 28) + arrow(px(depX), py + 7, 66, rowY - 28);
  // K -> P_t -> Γ_t -> P^w -> cloud
  o += grid(16, rowY, 3, 3, C, 'sh-grid sh-k', 'K') + hot('K', [12, rowY - 30, 22, 27], 'K, the intrinsic matrix', sym('K', 16, rowY - 10))
    + hot('K', [33, rowY - 25, 48, 22], 'K size: 3 × 3', `<text class="sh-dim" x="36" y="${rowY - 10}">3 × 3</text>`, { val: true });
  o += arrow(86, rowY + 33, 124, rowY + 33);
  o += grid(130, rowY, 3, 1, C, 'sh-grid sh-pt', 'P_t_short') + hot('P_t_short', [120, rowY - 30, 27, 27], 'P t, the point in the camera frame', sym('P', 124, rowY - 10, { sub: 't' }))
    + hot('P_t_short', [146, rowY - 25, 17, 22], 'P t size: 3', `<text class="sh-dim" x="150" y="${rowY - 10}">3</text>`, { val: true });
  o += arrow(156, rowY + 33, 198, rowY + 33);
  o += grid(204, rowY - 11, 4, 4, C, 'sh-grid sh-gamma', 'Gamma_t') + hot('Gamma_t', [200, rowY - 41, 27, 27], 'Gamma t, the camera pose', sym('Γ', 204, rowY - 21, { sub: 't' }))
    + hot('Gamma_t', [227, rowY - 36, 48, 22], 'Gamma t size: 4 × 4', `<text class="sh-dim" x="230" y="${rowY - 21}">4 × 4</text>`, { val: true });
  o += arrow(296, rowY + 33, 338, rowY + 33);
  o += grid(344, rowY, 3, 1, C, 'sh-grid sh-pw', 'P_w_t') + hot('P_w_t', [334, rowY - 33, 29, 30], 'P w, the point in world coordinates', sym('P', 338, rowY - 10, { sup: 'w' }))
    + hot('P_w_t', [362, rowY - 25, 17, 22], 'P w size: 3', `<text class="sh-dim" x="366" y="${rowY - 10}">3</text>`, { val: true });
  o += arrow(370, rowY + 33, 420, rowY + 33);
  o += grid(426, rowY - 22, 5, 3, C, 'sh-grid sh-cloud', 'P_cal_i') + hot('P_cal_i', [422, rowY - 52, 28, 27], 'script P i, the point cloud of part i', sym('𝒫', 426, rowY - 32, { sub: 'i', cls: 'sh-sym sh-cal' }))
    + hot('P_cal_i', [449, rowY - 47, 18 + 8.4 * (nPts.length + 4), 22], `script P i size: ${nPts} × 3`, `<text class="sh-dim" x="452" y="${rowY - 32}">${nPts} × 3</text>`, { val: true });
  o += ['x', 'y', 'z'].map((c, j) => `<text class="sh-cell" x="${437 + j * C}" y="${rowY - 6}">${c}</text>`).join('');
  o += `<text class="sh-dots" x="459" y="${rowY + 108}">⋮</text>`;
  o += `<text class="sh-eq" x="16" y="${rowY + 92}">Eq. (4)</text><text class="sh-eq" x="204" y="${rowY + 100}">Eq. (5)</text><text class="sh-eq" x="426" y="${rowY + 126}">Eq. (6),</text>`;
  o += hot('k_views', [491, rowY + 111, 54, 21], `k = ${fmtM(k, 0)} views`, `<text class="sh-eq" x="495" y="${rowY + 126}">k = ${fmtM(k, 0)}</text>`, { val: true });
  // A_t
  const ay = 372, ax = 96, ac = 32;
  o += hot('A_t', [12, ay, 30, 28], 'A t, the low-level action', sym('A', 16, ay + 21, { sub: 't' }));
  o += hot('A_t', [43, ay + 5, 16, 22], 'A t size: 7', `<text class="sh-dim" x="46" y="${ay + 21}">7</text>`, { val: true }) + `<text class="sh-dim" x="62" y="${ay + 21}">=</text>`;
  const cells = (from, to, x0) => ['dx', 'dy', 'dz', 'rx', 'ry', 'rz', 's'].slice(from, to).map((c, j) => `<text class="sh-cell" x="${x0 + ac / 2 + j * ac}" y="${ay + 21}">${c}</text>`).join('');
  o += hot('dxyz', [ax - 2, ay - 2, 3 * ac + 4, ac + 4], 'dx, dy, dz: translation', grid(ax, ay, 1, 3, ac, 'sh-grid sh-at-t') + cells(0, 3, ax), { line: false });
  o += hot('rxyz', [ax + 3 * ac + 6, ay - 2, 3 * ac + 4, ac + 4], 'rx, ry, rz: Euler angles', grid(ax + 3 * ac + 8, ay, 1, 3, ac, 'sh-grid sh-at-r') + cells(3, 6, ax + 3 * ac + 8), { line: false });
  o += hot('s_t', [ax + 6 * ac + 14, ay - 2, ac + 4, ac + 4], 's: gripper state', grid(ax + 6 * ac + 16, ay, 1, 1, ac, 'sh-grid sh-at-s') + cells(6, 7, ax + 6 * ac + 16), { line: false });
  o += `<text class="sh-val" x="${ax + 6 * ac + 60}" y="${ay + 14}">T: m, R: rad,</text><text class="sh-val" x="${ax + 6 * ac + 60}" y="${ay + 32}">s: gripper</text>`;
  return o + '</svg>';
}

/**
 * The table under the diagram: symbol, size in the lab, meaning. Symbol and size are buttons that open the same
 * cards as the diagram. Returns HTML; rows of SHAPES_ROWS, values from the same s as shapesSvg.
 */
export function shapesTable(s = {}) {
  const h = s.h ?? CAMERA.height, w = s.w ?? CAMERA.width;
  const keys = { ...SHAPE_KEYS, ...(s.keys || {}) };
  const size = {
    rgb: `${h} × ${w} × 3`, depth: `${h} × ${w}`,
    uv: s.u != null && s.v != null ? `(${fmtM(s.u, 0)}, ${fmtM(s.v, 0)}) px` : '2 × px',
    d: s.d != null ? `${fmt(s.d, 3)} m` : 'm',
    K: '3 × 3', Pt: '3', G: '4 × 4', Pw: '3', cloud: `${s.N != null ? fmtM(s.N, 0) : 'N'} × 3`, A: '7',
  };
  const btn = (key, html, label, val) => `<button type="button" class="sh-ref${val ? ' sh-ref-val' : ''}" data-sym="${key}"${val ? ' data-val="1"' : ''} aria-expanded="false" aria-label="${esc(label)}">${html}</button>`;
  const rows = SHAPES_ROWS.map(([id, key0, symHtml, symLabel, t]) => {
    const key = keys[id] || key0;
    return `<tr><th scope="row">${btn(key, symHtml, symLabel, false)}</th><td>${btn(key, esc(size[id]), `${symLabel}: ${size[id]}`, true)}</td><td>${biHtml(t)}</td></tr>`;
  }).join('');
  return `<table class="shapes-table"><thead><tr><th scope="col">${biHtml(bi('Symbol', '符號'))}</th><th scope="col">${biHtml(bi('Size in the lab', '實驗室裡的大小'))}</th><th scope="col">${biHtml(bi('Meaning', '意思'))}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ───────────────────────────────────────────────────────────── block models (pure)

/** Worked examples from docs/facts.md ("local check"), used until the lab sends real events. */
export const EXAMPLE = Object.freeze({
  capture: { K: [100, 0, 50, 0, 100, 40, 0, 0, 1], camToWorld: [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], pixel: { u: 70, v: 60, d: 2 }, example: true },
  waypoints: { P: [0.10, -0.20, 0.30], T: [0, 0.05, -0.12], coeffs: [0.8, 0.92, 0.96], index: 0, phase: 'approach', example: true },
});

export function createState() {
  return {
    capture: EXAMPLE.capture,
    waypoints: EXAMPLE.waypoints,
    K: [CAMERA.fx, 0, CAMERA.cx, 0, CAMERA.fy, CAMERA.cy, 0, 0, 1],
    clouds: {},            // part -> latest cloud event (state 'disassembled' unless said otherwise)
    cloudsAsm: {},         // part -> cloud of the assembled state (memory)
    lastCloudPart: null,
    icp: null,
    grasp: null,
    telemetry: null,
    score: null,
    params: Object.fromEntries(Object.entries(PARAMS).map(([k, p]) => [k, p.v])),
    paper: null,
  };
}

const bi = (en, zh) => ({ en, zh });
const SRC_EXAMPLE = bi('worked example from docs/facts.md, until the lab sends values', '還沒收到實驗室的值，先用 docs/facts.md 的數字例');
const WAIT = (ev) => bi(`waiting for ${ev}`, `等待 ${ev}`);

/**
 * What one .eq-live block should show for the current state.
 * Returns { tag, src, rows:[{ tex, lab? }], pair?, notes:[{ en, zh, tag? }] }.
 */
export function buildModel(code, st) {
  const cap = st.capture, wp = st.waypoints;
  const capSrc = cap.example ? SRC_EXAMPLE : bi(`lab:capture, view ${cap.view ?? '–'} of ${cap.k ?? '–'}`, `lab:capture，第 ${cap.view ?? '–'}／${cap.k ?? '–'} 個視角`);
  const capTag = cap.example ? 'Local run' : 'Demo';
  switch (code) {
    case 'eq4':
      return { tag: capTag, src: capSrc, rows: [
        { tex: texEq4(cap), lab: bi('Matrix form', '矩陣形式') },
        { tex: texEq4Steps(cap), lab: bi('One coordinate at a time', '一次算一個座標') },
      ], notes: [bi('Camera optical frame: x right, y down, z forward. The depth d is measured along the optical axis.', '相機光學座標：x 向右、y 向下、z 向前。深度 d 沿光軸量。')] };
    case 'eq5':
    case 'eq5h': {
      const P = backproject(cap.K, cap.pixel.u, cap.pixel.v, cap.pixel.d);
      const W = transformPoint(cap.camToWorld, P);
      const rows = [];
      const notes = [];
      if (code === 'eq5') {
        rows.push({ tex: texEq5Printed(), lab: bi('As printed: the shapes', '照印刷：先看形狀') });
        notes.push({ ...bi('A 4×4 matrix cannot multiply a 3×1 vector. The numbers below use my reading: append a 1 to P.', '4×4 的矩陣不能直接乘 3×1 的向量。下面的數字採我的讀法：在 P 後面補一個 1。'), tag: 'Mismatch' });
      }
      rows.push({ tex: texEq5h(cap), lab: bi('With the homogeneous 1', '補上齊次的 1') });
      const m = { tag: capTag, src: capSrc, rows, notes };
      if (Array.isArray(cap.check)) {
        m.pair = {
          ref: 'Eq. (5)',
          a: { lab: bi('by the formula', '公式算的'), val: formatBind(W, { unit: 'm', digits: 4 }) },
          b: { lab: bi('measured in the scene', '場景裡量到的'), val: formatBind(cap.check, { unit: 'm', digits: 4 }) },
          d: { lab: bi('difference', '差'), val: formatBind(norm(sub(W, cap.check)) * 1000, { unit: 'mm', digits: 3, key: 'x_mm' }) },
        };
      }
      return m;
    }
    case 'K': {
      const K = cap.example ? st.K : cap.K;
      return { tag: 'Demo', src: bi('site/js/lab/config.js CAMERA; the paper does not print K', 'site/js/lab/config.js 的 CAMERA；論文沒有印 K'),
        rows: [{ tex: texK(K) }, { tex: texKinv(K), lab: bi('Its inverse, used in Eq. (4)', '它的反矩陣，式 (4) 用的') }],
        notes: [bi(`Image size ${CAMERA.width} × ${CAMERA.height} px. f_x, f_y: focal length in pixels; (c_x, c_y): principal point.`, `影像 ${CAMERA.width} × ${CAMERA.height} px。f_x、f_y 是以像素為單位的焦距；(c_x, c_y) 是主點。`)] };
    }
    case 'eq6':
    case 'eq6m': {
      const list = Object.values(st.clouds).map((c) => ({ ...c, current: c.part === st.lastCloudPart }));
      if (!list.length) return { tag: 'Demo', src: WAIT('lab:cloud'), rows: [{ tex: R`\lvert\mathcal{P}_i\rvert:\ \underbrace{n_1}_{j=1}+\dots+\underbrace{n_k}_{j=k}\ \rightarrow\ \text{points after down-sampling},\qquad k=${I(st.params['views.k'])}` }],
        notes: [bi('Run "fuse" in the Lab to fill in the counts.', '在 Lab 按「fuse」就會填入點數。')] };
      const notes = [bi('Each term is the number of masked pixels of one view that had a valid depth. The lab uses the object-ID image in place of Grounding DINO + Grounded SAM 2 masks.', '每一項是一個視角裡落在遮罩內、且有有效深度的像素數。實驗室用物件 ID 圖代替 Grounding DINO＋Grounded SAM 2 的遮罩。')];
      if (code === 'eq6m') notes.push({ ...bi(`My reading: the condition is that the pixel (u,v) lies in the mask. Mask erosion is ${fmtM(st.params['mask.erodePx'], 0)} px.`, `我的讀法：條件是像素 (u,v) 落在遮罩裡。遮罩侵蝕 ${fmtM(st.params['mask.erodePx'], 0)} px。`), tag: 'My view' });
      return { tag: 'Demo', src: bi(`lab:cloud, ${list.length} part(s)`, `lab:cloud，${list.length} 個零件`), rows: [{ tex: texEq6(list, { maskReading: code === 'eq6m' }) }], notes };
    }
    case 'Tr': {
      const icp = st.icp;
      const part = icp?.part ?? st.lastCloudPart;
      const cSrc = icp?.centroidSrc ?? st.clouds[part]?.centroid;
      const cDst = icp?.centroidDst ?? st.cloudsAsm[part]?.centroid;
      const src = bi(`part: ${part ?? '–'}; c_dis from the current cloud, c_s from memory`, `零件：${part ?? '–'}；c_dis 來自目前的點雲，c_s 來自記憶`);
      const note = bi('The paper says centroid "distance"; a distance is one number, so the rough translation is read here as the difference vector.', '論文寫質心「距離」；距離只是一個數，這裡把粗平移讀成兩個質心的差向量。');
      if (cSrc && cDst) return { tag: 'Demo', src, rows: [{ tex: texTr(cSrc, cDst) }], notes: [note] };
      if (icp?.T_rou) return { tag: 'Demo', src, rows: [{ tex: texTrOnly(icp.T_rou) }], notes: [note, bi('The two centroids were not in the event; only their difference is shown.', '事件裡沒有兩個質心，只顯示差向量。')] };
      return { tag: 'Demo', src: WAIT('lab:icp'), rows: [{ tex: R`T_{rou}=\bar{c}_{s}-\bar{c}_{dis}` }], notes: [note] };
    }
    case 'icp': {
      const rows = [{ tex: TEX_ICP_OBJECTIVE, lab: bi('Objective (Besl & McKay, ref. [32])', '目標式（Besl & McKay，文獻 [32]）'), tag: 'External' }];
      if (!st.icp) return { tag: 'Demo', src: WAIT('lab:icp'), rows, notes: [bi('This is the only minimisation in the pipeline. The paper has no loss and no trained parameter.', '整條流程只有這裡在做最小化。論文沒有 loss，也沒有被訓練的參數。')] };
      rows.push({ tex: texIcp(st.icp, st.params['icp.maxIters']), lab: bi('Current iteration', '目前這一次迭代') });
      return { tag: 'Demo', src: bi(`lab:icp, part: ${st.icp.part ?? '–'}`, `lab:icp，零件：${st.icp.part ?? '–'}`), rows,
        notes: [st.icp.converged ? bi('Converged.', '已收斂。') : bi('Not converged yet.', '還沒收斂。'), bi('p_i: points of the part as it lies now; q_i: nearest points of the remembered assembled state.', 'p_i：零件現在的點；q_i：記憶裡組好狀態的最近點。')] };
    }
    case 'Gobj': {
      const g = st.grasp;
      if (!g || !g.camToBase || !g.graspInCam) {
        return { tag: 'Demo', src: WAIT('lab:grasp'), rows: [{ tex: TEX_GOBJ_SHAPES }],
          notes: [bi('Placeholder: no event has delivered the two matrices yet, so no numbers are shown.', '佔位：還沒有事件送來這兩個矩陣，所以不顯示數字。')] };
      }
      const [a, b, c] = texGobj(g.camToBase, g.graspInCam);
      const m = { tag: 'Demo', src: bi(`lab:grasp, part: ${g.part ?? '–'}`, `lab:grasp，零件：${g.part ?? '–'}`), rows: [
        { tex: a, lab: bi('Hand–eye calibration: camera in the robot base', '手眼校正：相機在機器人底座座標裡的姿態') },
        { tex: b, lab: bi('Grasp pose in the camera frame (geometric rule here, AnyGrasp in the paper)', '相機座標裡的夾取姿態（這裡是幾何規則，論文用 AnyGrasp）') },
        { tex: c, lab: bi('Grasp pose in the robot base', '底座座標裡的夾取姿態') },
      ], notes: [bi(`Hand–eye error setting: ${fmt(st.params['handeye.errMm'], 1)} mm.`, `手眼誤差設定：${fmt(st.params['handeye.errMm'], 1)} mm。`)] };
      if (Array.isArray(g.graspInBase)) {
        const O = mul4(g.camToBase, g.graspInCam);
        const pf = [O[3], O[7], O[11]], pm = [g.graspInBase[3], g.graspInBase[7], g.graspInBase[11]];
        m.pair = { ref: 'Γ_obj',
          a: { lab: bi('position by the formula', '公式算的位置'), val: formatBind(pf, { unit: 'm', digits: 4 }) },
          b: { lab: bi('position used by the lab', '實驗室實際用的位置'), val: formatBind(pm, { unit: 'm', digits: 4 }) },
          d: { lab: bi('difference', '差'), val: formatBind(norm(sub(pf, pm)) * 1000, { unit: 'mm', digits: 3, key: 'x_mm' }) } };
      }
      return m;
    }
    case 'A': {
      const A = st.telemetry?.A;
      if (!A) return { tag: 'Demo', src: WAIT('lab:telemetry'), rows: [{ tex: R`A_t=\big[\ \underbrace{dx,\ dy,\ dz}_{T\ (\mathrm{m})},\ \underbrace{rx,\ ry,\ rz}_{R\ (\mathrm{rad})},\ \underbrace{s}_{\text{gripper}}\ \big]\in\mathbb{R}^{7}` }], notes: [] };
      return { tag: 'Demo', src: bi('lab:telemetry, about 15 times a second', 'lab:telemetry，每秒約 15 次'), rows: [
        { tex: texA(A) }, { tex: texADeg(A), lab: bi('The same step in mm and degrees', '同一步，換成 mm 與度') },
      ], notes: [bi('Three numbers move the gripper (translation), three turn it (Euler angles), one opens or closes it.', '三個數移動夾爪（平移），三個數轉動夾爪（歐拉角），一個數開合夾爪。')] };
    }
    case 'eq7':
    case 'eq7r': {
      const fr = segmentFractions(wp.coeffs);
      const equalTail = Math.abs(fr[2] - fr[3]) < 1e-9;
      const notes = [];
      if (code === 'eq7') notes.push({ ...bi('P×R is printed as a cross product of a position and a rotation. It is read here as: stay at P and turn the gripper.', '印刷的 P×R 是位置和旋轉的叉積。這裡讀成：留在 P，把夾爪轉到夾取方向。'), tag: 'Loose' });
      notes.push(equalTail
        ? bi(`Segment lengths as fractions of |T|: ${fr.map((f) => fmt(f, 2)).join(' : ')}. The last two are equal.`, `各段占 |T| 的比例：${fr.map((f) => fmt(f, 2)).join(' : ')}。最後兩段一樣長。`)
        : bi(`Segment lengths as fractions of |T|: ${fr.map((f) => fmt(f, 2)).join(' : ')}.`, `各段占 |T| 的比例：${fr.map((f) => fmt(f, 2)).join(' : ')}。`));
      const wpNote = wp.index != null
        ? bi(`Now at w${wp.index} (${wp.phase ?? 'approach'}).`, `目前走到 w${wp.index}（${wp.phase ?? 'approach'}）。`)
        : bi('Waypoints w0 to w5 ready.', '路點 w0 到 w5 已就緒。');
      notes.push(wpNote);
      return { tag: wp.example ? 'Local run' : 'Demo', src: wp.example ? SRC_EXAMPLE : bi(`lab:waypoints, phase: ${wp.phase ?? '–'}`, `lab:waypoints，階段：${wp.phase ?? '–'}`), rows: [
        { tex: texEq7(wp, { reading: code === 'eq7' ? 'printed' : 'rotate' }), lab: bi('The six waypoints', '六個路點') },
        { tex: texEq7Segments(wp), lab: bi('Length of each moving segment', '每一段移動多長') },
      ], notes };
    }
    case 'R': {
      const s = st.score;
      if (!s) return { tag: 'Derived', src: WAIT('score:update'), rows: [{ tex: R`R=\frac{\text{hits}}{n_{gt}}` }], notes: [bi('The paper gives no formula for R; this is the usual recall, written out. Pick a run in the Scores tab.', '論文沒有給 R 的公式；這是一般的 recall 寫法。到 Scores 分頁選一次實跑。')] };
      const level = { triple: 'Triple', pair: 'Pair', action: 'Action' }[s.level] || 'Triple';
      const rows = [{ tex: texR(s, level) }];
      if (s.set) rows.push({ tex: texRLevels(s.set, 'set'), lab: bi('Order ignored', '不看順序') });
      if (s.ordered) rows.push({ tex: texRLevels(s.ordered, 'ordered'), lab: bi('Order counted', '看順序') });
      return { tag: 'Derived', src: bi(`score:update${s.run ? ', run ' + s.run : ''}`, `score:update${s.run ? '，' + s.run : ''}`), rows,
        notes: [bi(`The model wrote ${s.n_pred ?? '–'} triples; the answer has ${s.n_gt}. Recall does not punish extra triples.`, `模型寫了 ${s.n_pred ?? '–'} 條 triple；標準答案有 ${s.n_gt} 條。recall 不會因為多寫而扣分。`)] };
    }
    case 'mR': {
      const s = st.score;
      const vals = Array.isArray(s?.tasks) ? s.tasks.map((t) => (typeof t === 'number' ? t : t?.R)).filter((x) => Number.isFinite(x)) : null;
      if (vals && vals.length) return { tag: 'Derived', src: bi(`score:update, ${vals.length} task(s)`, `score:update，${vals.length} 個任務`), rows: [{ tex: texMR(vals) }], notes: [] };
      if (s && s.n_gt) return { tag: 'Derived', src: bi('score:update, one task', 'score:update，只有一個任務'), rows: [{ tex: texMR([s.hits / s.n_gt]) }],
        notes: [bi('We scored one task (one photo), so M = 1 and mR equals R. Table 1 averages over 127 assembly diagrams.', '我們只計了一個任務（一張照片），所以 M = 1，mR 等於 R。表 1 是 127 張組裝圖的平均。')] };
      return { tag: 'Derived', src: WAIT('score:update'), rows: [{ tex: R`mR=\frac{1}{M}\sum_{m=1}^{M}R_m` }], notes: [bi('The paper gives no formula for mR; this is the mean of the per-task recalls.', '論文沒有給 mR 的公式；這是各任務 recall 的平均。')] };
    }
    case 'fisher': {
      if (!st.paper?.table2) return { tag: 'Derived', src: WAIT('site/data/paper.json'), rows: [], notes: [] };
      const ft = fisherTable(st.paper.table2, 20);
      const small = ft.rows.filter((r) => r.p < 0.05).map((r) => r.label);
      return { tag: 'Derived', src: bi('computed in this page from Table 2 (20 trials per cell)', '由表 2 在這一頁實算（每格 20 次）'), rows: [
        { tex: texFisherDef(ft.rows[0]), lab: bi('Fisher exact test, worked for product 1', 'Fisher 精確檢定，以產品 1 為例') },
        { tex: texFisherTable(ft), lab: bi('All five products and the pooled counts', '五個產品與加總') },
      ], notes: [bi(`Below 0.05: product ${small.join(', ') || 'none'}${ft.total.p < 0.05 ? ', and the pooled counts' : ''}. The paper prints no test; pooling the five products is my addition.`, `低於 0.05 的：產品 ${small.join('、') || '無'}${ft.total.p < 0.05 ? '，以及加總' : ''}。論文沒有做檢定；把五個產品加總是我加的。`)] };
    }
    case 'ci': {
      if (!st.paper?.table3) return { tag: 'Derived', src: WAIT('site/data/paper.json'), rows: [], notes: [] };
      const ct = ciTable(st.paper.table3, 10);
      return { tag: 'Derived', src: bi('computed in this page from Table 3 (10 trials per step)', '由表 3 在這一頁實算（每步 10 次）'), rows: [
        { tex: texCiDef(ct.rows[0]), lab: bi('Clopper–Pearson 95% interval, worked for step 1', 'Clopper–Pearson 95% 區間，以第 1 步為例') },
        { tex: texCiTable(ct), lab: bi('All five steps and the pooled counts', '五步與加總') },
      ], notes: [bi('With 10 trials the intervals are wide: 7/10 is compatible with a true rate anywhere from about 35% to 93%.', '只試 10 次，區間很寬：7/10 對應的真實成功率可以從約 35% 到 93%。')] };
    }
    default:
      return null;
  }
}

/** Which state slices each block depends on. */
export const DEPENDS = {
  eq4: ['capture'], eq5: ['capture'], eq5h: ['capture'], K: ['capture', 'params'],
  eq6: ['clouds', 'params'], eq6m: ['clouds', 'params'], Tr: ['icp', 'clouds'], icp: ['icp', 'params'],
  Gobj: ['grasp', 'params'], A: ['telemetry'], eq7: ['waypoints'], eq7r: ['waypoints'],
  R: ['score'], mR: ['score'], fisher: ['paper'], ci: ['paper'],
};

// ───────────────────────────────────────────────────────────── DOM (browser only)

const h = (s) => esc(s);
const biHtml = (t) => `<span class="en" lang="en">${h(t.en)}</span><span class="zh" lang="zh-Hant">${h(t.zh)}</span>`;

let katexPromise = null;
function loadKatex(ctx) {
  if (ctx?.katex) return Promise.resolve(ctx.katex);
  if (globalThis.katex) return Promise.resolve(globalThis.katex);
  if (!katexPromise) {
    katexPromise = import('../../vendor/katex/katex.mjs').then((m) => m.default || m).catch(() => new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = new URL('../../vendor/katex/katex.min.js', import.meta.url).href;
      s.onload = () => (globalThis.katex ? resolve(globalThis.katex) : reject(new Error('katex global missing')));
      s.onerror = () => reject(new Error('katex.min.js failed to load'));
      document.head.appendChild(s);
    }));
  }
  return katexPromise;
}
const KATEX_OPTS = { displayMode: true, throwOnError: false, strict: false, output: 'html', trust: (c) => c.command === '\\htmlClass' || c.command === '\\htmlData' };

/** Shrink a row to its column (down to 76 %); below that it scrolls sideways and becomes focusable.
 *  Locks scale and min-height per width so live value updates never make the block jump vertically. */
function fitRow(math) {
  math.style.fontSize = '';
  math.removeAttribute('tabindex');
  const avail = math.clientWidth;
  if (!avail) return;
  const key = String(Math.round(avail));
  if (math.__fitKey !== key) {
    math.__fitKey = key;
    math.__minScale = 1;
    math.style.minHeight = '';
    math.__lockedH = 0;
  }
  const need = math.scrollWidth;
  let k = 1;
  if (need > avail + 1) {
    k = Math.max(0.76, (avail - 2) / need);
  }
  k = Math.min(math.__minScale ?? 1, k);
  math.__minScale = k;
  if (k < 1) {
    math.style.fontSize = `calc(var(--lv-fs) * ${k.toFixed(3)})`;
  }
  if (math.scrollWidth > math.clientWidth + 1) math.tabIndex = 0;
  const h = math.offsetHeight;
  if (h > (math.__lockedH || 0)) {
    math.__lockedH = h;
    math.style.minHeight = `${h}px`;
  }
}

function renderBlock(b, model, katex, tag = (x) => x) {
  const el = b.el;
  if (!model) { el.hidden = true; return; }
  el.hidden = false;
  if (!b.built) {
    el.innerHTML = '<div class="lv-head"></div><div class="lv-rows"></div><div class="lv-pair" hidden></div><div class="lv-notes"></div>';
    el.classList.add('lv');
    [b.head, b.rowsEl, b.pairEl, b.notesEl] = el.children;
    b.rowCache = [];
    b.built = true;
  }
  const head = `<span class="lv-title">${biHtml(bi('Current values put in', '代入目前的值'))}</span><span class="tag" data-tag="${h(model.tag)}">${h(model.tag)}</span><span class="lv-src">${biHtml(model.src)}</span>`;
  if (head !== b.headHtml) { b.head.innerHTML = head; b.headHtml = head; }

  // rows: re-render only the rows whose TeX changed, then flash the numbers that differ
  while (b.rowsEl.children.length > model.rows.length) { b.rowsEl.lastElementChild.remove(); b.rowCache.pop(); }
  model.rows.forEach((row, i) => {
    let rowEl = b.rowsEl.children[i];
    if (!rowEl) {
      rowEl = document.createElement('div');
      rowEl.className = 'lv-row';
      rowEl.innerHTML = '<p class="lv-lab"></p><div class="lv-math" role="math"></div>';
      b.rowsEl.appendChild(rowEl);
      b.rowCache[i] = { tex: null, lab: null, nums: null };
    }
    const cache = b.rowCache[i];
    const lab = row.lab ? biHtml(row.lab) + (row.tag ? ` <span class="tag" data-tag="${h(row.tag)}">${h(row.tag)}</span>` : '') : '';
    if (lab !== cache.lab) { rowEl.firstElementChild.innerHTML = lab; rowEl.firstElementChild.hidden = !lab; cache.lab = lab; }
    rowEl.hidden = b.mainRow === i;
    if (row.tex === cache.tex) return;
    const math = rowEl.lastElementChild;
    try { katex.render(tag(row.tex), math, KATEX_OPTS); } catch (e) { try { katex.render(row.tex, math, KATEX_OPTS); } catch (e2) { math.textContent = stripMarks(row.tex); } }
    math.setAttribute('aria-label', stripMarks(row.tex));
    fitRow(math);
    const nums = [...math.querySelectorAll('.lv-n')];
    const texts = nums.map((n) => n.textContent);
    if (cache.nums && cache.nums.length === texts.length) {
      nums.forEach((n, j) => { if (texts[j] !== cache.nums[j]) n.classList.add('lv-chg'); });
    }
    cache.nums = texts;
    cache.tex = row.tex;
  });

  const p = model.pair;
  const pairHtml = p ? `<span class="lv-pair-ref">${h(p.ref)}</span>` + [p.a, p.b, p.d].map((c, i) => `<div class="lv-pair-cell${i === 2 ? ' is-delta' : ''}"><small>${biHtml(c.lab)}</small><output>${h(c.val)}</output></div>`).join('') : '';
  if (pairHtml !== b.pairHtml) { b.pairEl.innerHTML = pairHtml; b.pairEl.hidden = !p; b.pairHtml = pairHtml; }
  const notes = (model.notes || []).map((n) => `<p class="lv-note">${n.tag ? `<span class="tag" data-tag="${h(n.tag)}">${h(n.tag)}</span> ` : ''}${biHtml(n)}</p>`).join('');
  if (notes !== b.notesHtml) { b.notesEl.innerHTML = notes; b.notesHtml = notes; }
}

// Rows of the table under the shape diagram: [id, card key, symbol (trusted markup: sub and sup only), spoken name, meaning].
const SHAPES_ROWS = [
  ['rgb', 'O_t', 'I<sup>rgb</sup>', 'I rgb', bi('colour image: height × width × 3 channels', '彩色影像：高 × 寬 × 3 個色版')],
  ['depth', 'O_t', 'I<sup>depth</sup>', 'I depth', bi('depth image: one distance in metres per pixel', '深度影像：每個像素一個距離（公尺）')],
  ['uv', 'uv', '(u, v)', 'pixel (u, v)', bi('one pixel; the dot marks the same pixel in both images', '一個像素；圓點在兩張影像上標的是同一個像素')],
  ['d', 'd_t', 'd', 'depth d', bi('depth of that pixel, read from the depth image', '這個像素的深度，從深度影像讀出')],
  ['K', 'K', 'K', 'K', bi('camera intrinsics, 3 × 3 (setting)', '相機內參，3 × 3（設定值）')],
  ['Pt', 'P_t_short', 'P<sub>t</sub>', 'P t', bi('that pixel as a 3D point in the camera frame, Eq. (4)', '這個像素在相機座標裡的 3D 點，式 (4)')],
  ['G', 'Gamma_t', 'Γ<sub>t</sub>', 'Gamma t', bi('camera pose at time t, 4 × 4 (from the arm)', '時間 t 的相機姿態，4 × 4（由手臂讀到）')],
  ['Pw', 'P_w_t', 'P<sup>w</sup>', 'P w', bi('the same point in world coordinates, Eq. (5)', '同一個點換到世界座標，式 (5)')],
  ['cloud', 'P_cal_i', '𝒫<sub>i</sub>', 'script P i', bi('point cloud of part i: N points × 3 coordinates, from k views, Eq. (6)', '零件 i 的點雲：N 個點 × 3 個座標，來自 k 個視角，式 (6)')],
  ['A', 'A_t', 'A<sub>t</sub>', 'A t', bi('low-level action: 3 translations, 3 Euler angles, 1 gripper state', '低層動作：3 個平移、3 個歐拉角、1 個夾爪狀態')],
];

/** Make `el` look like `next` while keeping the nodes that did not change, so focus and an open card survive. */
function morph(el, next) {
  if (el.nodeType !== next.nodeType || el.nodeName !== next.nodeName) { el.replaceWith(next.cloneNode(true)); return; }
  if (el.nodeType === 3) { if (el.nodeValue !== next.nodeValue) el.nodeValue = next.nodeValue; return; }
  if (el.nodeType !== 1) return;
  for (const { name, value } of [...next.attributes]) {
    if (name === 'class' || name === 'aria-expanded') continue;      // pop.js marks open and same-symbol labels
    if (el.getAttribute(name) !== value) el.setAttribute(name, value);
  }
  for (const { name } of [...el.attributes]) if (!next.hasAttribute(name) && !['class', 'aria-expanded', 'tabindex'].includes(name)) el.removeAttribute(name);
  const want = next.getAttribute('class');
  if (want !== null) for (const c of want.split(/\s+/)) if (c) el.classList.add(c);
  const a = [...el.childNodes], b = [...next.childNodes];
  if (a.length !== b.length) { el.replaceChildren(...b.map((n) => n.cloneNode(true))); return; }
  a.forEach((n, i) => morph(n, b[i]));
}

/**
 * Scan the page and keep every live block current.
 * ctx: { bus:{ on, emit }, katex?, paper? }. Returns { state, refresh(), update(slice, value), destroy() }.
 */
export function init(ctx = {}) {
  const st = createState();
  const doc = globalThis.document;
  const blocks = [...doc.querySelectorAll('.eq-live[data-live]')].map((el) => ({ el, code: el.dataset.live, dirty: true, visible: true, built: false, face: null, mainRow: -1 }));
  const prefs = ctx.prefs || null;
  const tagFor = (b) => (ctx.tagTex ? (x) => ctx.tagTex(x, b.kp, { numbers: false }) : (x) => x);
  const wantValues = (b) => (b.face ? b.face === 'values' : !!(prefs ? prefs.get('live') : 1));
  // each formula with live values gets a two-way switch: the formula as printed, or with the numbers put in
  for (const b of blocks) {
    b.fig = b.el.closest('figure.eq');
    b.body = b.fig?.querySelector('.eq-body') || null;
    b.kp = b.el.closest('section.kp')?.id || '';
    if (!b.body) continue;
    b.printed = b.body.dataset.tex;
    const cap = b.fig.querySelector('figcaption');
    if (!cap) continue;
    const sw = doc.createElement('span');
    sw.className = 'eq-face';
    sw.innerHTML = `<button type="button" data-face="symbols">${biHtml(bi('Symbols', '符號'))}</button><button type="button" data-face="values">${biHtml(bi('Values', '數值'))}</button>`;
    sw.addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-face]');
      if (!btn) return;
      b.face = btn.dataset.face;
      b.dirty = true;
      b.rowCache?.forEach((c) => { c.tex = null; });
      schedule();
    });
    cap.append(sw);
    b.sw = sw;
  }
  prefs?.on?.('live', () => { for (const b of blocks) { b.face = null; b.dirty = true; b.rowCache?.forEach((c) => { c.tex = null; }); } schedule(); });
  /** The formula block itself: printed symbols, or the row of the model that has the numbers in it. */
  function paintFace(b, model) {
    if (!b.body) return;
    const rows = model?.rows || [];
    const idx = rows.length ? Math.min(rows.length - 1, model.main ?? (b.code === 'eq5' ? 1 : 0)) : -1;
    const values = wantValues(b) && idx >= 0;
    b.mainRow = values ? idx : -1;
    const tex = values ? rows[idx].tex : b.printed;
    b.fig.dataset.face = values ? 'values' : 'symbols';
    if (b.sw) for (const btn of b.sw.children) btn.setAttribute('aria-pressed', String(btn.dataset.face === b.fig.dataset.face));
    if (b.body.dataset.tex === tex && b.body.__tex) return;
    b.body.dataset.tex = tex;
    if (ctx.renderTex) { ctx.renderTex(b.body, tex, katex, { display: true, kp: b.kp, numbers: !values }); ctx.refitOne?.(b.body); }
  }
  const shapes = [...doc.querySelectorAll('.shapes[data-shapes]')].map((el) => ({ el, dirty: true, html: '' }));
  // the two images get their own cards once the symbol table has them; until then the observation O_t stands in
  const shapeKeys = () => {
    const has = (k) => !!ctx.getSymbol?.(k);
    return { rgb: has('I_rgb') ? 'I_rgb' : SHAPE_KEYS.rgb, depth: has('I_depth') ? 'I_depth' : SHAPE_KEYS.depth };
  };
  // SVG labels are not buttons: Enter and Space press them like one
  const onShapeKey = (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const g = e.target instanceof Element ? e.target.closest('.shapes .sh-hot') : null;
    if (!g || g !== e.target) return;
    e.preventDefault();
    e.stopPropagation();
    const r = g.getBoundingClientRect();
    g.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: r.left + 4, clientY: r.top + 4 }));
  };
  doc.addEventListener('keydown', onShapeKey, true);
  let katex = null, raf = 0, lastPaint = 0, dead = false;
  const MIN_GAP = 120; // ms between repaints; telemetry arrives 15 times a second

  const io = 'IntersectionObserver' in globalThis ? new IntersectionObserver((entries) => {
    for (const e of entries) {
      for (const b of blocks) if (b.watch === e.target) { b.visible = e.isIntersecting; if (b.visible && b.dirty) schedule(); }
    }
  }, { rootMargin: '200px' }) : null;
  // an empty .eq-live is display:none (report.css), so watch the figure around it instead
  blocks.forEach((b) => { b.watch = b.el.closest('figure') || b.el.parentElement || b.el; io?.observe(b.watch); });

  function paint() {
    raf = 0;
    if (dead || !katex) return;
    lastPaint = performance.now();
    for (const b of blocks) {
      if (!b.dirty || !b.visible) continue;
      b.dirty = false;
      let model = null;
      try { model = buildModel(b.code, st); } catch (e) { model = { tag: 'Demo', src: bi('could not build this block: ' + e.message, '這一塊排不出來：' + e.message), rows: [], notes: [] }; }
      paintFace(b, model);
      renderBlock(b, model, katex, tagFor(b));
    }
    for (const s of shapes) {
      if (!s.dirty) continue;
      s.dirty = false;
      if (s.el.dataset.shapes !== 'rgbd') continue;
      const cap = st.capture.example ? null : st.capture;
      const cloud = st.clouds[st.lastCloudPart];
      const arg = { h: CAMERA.height, w: CAMERA.width, u: cap?.pixel.u, v: cap?.pixel.v, d: cap?.pixel.d, N: cloud?.nPoints, k: st.params['views.k'], keys: shapeKeys() };
      const html = `<div class="shapes-scroll">${shapesSvg(arg)}</div><div class="shapes-table-wrap">${shapesTable(arg)}</div>`;
      if (html === s.html) continue;
      s.el.classList.add('lv-shapes');
      if (!s.html) s.el.innerHTML = html;
      else { const t = doc.createElement('div'); t.innerHTML = html; morph(s.el, Object.assign(s.el.cloneNode(false), { innerHTML: t.innerHTML })); }
      s.html = html;
    }
  }
  function schedule() {
    if (raf || dead) return;
    const wait = Math.max(0, MIN_GAP - (performance.now() - lastPaint));
    raf = setTimeout(() => requestAnimationFrame(paint), wait);
  }
  function touch(slice) {
    for (const b of blocks) if ((DEPENDS[b.code] || []).includes(slice)) b.dirty = true;
    if (slice === 'capture' || slice === 'clouds' || slice === 'params') shapes.forEach((s) => { s.dirty = true; });
    schedule();
  }
  function update(slice, value) {
    switch (slice) {
      case 'capture': st.capture = { ...value }; if (value.K) st.K = value.K.slice(); break;
      case 'waypoints': st.waypoints = { ...st.waypoints, ...value, example: false }; break;
      case 'cloud': {
        const asm = value.state === 'assembled' || value.state === 'memory';
        (asm ? st.cloudsAsm : st.clouds)[value.part] = { ...value };
        if (!asm) st.lastCloudPart = value.part;
        slice = 'clouds';
        break;
      }
      case 'icp': st.icp = { ...value }; break;
      case 'grasp': st.grasp = { ...value }; break;
      case 'telemetry': st.telemetry = value; break;
      case 'score': st.score = { ...value }; break;
      case 'paper': st.paper = value; break;
      case 'param': {
        st.params[value.path] = value.value;
        if (value.path === 'camera.fx') { st.K = st.K.slice(); st.K[0] = value.value; st.K[4] = value.value; }
        if (value.path.startsWith('eq7.') && st.waypoints.example !== false) {
          st.waypoints = { ...st.waypoints, coeffs: [st.params['eq7.a'], st.params['eq7.b'], st.params['eq7.c']] };
          touch('waypoints');
        }
        slice = 'params';
        break;
      }
      case 'reset': st.clouds = {}; st.cloudsAsm = {}; st.lastCloudPart = null; st.icp = null; st.grasp = null; touch('clouds'); touch('icp'); touch('grasp'); return;
      default: return;
    }
    touch(slice);
  }

  const bus = ctx.bus;
  if (bus?.on) {
    bus.on('lab:capture', (d) => update('capture', d));
    bus.on('lab:waypoints', (d) => update('waypoints', d));
    bus.on('lab:cloud', (d) => update('cloud', d));
    bus.on('lab:icp', (d) => update('icp', d));
    bus.on('lab:grasp', (d) => update('grasp', d));
    bus.on('lab:telemetry', (d) => update('telemetry', d));
    bus.on('lab:param', (d) => update('param', d));
    bus.on('lab:reset', () => update('reset'));
    bus.on('score:update', (d) => update('score', d));
  }

  // remove the flash class when its animation ends so the next change can flash again
  let fitTimer = 0;
  const onResize = () => { clearTimeout(fitTimer); fitTimer = setTimeout(() => { for (const b of blocks) if (b.built && b.visible) b.rowsEl.querySelectorAll('.lv-math').forEach(fitRow); }, 150); };
  globalThis.addEventListener?.('resize', onResize);
  const onAnimEnd = (e) => { if (e.target.classList?.contains('lv-chg')) e.target.classList.remove('lv-chg'); };
  const onToggle = (e) => {
    if (e.target instanceof Element && e.target.matches('details.eq-drawer[open]')) {
      e.target.querySelectorAll('.lv-math').forEach(fitRow);
    }
  };
  doc.addEventListener('animationend', onAnimEnd, true);
  doc.addEventListener('toggle', onToggle, true);

  loadKatex(ctx).then((k) => { katex = k; schedule(); }).catch((e) => {
    for (const b of blocks) { b.el.textContent = 'KaTeX did not load: ' + e.message; }
  });
  if (ctx.paper) update('paper', ctx.paper);
  else if (blocks.some((b) => b.code === 'fisher' || b.code === 'ci')) {
    fetch(new URL('../../data/paper.json', import.meta.url)).then((r) => (r.ok ? r.json() : null)).then((j) => { if (j) update('paper', j); }).catch(() => {});
  }

  return {
    state: st,
    update,
    refresh() { blocks.forEach((b) => { b.dirty = true; }); shapes.forEach((s) => { s.dirty = true; }); schedule(); },
    destroy() { dead = true; io?.disconnect(); globalThis.removeEventListener?.('resize', onResize); doc.removeEventListener('animationend', onAnimEnd, true); doc.removeEventListener('toggle', onToggle, true); doc.removeEventListener('keydown', onShapeKey, true); clearTimeout(raf); },
  };
}
