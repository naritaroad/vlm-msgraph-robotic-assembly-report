// Gearbox parts for the lab: involute gears, the white cover (tray), the hexagonal nut.
// Everything is generated from config.js. Geometry is built in millimetres and scaled to metres at the end.
//
// Part frame (all parts): origin at the centre of the bottom face, local +y along the bore axis.
// Cover frame in config is z up; here it becomes a three.js object with local (x, y, z) = (cover x, cover z, -cover y).
// Our own design for teaching (tag: Demo). Not the part used in the paper.

import * as THREE from 'three';

const MM = 0.001;

// ------------------------------------------------------------------ geometry helpers (shared with robot.js / world.js)

/**
 * Smooth normals except across edges sharper than `angle`.
 * three's toCreasedNormals quantises positions to 0.01 units, which is 1 cm in metres, so we do our own hashing
 * with a quantum that suits millimetre-scale parts. Returns a non-indexed geometry (position + normal [+ uv]).
 */
export function creaseNormals(geometry, angle = (35 * Math.PI) / 180, quantum = 1e-3) {
  const g = geometry.index ? geometry.toNonIndexed() : geometry;
  const pos = g.attributes.position.array;
  const n = pos.length / 3, faces = n / 3;
  const fn = new Float64Array(faces * 3);
  for (let f = 0; f < faces; f++) {
    const i = f * 9;
    const ux = pos[i + 3] - pos[i], uy = pos[i + 4] - pos[i + 1], uz = pos[i + 5] - pos[i + 2];
    const vx = pos[i + 6] - pos[i], vy = pos[i + 7] - pos[i + 1], vz = pos[i + 8] - pos[i + 2];
    // area-weighted face normal (not normalised yet): large faces count more, slivers count less
    fn[f * 3] = uy * vz - uz * vy; fn[f * 3 + 1] = uz * vx - ux * vz; fn[f * 3 + 2] = ux * vy - uy * vx;
  }
  const map = new Map();
  const inv = 1 / quantum;
  const keyOf = (i) => `${Math.round(pos[i] * inv)},${Math.round(pos[i + 1] * inv)},${Math.round(pos[i + 2] * inv)}`;
  const vkey = new Array(n);
  for (let v = 0; v < n; v++) {
    const k = keyOf(v * 3);
    vkey[v] = k;
    let list = map.get(k);
    if (!list) map.set(k, (list = []));
    list.push((v / 3) | 0);
  }
  const cosA = Math.cos(angle);
  const out = new Float32Array(n * 3);
  for (let v = 0; v < n; v++) {
    const f = (v / 3) | 0;
    const ax = fn[f * 3], ay = fn[f * 3 + 1], az = fn[f * 3 + 2];
    const al = Math.hypot(ax, ay, az) || 1;
    let sx = 0, sy = 0, sz = 0;
    for (const g2 of map.get(vkey[v])) {
      const bx = fn[g2 * 3], by = fn[g2 * 3 + 1], bz = fn[g2 * 3 + 2];
      const bl = Math.hypot(bx, by, bz);
      if (bl === 0) continue;
      if (g2 === f || (ax * bx + ay * by + az * bz) / (al * bl) >= cosA) { sx += bx; sy += by; sz += bz; }
    }
    const l = Math.hypot(sx, sy, sz) || 1;
    out[v * 3] = sx / l; out[v * 3 + 1] = sy / l; out[v * 3 + 2] = sz / l;
  }
  g.setAttribute('normal', new THREE.BufferAttribute(out, 3));
  return g;
}

/**
 * Triangle soup from a grid of points. rows[i][j] = [x, y, z]; every row has the same length.
 * closeU joins the last row to the first, closeV joins the last column to the first.
 * When the surface is closed the winding is fixed by the sign of the enclosed volume.
 */
export function gridSurface(rows, { closeU = true, closeV = true, flip = null } = {}) {
  const U = rows.length, V = rows[0].length;
  const nu = closeU ? U : U - 1, nv = closeV ? V : V - 1;
  const tri = [];
  let vol = 0;
  const push = (a, b, c) => {
    tri.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    vol += a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  };
  for (let i = 0; i < nu; i++) {
    const r0 = rows[i], r1 = rows[(i + 1) % U];
    for (let j = 0; j < nv; j++) {
      const j1 = (j + 1) % V;
      push(r0[j], r1[j], r1[j1]);
      push(r0[j], r1[j1], r0[j1]);
    }
  }
  const doFlip = flip === null ? vol < 0 : flip;
  if (doFlip) for (let i = 0; i < tri.length; i += 9) {
    for (let k = 0; k < 3; k++) { const t = tri[i + 3 + k]; tri[i + 3 + k] = tri[i + 6 + k]; tri[i + 6 + k] = t; }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
  return g;
}

/** Surface of revolution about +y from a closed (r, y) profile. */
export function latheClosed(profile, segments = 48) {
  const rows = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2, c = Math.cos(a), s = Math.sin(a);
    rows.push(profile.map(([r, y]) => [r * c, y, -r * s]));
  }
  return gridSurface(rows);
}

/** Merge position-only triangle soups (drops other attributes). */
export function mergeSoups(list) {
  let n = 0;
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g).attributes.position.array);
  for (const p of parts) n += p.length;
  const out = new Float32Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(out, 3));
  return g;
}

function finish(geo, { crease = 35, scale = MM } = {}) {
  const g = creaseNormals(geo, (crease * Math.PI) / 180, 1e-3);
  g.scale(scale, scale, scale);
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

function circlePts(r, n, cx = 0, cy = 0, start = 0) {
  const a = [];
  for (let i = 0; i < n; i++) { const t = start + (i / n) * Math.PI * 2; a.push(new THREE.Vector2(cx + r * Math.cos(t), cy + r * Math.sin(t))); }
  return a;
}

// Extrude a shape along +y (after the usual x-y shape plane is laid flat). y0..y1 are the final extents, bevel included.
function extrudeY(shape, y0, y1, bevel, bevelSegments = 2) {
  const g = new THREE.ExtrudeGeometry(shape, {
    depth: y1 - y0 - 2 * bevel, bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel,
    bevelOffset: -bevel, bevelSegments, curveSegments: 12, steps: 1,
  });
  g.translate(0, 0, bevel + y0);
  g.rotateX(-Math.PI / 2);          // (x, y, z) -> (x, z, -y): shape angle = yaw about +y
  g.deleteAttribute('uv');
  g.deleteAttribute('normal');
  return g;
}

// ------------------------------------------------------------------ involute gear

/** Pitch, base, tip and root radii in the units of `module`. */
export function gearRadii(teeth, module, pressureAngle) {
  const r = (module * teeth) / 2;
  return { pitch: r, base: r * Math.cos(pressureAngle), tip: r + module, root: r - 1.25 * module };
}

/**
 * Closed 2D outline of an involute spur gear, counter-clockwise, tooth 0 centred on angle `phase`.
 * backlash: tangential thinning of each tooth at the pitch circle (same unit as module).
 */
export function involuteOutline(teeth, module, pressureAngle, { backlash = 0.08, fillet = 0.3 * module, flankN = 5, phase = 0 } = {}) {
  const z = teeth, m = module, al = pressureAngle;
  const { pitch: r, base: rb, tip: ra, root: rf } = gearRadii(z, m, al);
  const inv = (x) => Math.tan(x) - x;
  const half = Math.PI / (2 * z) - backlash / (2 * r);
  const flank = (rho) => half + inv(al) - inv(Math.acos(Math.min(1, rb / rho)));
  const rs = Math.max(rb, rf + fillet);        // radius where the involute starts
  const phiS = flank(rs);
  const dFil = fillet / rf;
  const P = (rho, a) => [rho * Math.cos(a), rho * Math.sin(a)];
  const pts = [];
  for (let k = 0; k < z; k++) {
    const c = phase + (2 * Math.PI * k) / z;
    const side = [];                            // root -> tip on the low-angle side, as (rho, offset from c)
    const p0 = [rf, phiS + dFil], p1 = [rf, phiS], p2 = [rf + fillet, phiS];
    for (const t of [0, 1 / 3, 2 / 3]) {
      const a = (1 - t) * (1 - t), b = 2 * t * (1 - t), d = t * t;
      // Bezier in polar parameters is close enough over 0.6 mm and keeps the mirror exact
      side.push([a * p0[0] + b * p1[0] + d * p2[0], a * p0[1] + b * p1[1] + d * p2[1]]);
    }
    side.push(p2);
    for (let i = rs > rf + fillet + 1e-9 ? 0 : 1; i <= flankN; i++) {
      const t = i / flankN, rho = rs + (ra - rs) * t;
      side.push([rho, flank(rho)]);
    }
    for (const [rho, off] of side) pts.push(P(rho, c - off));
    pts.push(P(ra, c));                         // middle of the tip land
    for (let i = side.length - 1; i >= 0; i--) pts.push(P(side[i][0], c + side[i][1]));
    pts.push(P(rf, c + Math.PI / z));           // middle of the root land
  }
  return pts;
}

/** Proportions of the gear body derived from the tooth data (mm). Kept here so tests and colliders can read them. */
export function gearBody(GEAR, sizeKey) {
  const m = GEAR.module / MM, z = GEAR[sizeKey].teeth, F = GEAR.faceWidth / MM;
  const R = gearRadii(z, m, GEAR.pressureAngle);
  const bore = GEAR.bore / MM / 2;
  const large = sizeKey === 'large';
  const rimIn = R.root - (large ? 4.0 : 3.6);
  const hub = large ? 10.5 : 7.6;
  const recess = large ? 4.0 : 3.0;
  const fillet = large ? 1.2 : 0.7;
  const holeR = large ? (rimIn - hub) * 0.5 - 2.6 : (rimIn - hub) * 0.5 - 1.15;
  const holeAt = (rimIn + hub) / 2;
  return { m, z, F, ...R, boreR: bore, boreChamfer: GEAR.boreChamfer / MM, rimIn, hub, recess, holeR, holeAt, fillet, bevel: 0.45 };
}

export function buildGearGeometry(GEAR, sizeKey) {
  const b = gearBody(GEAR, sizeKey);
  // 1. toothed rim, full face width
  const rim = new THREE.Shape(involuteOutline(b.z, b.m, GEAR.pressureAngle).map(([x, y]) => new THREE.Vector2(x, y)));
  rim.holes.push(new THREE.Path(circlePts(b.rimIn, 72).reverse()));
  const gRim = extrudeY(rim, 0, b.F, b.bevel, 2);
  // 2. recessed web with four lightening holes
  const web = new THREE.Shape(circlePts(b.rimIn + 0.6, 72));
  web.holes.push(new THREE.Path(circlePts(b.hub - 0.6, 40).reverse()));
  for (let i = 0; i < 4; i++) {
    const a = Math.PI / 4 + (i * Math.PI) / 2;
    web.holes.push(new THREE.Path(circlePts(b.holeR, 28, b.holeAt * Math.cos(a), b.holeAt * Math.sin(a)).reverse()));
  }
  const gWeb = extrudeY(web, b.recess, b.F - b.recess, 0.35, 2);
  // 3. hub, flush with the rim so stacked gears sit face to face; bore chamfered at both ends
  const c = b.boreChamfer, e = 0.6;
  const gHub = latheClosed([
    [b.boreR + c, 0], [b.boreR, c], [b.boreR, b.F - c], [b.boreR + c, b.F],
    [b.hub - e, b.F], [b.hub, b.F - e], [b.hub, e], [b.hub - e, 0],
  ], 56);
  // 4. small fillets where the web meets the hub and the rim (reads as a moulded part instead of three stacked solids)
  const f = b.fillet, fil = [];
  for (const [rr, sgn] of [[b.hub, 1], [b.rimIn, -1]]) {
    for (const top of [true, false]) {
      const y = top ? b.F - b.recess : b.recess, up = top ? 1 : -1;
      const prof = [[rr - sgn * 0.2, y - up * 0.2], [rr + sgn * f, y - up * 0.2]];
      for (let i = 0; i <= 5; i++) {
        const t = (i / 5) * (Math.PI / 2);
        prof.push([rr + sgn * f * (1 - Math.sin(t)), y + up * f * (1 - Math.cos(t))]);
      }
      prof.push([rr - sgn * 0.2, y + up * f]);
      fil.push(latheClosed(prof, 56));
    }
  }
  const g = finish(mergeSoups([gRim, gWeb, gHub, ...fil]), { crease: 38 });
  g.userData.body = b;
  return g;
}

// ------------------------------------------------------------------ nut

export function buildNutGeometry(NUT) {
  const af = NUT.acrossFlats / MM / 2, H = NUT.height / MM, rb = NUT.bore / MM / 2, ch = NUT.chamfer / MM;
  const rc = af / Math.cos(Math.PI / 6);            // corner radius
  const slope = Math.tan(Math.PI / 6);              // 30 degree chamfer cone, measured from the face
  const r0 = rc - ch / slope;                       // cone radius on the face: corners are cut `ch` deep
  const cb = 0.6;                                   // bore chamfer
  const rows = [];
  const per = 14;
  for (let s = 0; s < 6; s++) for (let i = 0; i < per; i++) {
    const local = -Math.PI / 6 + (i / per) * (Math.PI / 3);     // angle from the middle of a flat
    const a = s * (Math.PI / 3) + Math.PI / 6 + local;
    const R = af / Math.cos(local);
    const t = Math.max(0.02, (R - r0) * slope);
    const c = Math.cos(a), sn = Math.sin(a);
    rows.push([[rb + cb, 0], [rb, cb], [rb, H - cb], [rb + cb, H], [Math.min(r0, R - 0.01), H], [R, H - t], [R, t], [Math.min(r0, R - 0.01), 0]]
      .map(([r, y]) => [r * c, y, -r * sn]));
  }
  return finish(gridSurface(rows), { crease: 28 });
}

// ------------------------------------------------------------------ cover (shallow tray)

/** Samples of the inner outline at floor level: base point p and outward normal n, counter-clockwise in the cover x-y plane. */
export function coverOutline(COVER, n1 = 60, n2 = 44) {
  const [A, B] = COVER.outline.map((c) => ({ x: c.x / MM, r: c.r / MM }));   // A: red end (+x), B: yellow end
  const beta = Math.asin((A.r - B.r) / (A.x - B.x));
  const tu = Math.PI / 2 + beta;                    // normal angle of the upper tangent line
  const out = [];
  for (let i = 0; i <= n1; i++) { const t = -tu + (2 * tu * i) / n1; out.push({ cx: A.x, r: A.r, t }); }
  for (let i = 0; i <= n2; i++) { const t = tu + ((2 * Math.PI - 2 * tu) * i) / n2; out.push({ cx: B.x, r: B.r, t }); }
  return out.map(({ cx, r, t }) => ({ n: [Math.cos(t), Math.sin(t)], p: [cx + r * Math.cos(t), r * Math.sin(t)], t, cx, r }));
}

export const COVER_STYLE = {
  draftTop: 1.0,       // mm the wall leans outward at its top edge (moulding draft). The config outline holds at floor level.
  floorFillet: 2.0,    // mm, inside corner between floor and wall
  bottomChamfer: 0.6,  // mm
  ear: { width: 9, reach: 7.5, height: 5, hole: 3.4, holeAt: 4.6 },
  // normal angles (deg) of ears on the big-circle arc and on the small-circle arc, plus the two straight sides
  earsBig: [28, -28, 78, -78], earsSmall: [180, 128, 232], earsStraight: [1],
};

export function buildCoverGeometry(COVER) {
  const S = COVER_STYLE;
  const floor = COVER.floor / MM, wall = COVER.wall / MM, H = COVER.wallHeight / MM;
  const outline = coverOutline(COVER);
  const rt = wall / 2;                                              // top edge is a full round
  const lean = (h) => (S.draftTop * Math.max(0, h - floor)) / (H - floor);
  // cross-section (offset from the nominal inner outline, height), from the floor up the inside, over the top, down the outside
  const prof = [];
  const Rf = S.floorFillet;
  for (let i = 0; i <= 5; i++) { const a = -Math.PI / 2 + (i / 5) * (Math.PI / 2); const h = floor + Rf + Rf * Math.sin(a); prof.push([-Rf + Rf * Math.cos(a) + lean(h), h]); }
  const hc = H - rt, oc = lean(hc) + rt;
  for (let i = 0; i <= 8; i++) { const a = Math.PI - (i / 8) * Math.PI; prof.push([oc + rt * Math.cos(a), hc + rt * Math.sin(a)]); }
  prof.push([wall + lean(floor + 4), floor + 4]);
  prof.push([wall, S.bottomChamfer]);
  prof.push([wall - S.bottomChamfer, 0]);
  const at = (s, o, h) => [s.p[0] + s.n[0] * o, h, -(s.p[1] + s.n[1] * o)];
  const rows = outline.map((s) => prof.map(([o, h]) => at(s, o, h)));
  // rows run counter-clockwise (seen from above) and the profile runs inside -> top -> outside, so the raw winding
  // faces inward; flip it
  const shell = gridSurface(rows, { closeU: true, closeV: false, flip: true });
  // caps: fan from an interior point (the outline is convex)
  const cap = (o, h, up) => {
    const cx = (COVER.outline[0].x + COVER.outline[1].x) / 2 / MM;
    const tri = [];
    for (let i = 0; i < outline.length; i++) {
      const a = at(outline[i], o, h), b = at(outline[(i + 1) % outline.length], o, h);
      if (up) tri.push(cx, h, 0, ...a, ...b); else tri.push(cx, h, 0, ...b, ...a);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(tri), 3));
    return g;
  };
  const list = [shell, cap(prof[0][0], floor, true), cap(wall - S.bottomChamfer, 0, false)];
  // bosses under the gears, with a fillet into the floor
  const bossR = COVER.bossDiameter / MM / 2, bossTop = floor + COVER.bossHeight / MM, shaftR = COVER.shaftDiameter / MM / 2;
  for (const sh of Object.values(COVER.shafts)) {
    const pr = [[shaftR - 0.3, floor - 0.5], [bossR + 1.4, floor - 0.5], [bossR + 1.4, floor]];
    for (let i = 1; i <= 5; i++) { const a = (i / 5) * (Math.PI / 2); pr.push([bossR + 1.4 * (1 - Math.sin(a)), floor + 1.4 * (1 - Math.cos(a))]); }
    pr.push([bossR, bossTop - 0.5], [bossR - 0.5, bossTop], [shaftR - 0.3, bossTop]);
    const g = latheClosed(pr, 40);
    g.translate(sh.x / MM, 0, -sh.y / MM);
    list.push(g);
  }
  // mounting ears on the outside, at the base
  const E = S.ear;
  const earShape = () => {
    const sh = new THREE.Shape();
    const w = E.width / 2;
    sh.moveTo(-1.2, -w); sh.lineTo(E.reach - w, -w); sh.absarc(E.reach - w, 0, w, -Math.PI / 2, Math.PI / 2, false); sh.lineTo(-1.2, w); sh.closePath();
    sh.holes.push(new THREE.Path(circlePts(E.hole / 2, 20, E.holeAt, 0).reverse()));
    return sh;
  };
  const placeEar = (px, py, t) => {
    const g = extrudeY(earShape(), 0, E.height, 0.4, 2);
    g.rotateY(t);
    g.translate(px, 0, -py);
    list.push(g);
  };
  const [A, B] = COVER.outline.map((c) => ({ x: c.x / MM, r: c.r / MM }));
  for (const d of S.earsBig) { const t = (d * Math.PI) / 180; placeEar(A.x + (A.r + wall) * Math.cos(t), (A.r + wall) * Math.sin(t), t); }
  for (const d of S.earsSmall) { const t = (d * Math.PI) / 180; placeEar(B.x + (B.r + wall) * Math.cos(t), (B.r + wall) * Math.sin(t), t); }
  {
    const beta = Math.asin((A.r - B.r) / (A.x - B.x)), tu = Math.PI / 2 + beta;
    for (const sgn of S.earsStraight) {
      const t = sgn * tu, k = 0.42;
      const ax = A.x + (A.r + wall) * Math.cos(t), ay = (A.r + wall) * Math.sin(t);
      const bx = B.x + (B.r + wall) * Math.cos(t), by = (B.r + wall) * Math.sin(t);
      placeEar(ax + (bx - ax) * k, ay + (by - ay) * k, t);
    }
  }
  return finish(mergeSoups(list), { crease: 40 });
}

export function buildShaftGeometry(COVER) {
  const floor = COVER.floor / MM, R = COVER.shaftDiameter / MM / 2, c = COVER.shaftChamfer / MM;
  const list = [];
  for (const sh of Object.values(COVER.shafts)) {
    const top = sh.top / MM;
    const g = latheClosed([[0, top], [R - c, top], [R - c + 0.15, top - 0.05], [R, top - c], [R, floor - 0.4], [0, floor - 0.4]], 40);
    g.translate(sh.x / MM, 0, -sh.y / MM);
    list.push(g);
  }
  return finish(mergeSoups(list), { crease: 30 });
}

// ------------------------------------------------------------------ poses

const yawQuat = (yaw) => [0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)];

/** Yaw (about the bore axis) that puts each layer-1 gear tooth-to-gap with its neighbour in the assembled state. */
export function seatPhase(config, key) {
  const part = config.PARTS.find((p) => p.key === key);
  if (!part || part.kind !== 'gear') return 0;
  if (key === 'green' || key === 'blue') return 0;        // green has a tooth on the line of centres (even tooth count)
  return Math.PI / config.GEAR[part.size].teeth;          // red and yellow are turned by half a pitch
}

/**
 * World pose of a part (or of 'cover'). state: 'home' (disassembled, flat on the table) or 'seat' (assembled).
 * Returns { position: [x, y, z], quaternion: [x, y, z, w] } for the part frame (bottom-face centre, +y along the bore).
 */
export function poseFor(config, key, state = 'home') {
  const { COVER, TABLE } = config;
  const cw = COVER.world;
  if (key === 'cover') return { position: [...cw.position], quaternion: yawQuat(cw.yaw) };
  const part = config.PARTS.find((p) => p.key === key);
  if (!part) throw new Error(`poseFor: unknown part "${key}"`);
  if (state === 'home') return { position: [part.home.x, TABLE.topY, part.home.z], quaternion: yawQuat(part.home.yaw) };
  const sh = COVER.shafts[part.seat.shaft];
  const lx = sh.x, ly = part.seat.z, lz = -sh.y;          // cover frame -> three local
  const c = Math.cos(cw.yaw), s = Math.sin(cw.yaw);
  return {
    position: [cw.position[0] + c * lx + s * lz, cw.position[1] + ly, cw.position[2] - s * lx + c * lz],
    quaternion: yawQuat(cw.yaw + seatPhase(config, key)),
  };
}

/** Gear ratio table for spinGears: angle of each part for a red-gear angle of 1 rad. */
export function spinRatios(config) {
  const zr = config.GEAR.large.teeth, zm = config.GEAR.medium.teeth;
  return { red: 1, green: -zr / zm, yellow: zr / zm, blue: -zr / zm, nut: -zr / zm };
}

// ------------------------------------------------------------------ numeric checks used by the self-test

function pointInPoly(p, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if ((a[1] > p[1]) !== (b[1] > p[1]) && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}
function distToPoly(p, poly) {
  let best = Infinity;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy));
  }
  return best;
}

/**
 * Checks of the assembled and the disassembled layout, straight from config and the generated outlines.
 * Lengths in mm. `ok` is true when nothing interpenetrates.
 */
export function checkAssembly(config) {
  const { GEAR, COVER, NUT, PARTS, TABLE } = config;
  const res = { ok: true, mesh: [], bores: [], stack: [], wall: [], home: [] };
  const outlineOf = (key) => {
    const part = PARTS.find((p) => p.key === key), sh = COVER.shafts[part.seat.shaft];
    return involuteOutline(GEAR[part.size].teeth, GEAR.module / MM, GEAR.pressureAngle, { phase: seatPhase(config, key), flankN: 10 })
      .map(([x, y]) => [x + sh.x / MM, y + sh.y / MM]);
  };
  for (const [a, b] of [['red', 'green'], ['green', 'yellow']]) {
    const A = outlineOf(a), B = outlineOf(b);
    let overlap = 0, gap = Infinity;
    for (const p of A) { if (pointInPoly(p, B)) overlap++; gap = Math.min(gap, distToPoly(p, B)); }
    for (const p of B) { if (pointInPoly(p, A)) overlap++; gap = Math.min(gap, distToPoly(p, A)); }
    res.mesh.push({ pair: `${a}-${b}`, overlapVertices: overlap, minGapMm: +gap.toFixed(4) });
    if (overlap) res.ok = false;
  }
  for (const part of PARTS) {
    const bore = (part.kind === 'gear' ? GEAR.bore : NUT.bore) / MM, shaft = COVER.shaftDiameter / MM;
    const sh = COVER.shafts[part.seat.shaft];
    const h = (part.kind === 'gear' ? GEAR.faceWidth : NUT.height) / MM;
    res.bores.push({ key: part.key, radialClearanceMm: +((bore - shaft) / 2).toFixed(3), shaftAboveTopMm: +(sh.top / MM - part.seat.z / MM - h).toFixed(3) });
    if (bore <= shaft) res.ok = false;
  }
  // stacking on the green shaft: each bottom face must be at or above the top face below it
  const onGreen = PARTS.filter((p) => p.seat.shaft === 'shaft_green').sort((a, b) => a.seat.z - b.seat.z);
  for (let i = 1; i < onGreen.length; i++) {
    const lo = onGreen[i - 1], hi = onGreen[i];
    const top = lo.seat.z / MM + (lo.kind === 'gear' ? GEAR.faceWidth : NUT.height) / MM;
    const gapMm = +(hi.seat.z / MM - top).toFixed(3);
    res.stack.push({ upper: hi.key, lower: lo.key, gapMm });
    if (gapMm < -1e-6) res.ok = false;
  }
  // radial clearance between each gear tip circle and the tray wall, at the height of the gear's bottom face
  const [A, B] = COVER.outline.map((c) => ({ x: c.x / MM, r: c.r / MM }));
  const beta = Math.asin((A.r - B.r) / (A.x - B.x));
  // distance from a point on the x axis to the nominal inner wall: the tangent line between the two circles,
  // or the end arc when the point lies beyond a circle centre
  const wallDist = (x) => Math.min(A.r - Math.sin(beta) * (A.x - x), x > A.x ? A.r - (x - A.x) : Infinity, x < B.x ? B.r - (B.x - x) : Infinity);
  for (const part of PARTS.filter((p) => p.kind === 'gear')) {
    const sh = COVER.shafts[part.seat.shaft];
    const tip = gearRadii(GEAR[part.size].teeth, GEAR.module / MM, GEAR.pressureAngle).tip;
    const zBottom = part.seat.z / MM;
    const nominal = wallDist(sh.x / MM) - tip;
    const insideWall = zBottom < COVER.wallHeight / MM;
    const lean = (COVER_STYLE.draftTop * Math.max(0, zBottom - COVER.floor / MM)) / ((COVER.wallHeight - COVER.floor) / MM);
    res.wall.push({ key: part.key, nominalClearanceMm: +nominal.toFixed(3), withDraftMm: +(nominal + lean).toFixed(3), belowWallTop: insideWall });
    if (insideWall && nominal + lean < 0) res.ok = false;
  }
  // disassembled layout: parts must not overlap each other or the cover footprint, and must lie on the table
  const foot = (p) => (p.kind === 'gear' ? gearRadii(GEAR[p.size].teeth, GEAR.module / MM, GEAR.pressureAngle).tip : NUT.acrossFlats / MM / 2 / Math.cos(Math.PI / 6));
  for (let i = 0; i < PARTS.length; i++) for (let j = i + 1; j < PARTS.length; j++) {
    const a = PARTS[i], b = PARTS[j];
    const gapMm = Math.hypot(a.home.x - b.home.x, a.home.z - b.home.z) / MM - foot(a) - foot(b);
    res.home.push({ pair: `${a.key}-${b.key}`, gapMm: +gapMm.toFixed(2) });
    if (gapMm < 0) res.ok = false;
  }
  for (const p of PARTS) {
    const hx = TABLE.center[0], hz = TABLE.center[1];
    const onTable = Math.abs(p.home.x - hx) + foot(p) * MM < TABLE.size[0] / 2 && Math.abs(p.home.z - hz) + foot(p) * MM < TABLE.size[2] / 2;
    if (!onTable) { res.ok = false; res.home.push({ key: p.key, offTable: true }); }
  }
  return res;
}

// ------------------------------------------------------------------ scene objects

/**
 * Builds the cover and the five parts. `lib` is the material library from world.js.
 * Each part is { object (pose set by rig.setPartPose), spinner (child turned by rig.spinGears), mesh }.
 */
export function createParts(config, lib) {
  const { GEAR, COVER, NUT, PARTS } = config;
  const group = new THREE.Group();
  group.name = 'parts';
  const geos = { large: buildGearGeometry(GEAR, 'large'), medium: buildGearGeometry(GEAR, 'medium'), nut: buildNutGeometry(NUT) };
  const parts = {};
  const ID = config.IDS ?? { cover: 1, red: 2, green: 3, yellow: 4, blue: 5, nut: 6 };

  const cover = new THREE.Group();
  cover.name = 'cover';
  cover.userData.captureId = ID.cover;
  const coverMesh = new THREE.Mesh(buildCoverGeometry(COVER), lib.coverPlastic);
  const shaftMesh = new THREE.Mesh(buildShaftGeometry(COVER), lib.polishedSteel);
  for (const m of [coverMesh, shaftMesh]) { m.castShadow = true; m.receiveShadow = true; cover.add(m); }
  const cp = poseFor(config, 'cover');
  cover.position.fromArray(cp.position);
  cover.quaternion.fromArray(cp.quaternion);
  cover.userData.labelHeight = COVER.wallHeight + 0.02;
  group.add(cover);
  parts.cover = { key: 'cover', object: cover, spinner: cover, mesh: coverMesh, def: config.FIXTURES[0] };

  for (const def of PARTS) {
    const object = new THREE.Group();
    object.name = `part:${def.key}`;
    object.userData.captureId = ID[def.key];
    const spinner = new THREE.Group();
    const geo = def.kind === 'gear' ? geos[def.size] : geos.nut;
    const mesh = new THREE.Mesh(geo, def.kind === 'gear' ? lib.gearPlastic(def.color) : lib.nutPlastic(def.color));
    mesh.castShadow = true; mesh.receiveShadow = true;
    spinner.add(mesh);
    object.add(spinner);
    object.userData.labelHeight = (def.kind === 'gear' ? GEAR.faceWidth : NUT.height) + 0.012;
    group.add(object);
    parts[def.key] = { key: def.key, object, spinner, mesh, def };
  }

  const setPose = (key, position, quaternion) => {
    const p = parts[key];
    if (!p) throw new Error(`setPartPose: unknown part "${key}"`);
    p.object.position.set(position[0], position[1], position[2]);
    if (quaternion) p.object.quaternion.set(quaternion[0], quaternion[1], quaternion[2], quaternion[3]);
  };
  const setState = (state) => { for (const def of PARTS) { const q = poseFor(config, def.key, state); setPose(def.key, q.position, q.quaternion); } };
  const ratios = spinRatios(config);
  const spin = (angleRed, { carryStack = true } = {}) => {
    for (const k of ['red', 'green', 'yellow']) parts[k].spinner.rotation.y = angleRed * ratios[k];
    const a = carryStack ? angleRed * ratios.blue : 0;
    parts.blue.spinner.rotation.y = a; parts.nut.spinner.rotation.y = a;
  };
  setState('home');
  return { group, parts, setPose, setState, spin, ids: ID };
}
