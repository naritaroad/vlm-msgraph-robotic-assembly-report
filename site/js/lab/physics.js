// Rapier world for the lab: table, cover with real shafts, gears and nut with real bores,
// kinematic arm and gripper pads, contact-based grasp test, pose read-out.
// No three.js, no DOM. World frame: y up, metres. Matrices are row-major 4x4, quaternions [x,y,z,w].
//
// Simplifications (also listed in tools/tests/README.md):
//  - Gear teeth are not collision geometry. Each gear is a ring of convex wedges around a real bore;
//    the ring's outer radius is the pitch radius minus PHYSICS.pitchInset so meshed neighbours do not jam.
//    A second, pad-only cylinder at the tooth-tip radius is what the gripper pads touch.
//  - A grasp is a fixed joint between the gripper and the part, created only when both pads touch the same
//    part with opposed contact normals. Friction alone does not hold the part.
//  - Arm links are kinematic capsules; they push parts but are not stopped by the table (planning checks that).
//
// Scale: Rapier (parry) re-uses a contact manifold until its points drift by 1 mm (a hard-coded 1e-6 m^2
// threshold), which is larger than our 0.5 mm shaft clearance. World.lengthUnit does not change that
// threshold. So the whole world is built PHYSICS.scale times larger, around an origin on the table top,
// with gravity scaled by the same factor. Rigid motion under gravity and contact is unchanged by this;
// every pose is converted back to metres before it leaves this module.

import { fk, mul, trans, quatOf, matOf, invRigid, pos, xform, TCP_Z } from './kinematics.js';

export const G = { STATIC: 1, PART: 2, PAD: 4, ARM: 8, GRIP: 16 };
const groups = (member, filter) => (((member & 0xffff) << 16) | (filter & 0xffff)) >>> 0;
const V = (a) => ({ x: a[0], y: a[1], z: a[2] });
const Q = (a) => ({ x: a[0], y: a[1], z: a[2], w: a[3] });
const yawQuat = (a) => [0, Math.sin(a / 2), 0, Math.cos(a / 2)];

// ------------------------------------------------------------------ geometry helpers (pure, exported for tests)

/** Cover frame (z up) -> world (y up). See config.FRAMES.cover. */
export function coverToWorld(config) {
  const { position: p, yaw } = config.COVER.world;
  const c = Math.cos(yaw), s = Math.sin(yaw);
  return [c, -s, 0, p[0], 0, 0, 1, p[1], -s, -c, 0, p[2], 0, 0, 0, 1];
}

/** Height, radii and bore of a part, from config. */
export function partDims(config, part) {
  if (part.kind === 'gear') {
    const teeth = config.GEAR[part.size].teeth, m = config.GEAR.module;
    const pitchR = (teeth * m) / 2;
    return {
      height: config.GEAR.faceWidth, pitchR, tipR: pitchR + m, bodyR: pitchR - (config.PHYSICS.pitchInset ?? 0.0003),
      boreR: config.GEAR.bore / 2, chamfer: config.GEAR.boreChamfer, gripWidth: 2 * (pitchR + m), teeth,
    };
  }
  const a = config.NUT.acrossFlats / 2;
  return { height: config.NUT.height, pitchR: a, tipR: a / Math.cos(Math.PI / 6), bodyR: a, boreR: config.NUT.bore / 2, chamfer: config.NUT.chamfer, gripWidth: 2 * a, teeth: 0 };
}

/** Pose of a part lying at home on the table: { p, quat } of the part body frame (config.FRAMES.part). */
export function homePose(config, part) {
  return { p: [part.home.x, config.TABLE.topY, part.home.z], quat: yawQuat(part.home.yaw) };
}

/** Pose of a part on its seat (assembled). */
export function seatPose(config, part) {
  const sh = config.COVER.shafts[part.seat.shaft];
  const C = coverToWorld(config);
  return { p: xform(C, [sh.x, sh.y, part.seat.z]), quat: yawQuat(config.COVER.world.yaw) };
}

/** World position of the top centre of a shaft. */
export function shaftTop(config, name) {
  const sh = config.COVER.shafts[name];
  return xform(coverToWorld(config), [sh.x, sh.y, sh.top]);
}

/** 2D convex hull (monotone chain) of [[x,y],...], counter-clockwise. */
export function hull2d(pts) {
  const P = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cr = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo = [], up = [];
  for (const p of P) { while (lo.length >= 2 && cr(lo[lo.length - 2], lo[lo.length - 1], p) <= 1e-12) lo.pop(); lo.push(p); }
  for (let i = P.length - 1; i >= 0; i--) { const p = P[i]; while (up.length >= 2 && cr(up[up.length - 2], up[up.length - 1], p) <= 1e-12) up.pop(); up.push(p); }
  lo.pop(); up.pop();
  return lo.concat(up);
}

/** Outline of the cover (cover frame x,y), inflated by `grow`. */
export function coverOutline(config, grow = 0, n = 20) {
  const pts = [];
  for (const c of config.COVER.outline) for (let i = 0; i < n; i++) { const a = (i / n) * 2 * Math.PI; pts.push([c.x + (c.r + grow) * Math.cos(a), (c.r + grow) * Math.sin(a)]); }
  return hull2d(pts);
}

/** Convex wedge k of n around the y axis: cross-section [[r, y], ...] swept between two angles. */
function wedgePoints(section, k, n, rOuterAt) {
  const out = [];
  for (const th of [(k / n) * 2 * Math.PI, ((k + 1) / n) * 2 * Math.PI]) {
    const c = Math.cos(th), s = Math.sin(th);
    for (const [r, y, outer] of section) { const rr = outer && rOuterAt ? rOuterAt(th) : r; out.push(rr * c, y, rr * s); }
  }
  return new Float32Array(out);
}

/** Capsules that approximate the arm, as world segments { a, b, r } from the link frames. */
export function armCapsules(config, linkWorld, flangeWorld) {
  const R = config.ARM_COLLISION?.radii ?? [0.055, 0.045, 0.042, 0.04];
  const o = linkWorld.map(pos);
  const hand = config.ARM_COLLISION?.handLength ?? 0.08;
  return [
    { a: o[1], b: o[2], r: R[0] },                                   // upper arm: joint2 -> joint3
    { a: o[2], b: o[3], r: R[1] },                                   // forearm: joint3 -> joint4
    { a: o[3], b: o[5], r: R[2] },                                   // wrist: joint4 -> joint6
    { a: o[5], b: xform(flangeWorld, [0, 0, hand]), r: R[3] },       // gripper body
  ];
}

function capsulePose(seg) {
  const d = [seg.b[0] - seg.a[0], seg.b[1] - seg.a[1], seg.b[2] - seg.a[2]];
  const len = Math.hypot(d[0], d[1], d[2]) || 1e-9;
  const u = [d[0] / len, d[1] / len, d[2] / len];
  // shortest rotation taking +y to u
  let q;
  if (u[1] < -0.999999) q = [1, 0, 0, 0];
  else { const w = 1 + u[1]; const x = u[2], z = -u[0]; const n = Math.hypot(x, z, w); q = [x / n, 0, z / n, w / n]; }
  return { p: [(seg.a[0] + seg.b[0]) / 2, (seg.a[1] + seg.b[1]) / 2, (seg.a[2] + seg.b[2]) / 2], quat: q, half: len / 2 };
}

// ------------------------------------------------------------------ world

/**
 * Build the physics world. `q0` and `width0` are the initial joint angles and pad opening.
 * Returns an object with step(), setRobot(), partPose(), padContacts(), attach(), detach(), ...
 */
export function createPhysics(config, RAPIER, { q0 = config.ROBOT.home, width0 = config.ROBOT.gripper.strokeMax } = {}) {
  const PH = config.PHYSICS;
  const B = config.ROBOT.baseToWorld;
  const pad = config.ROBOT.gripper.padSize;           // width (x), thickness (y, closing axis), height (z)
  let world = null;
  const parts = new Map();                            // key -> { body, part, dims, colliders: Set(handle) }
  const colliderPart = new Map();                     // collider handle -> part key
  const staticHandles = new Map();                    // collider handle -> 'table' | 'cover'
  let padBodies = [], padColliders = [], palm = null, armBodies = [], armColliders = [];
  let joint = null, held = null;
  let robot = null;                                   // last FK result
  const S = PH.scale ?? 20;                           // physics units per metre
  const O = [config.TABLE.center[0], config.TABLE.topY, config.TABLE.center[1]];   // physics origin (world, m)
  const toP = (a) => ({ x: (a[0] - O[0]) * S, y: (a[1] - O[1]) * S, z: (a[2] - O[2]) * S });
  const fromP = (t) => [t.x / S + O[0], t.y / S + O[1], t.z / S + O[2]];
  const scalePts = (f32) => { for (let i = 0; i < f32.length; i++) f32[i] *= S; return f32; };

  function robotFrames(q, width) {
    const { frames, tcp } = fk(q, B);
    const flange = frames[5];
    const zc = TCP_Z - pad[2] / 2, off = width / 2 + pad[1] / 2;
    const pads = [mul(flange, trans(0, off, zc)), mul(flange, trans(0, -off, zc))];
    return { q: q.slice(), width, links: frames, flange, tcp, pads, capsules: armCapsules(config, frames, flange) };
  }

  function addPart(part) {
    const dims = partDims(config, part);
    const hp = homePose(config, part);
    const body = world.createRigidBody(RAPIER.RigidBodyDesc.dynamic()
      .setTranslation((hp.p[0] - O[0]) * S, (hp.p[1] - O[1]) * S, (hp.p[2] - O[2]) * S).setRotation(Q(hp.quat))
      .setLinearDamping(PH.linearDamping ?? 0.2).setAngularDamping(PH.angularDamping ?? 0.5)
      .setCcdEnabled(!!PH.ccd).setSoftCcdPrediction((PH.softCcd ?? 0.002) * S).setCanSleep(true));
    const rec = { body, part, dims, colliders: new Set(), grip: new Set() };
    const h = dims.height, c = dims.chamfer;
    const nutLike = part.kind !== 'gear';
    const n = nutLike ? 12 : PH.gearSegments;
    const riv = dims.boreR / Math.cos(Math.PI / n);   // inner vertices: the flat inner faces are tangent to the bore
    const section = [[riv + c, 0], [riv, c], [riv, h - c], [riv + c, h], [dims.bodyR, h, 1], [dims.bodyR, 0, 1]];
    const hexR = nutLike ? (th) => { const a = ((th % (Math.PI / 3)) + Math.PI / 3) % (Math.PI / 3) - Math.PI / 6; return dims.pitchR / Math.cos(a); } : null;
    const member = nutLike ? (G.PART | G.GRIP) : G.PART;
    const filter = nutLike ? (G.STATIC | G.PART | G.ARM | G.PAD) : (G.STATIC | G.PART | G.ARM);
    for (let k = 0; k < n; k++) {
      const desc = RAPIER.ColliderDesc.convexHull(scalePts(wedgePoints(section, k, n, hexR)));
      if (!desc) throw new Error(`convex hull failed for ${part.key} wedge ${k}`);
      desc.setDensity(PH.density.plastic).setFriction(PH.friction.part).setRestitution(0).setCollisionGroups(groups(member, filter));
      const col = world.createCollider(desc, body);
      rec.colliders.add(col.handle); colliderPart.set(col.handle, part.key);
      if (nutLike) rec.grip.add(col.handle);
    }
    if (!nutLike) {
      // pad-only cylinder at the tooth-tip radius (no mass)
      const desc = RAPIER.ColliderDesc.cylinder((h / 2) * S, dims.tipR * S).setTranslation(0, (h / 2) * S, 0)
        .setDensity(0).setFriction(PH.friction.part).setRestitution(0).setCollisionGroups(groups(G.GRIP, G.PAD));
      const col = world.createCollider(desc, body);
      rec.grip.add(col.handle); colliderPart.set(col.handle, part.key);
    }
    parts.set(part.key, rec);
  }

  function build() {
    if (world) world.free();
    parts.clear(); colliderPart.clear(); staticHandles.clear();
    padBodies = []; padColliders = []; armBodies = []; armColliders = []; joint = null; held = null;
    world = new RAPIER.World({ x: PH.gravity[0] * S, y: PH.gravity[1] * S, z: PH.gravity[2] * S });
    world.timestep = PH.dt;
    world.lengthUnit = PH.lengthUnit ?? 1;
    world.numSolverIterations = PH.solverIterations ?? 8;
    if (PH.pgsIterations) world.numInternalPgsIterations = PH.pgsIterations;
    const ip = world.integrationParameters;
    if (PH.allowedLinearError != null) ip.normalizedAllowedLinearError = (PH.allowedLinearError * S) / world.lengthUnit;
    if (PH.predictionDistance != null) ip.normalizedPredictionDistance = (PH.predictionDistance * S) / world.lengthUnit;

    const statG = groups(G.STATIC, G.PART);
    // table
    const T = config.TABLE;
    const tb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, (-T.size[1] / 2) * S, 0));
    staticHandles.set(world.createCollider(RAPIER.ColliderDesc.cuboid((T.size[0] / 2) * S, (T.size[1] / 2) * S, (T.size[2] / 2) * S)
      .setFriction(PH.friction.table).setRestitution(0).setCollisionGroups(statG), tb).handle, 'table');

    // cover: floor, wall, bosses, shafts. Body frame: origin at the cover origin, y up, local (x, y, z) = cover (x, z, -y).
    const Cv = config.COVER;
    const cb = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(...Object.values(toP(Cv.world.position))).setRotation(Q(yawQuat(Cv.world.yaw))));
    const addCover = (desc, fr = PH.friction.table) => staticHandles.set(world.createCollider(desc.setFriction(fr).setRestitution(0).setCollisionGroups(statG), cb).handle, 'cover');
    const outer = coverOutline(config, Cv.wall), inner = coverOutline(config, 0);
    const fl = [];
    for (const [x, y] of outer) fl.push(x, 0, -y, x, Cv.floor, -y);
    addCover(RAPIER.ColliderDesc.convexHull(scalePts(new Float32Array(fl))));
    for (let i = 0; i < inner.length; i++) {
      const a = inner[i], b = inner[(i + 1) % inner.length];
      const ex = b[0] - a[0], ey = b[1] - a[1], el = Math.hypot(ex, ey) || 1;
      const nx = (ey / el) * Cv.wall, ny = (-ex / el) * Cv.wall;   // outward normal of a CCW polygon
      const w = [];
      for (const [x, y] of [a, b, [a[0] + nx, a[1] + ny], [b[0] + nx, b[1] + ny]]) w.push(x, Cv.floor, -y, x, Cv.wallHeight, -y);
      const d = RAPIER.ColliderDesc.convexHull(scalePts(new Float32Array(w)));
      if (d) addCover(d);
    }
    for (const sh of Object.values(Cv.shafts)) {
      addCover(RAPIER.ColliderDesc.cylinder((Cv.bossHeight / 2) * S, (Cv.bossDiameter / 2) * S).setTranslation(sh.x * S, (Cv.floor + Cv.bossHeight / 2) * S, -sh.y * S));
      // One round cylinder per shaft: radius r with the top edge rounded by the chamfer size. Parry treats round
      // shapes analytically (core + margin); a polyhedral chamfer cone gave tilted, sticky manifolds against the wedges.
      const r = Cv.shaftDiameter / 2, c = Cv.shaftChamfer, mode = PH.shaftShape ?? 'round';
      if (mode === 'round') {
        addCover(RAPIER.ColliderDesc.roundCylinder((sh.top / 2 - c) * S, (r - c) * S, c * S).setTranslation(sh.x * S, (sh.top / 2) * S, -sh.y * S), PH.friction.shaft ?? 0.2);
      } else {
        const y0 = Cv.floor, y1 = sh.top - c;
        addCover(RAPIER.ColliderDesc.cylinder(((y1 - y0) / 2) * S, r * S).setTranslation(sh.x * S, ((y0 + y1) / 2) * S, -sh.y * S), PH.friction.shaft ?? 0.2);
        addCover(RAPIER.ColliderDesc.cone((r / 2) * S, r * S).setTranslation(sh.x * S, (y1 + r / 2) * S, -sh.y * S), PH.friction.shaft ?? 0.2);
      }
    }

    for (const part of config.PARTS) addPart(part);

    // robot: two pads, palm (joint anchor), arm capsules. All kinematic, position based.
    robot = robotFrames(q0, width0);
    const kin = (M) => world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...Object.values(toP(pos(M)))).setRotation(Q(quatOf(M))));
    for (let i = 0; i < 2; i++) {
      const b = kin(robot.pads[i]);
      const col = world.createCollider(RAPIER.ColliderDesc.cuboid((pad[0] / 2) * S, (pad[1] / 2) * S, (pad[2] / 2) * S)
        .setFriction(PH.friction.pad).setRestitution(0).setCollisionGroups(groups(G.PAD, G.GRIP)), b);
      padBodies.push(b); padColliders.push(col);
    }
    palm = kin(robot.flange);
    for (const seg of robot.capsules) {
      const cp = capsulePose(seg);
      const b = world.createRigidBody(RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(...Object.values(toP(cp.p))).setRotation(Q(cp.quat)));
      const col = world.createCollider(RAPIER.ColliderDesc.capsule(cp.half * S, seg.r * S).setFriction(0.4).setRestitution(0).setCollisionGroups(groups(G.ARM, G.PART)), b);
      armBodies.push(b); armColliders.push(col);
    }
    world.step();
  }

  /** Command the kinematic robot for the next step. */
  function setRobot(q, width) {
    robot = robotFrames(q, width);
    for (let i = 0; i < 2; i++) {
      padBodies[i].setNextKinematicTranslation(toP(pos(robot.pads[i])));
      padBodies[i].setNextKinematicRotation(Q(quatOf(robot.pads[i])));
    }
    palm.setNextKinematicTranslation(toP(pos(robot.flange)));
    palm.setNextKinematicRotation(Q(quatOf(robot.flange)));
    for (let i = 0; i < armBodies.length; i++) {
      const cp = capsulePose(robot.capsules[i]);
      armBodies[i].setNextKinematicTranslation(toP(cp.p));
      armBodies[i].setNextKinematicRotation(Q(cp.quat));
    }
    return robot;
  }

  function partPose(key) {
    const b = parts.get(key).body, t = b.translation(), r = b.rotation();
    return { p: fromP(t), quat: [r.x, r.y, r.z, r.w] };
  }
  function partSpeed(key) {
    const b = parts.get(key).body, v = b.linvel(), w = b.angvel();
    return { lin: Math.hypot(v.x, v.y, v.z) / S, ang: Math.hypot(w.x, w.y, w.z), sleeping: b.isSleeping() };
  }
  function setPartPose(key, p, quat) {
    const b = parts.get(key).body;
    b.setTranslation(toP(p), true); b.setRotation(Q(quat), true);
    b.setLinvel({ x: 0, y: 0, z: 0 }, true); b.setAngvel({ x: 0, y: 0, z: 0 }, true);
  }

  /**
   * Contacts of each pad with parts. Returns [c0, c1]; each is a list of
   * { key, normal:[x,y,z] (world, pointing from the pad into the part), dist (m, <0 = penetration), point:[x,y,z] }.
   */
  function padContacts(maxDist = PH.contactDist ?? 0.0002) {
    const out = [[], []];
    for (let i = 0; i < 2; i++) {
      const pc = padColliders[i];
      const others = [];
      world.contactPairsWith(pc, (o) => others.push(o));
      for (const o of others) {
        const key = colliderPart.get(o.handle);
        if (!key) continue;
        world.contactPair(pc, o, (m, flipped) => {
          const n = m.numContacts();
          if (!n) return;
          let dmin = Infinity, px = 0, py = 0, pz = 0, cnt = 0;
          for (let k = 0; k < n; k++) {
            const d = m.contactDist(k) / S;
            if (d < dmin) dmin = d;
            const lp = flipped ? m.localContactPoint2(k) : m.localContactPoint1(k);
            if (lp) { px += lp.x; py += lp.y; pz += lp.z; cnt++; }
          }
          if (dmin > maxDist) return;
          const nv = m.normal();
          const s = flipped ? -1 : 1;
          const point = cnt ? xform(robot.pads[i], [px / cnt / S, py / cnt / S, pz / cnt / S]) : pos(robot.pads[i]);
          out[i].push({ key, normal: [s * nv.x, s * nv.y, s * nv.z], dist: dmin, point });
        });
      }
    }
    return out;
  }

  /**
   * Grasp test (docs/lab.md section 4): both pads touch the same part and the two contact normals are
   * at least PHYSICS.graspOpposeAngle apart. Returns { key, angle, contacts } or null.
   */
  function graspCandidate() {
    const [c0, c1] = padContacts();
    let best = null;
    for (const a of c0) for (const b of c1) {
      if (a.key !== b.key) continue;
      const d = a.normal[0] * b.normal[0] + a.normal[1] * b.normal[1] + a.normal[2] * b.normal[2];
      const angle = Math.acos(Math.max(-1, Math.min(1, d)));
      if (angle >= PH.graspOpposeAngle && (!best || angle > best.angle)) best = { key: a.key, angle, contacts: [a, b] };
    }
    return { best, touching: [c0.length > 0, c1.length > 0], contacts: [c0, c1] };
  }

  function attach(key) {
    if (joint) detach();
    const rec = parts.get(key);
    const P = matOf(...Object.values(partPose(key)));
    const rel = mul(invRigid(robot.flange), P);       // part pose in the palm frame
    const rp = pos(rel);
    const jd = RAPIER.JointData.fixed({ x: rp[0] * S, y: rp[1] * S, z: rp[2] * S }, Q(quatOf(rel)), { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0, w: 1 });
    joint = world.createImpulseJoint(jd, palm, rec.body, true);
    held = key;
    return rel;
  }
  function detach() {
    if (joint) { world.removeImpulseJoint(joint, true); joint = null; }
    const k = held; held = null;
    return k;
  }

  /** True when the held part touches anything other than the pads (table, cover, shafts, other parts, arm). */
  function heldTouching(maxDist = 0) {
    const d = heldDeepest();
    return d !== null && d.dist <= maxDist;
  }
  /** Deepest contact of the held part with anything but the pads: { dist (m, negative = penetration), other } or null. */
  function heldDeepest() {
    if (!held) return null;
    const rec = parts.get(held);
    let best = null;
    for (const h of rec.colliders) {
      const col = world.getCollider(h);
      const others = [];
      world.contactPairsWith(col, (o) => others.push(o));
      for (const o of others) {
        if (rec.colliders.has(o.handle) || o.handle === padColliders[0].handle || o.handle === padColliders[1].handle) continue;
        world.contactPair(col, o, (m) => {
          for (let k = 0; k < m.numContacts(); k++) {
            const d = m.contactDist(k) / S;
            if (!best || d < best.dist) best = { dist: d, other: colliderPart.get(o.handle) ?? staticHandles.get(o.handle) ?? 'arm' };
          }
        });
      }
    }
    return best;
  }

  /**
   * Tiny ray-cast depth camera used by Node tests in place of the WebGL capture.
   * Returns the same shape as rig.capture(): { depth: Float32Array (m along the optical axis, 0 = no hit),
   * id: Uint8Array (config.IDS), K, camToWorld, width, height }. No rgb.
   */
  function renderDepthId({ camToWorld, K, width, height, far = config.CAMERA.far }) {
    const depth = new Float32Array(width * height), id = new Uint8Array(width * height);
    const fx = K[0], fy = K[4], cx = K[2], cy = K[5];
    const o = toP(pos(camToWorld));
    const fg = groups(0xffff, G.STATIC | G.PART | G.PAD | G.ARM);
    const ray = new RAPIER.Ray(o, { x: 0, y: 0, z: 1 });
    for (let v = 0; v < height; v++) for (let u = 0; u < width; u++) {
      const dx = (u - cx) / fx, dy = (v - cy) / fy;
      ray.dir.x = camToWorld[0] * dx + camToWorld[1] * dy + camToWorld[2];
      ray.dir.y = camToWorld[4] * dx + camToWorld[5] * dy + camToWorld[6];
      ray.dir.z = camToWorld[8] * dx + camToWorld[9] * dy + camToWorld[10];
      const hit = world.castRay(ray, far * S, true, undefined, fg);
      if (!hit) continue;
      const i = v * width + u;
      depth[i] = hit.timeOfImpact / S;                   // dir has unit z in the camera frame, so toi is the depth along the axis
      const h = hit.collider.handle;
      const key = colliderPart.get(h);
      id[i] = key ? config.IDS[key] : (staticHandles.get(h) === 'cover' ? config.IDS.cover : (staticHandles.get(h) === 'table' ? config.IDS.table : config.IDS.robot));
    }
    return { depth, id, K: Array.from(K), camToWorld: Array.from(camToWorld), width, height };
  }

  build();
  return {
    RAPIER,
    get world() { return world; },
    get robot() { return robot; },
    get holding() { return held; },
    parts,
    rebuild: build,
    step() { world.step(); },
    scale: S,
    setRobot, robotFrames,
    partPose, partSpeed, setPartPose,
    padContacts, graspCandidate, attach, detach, heldTouching, heldDeepest,
    renderDepthId,
    dispose() { if (world) { world.free(); world = null; } },
  };
}
