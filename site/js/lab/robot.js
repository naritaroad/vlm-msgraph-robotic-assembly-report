// xArm6 + xArm Gripper (meshes from xarm_ros, BSD-3), wrist camera and mobile base (both our own simplified models).
// The joint tree is built from kinematics.js (JOINTS, TCP_Z), so rig.robot.getTcpMatrix() equals fk(q, baseToWorld).tcp.
// Gripper joint origins and axes: xarm_ros/xarm_description/urdf/gripper/xarm_gripper.urdf.xacro
//   drive_joint               base -> left_outer_knuckle   xyz (0,  0.035,    0.059098)  axis +x
//   left_finger_joint         left_outer -> left_finger    xyz (0,  0.035465, 0.042039)  axis -x  (mimic)
//   left_inner_knuckle_joint  base -> left_inner_knuckle   xyz (0,  0.02,     0.074098)  axis +x  (mimic)
//   right_* are the mirror image in y with the axes negated.
// Everything under `root` is in the ROS base frame (z up); `root.matrix` is ROBOT.baseToWorld.

import * as THREE from 'three';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { JOINTS, TCP_Z, mul, trans, rpy } from './kinematics.js';
import { creaseNormals, latheClosed } from './parts.js';
import { Batch, rbox } from './world.js';

const ASSETS = new URL('../../assets/robot/', import.meta.url);

const GRIP = {
  outer: [0, 0.035, 0.059098],
  finger: [0, 0.035465, 0.042039],
  inner: [0, 0.02, 0.074098],
  padZ: [0.0223, 0.0598],          // extent of the flat pad face along the finger (measured on left_finger.stl)
  driveMax: 0.85,                  // URDF limit; the pads touch at about 0.865 rad
};

// Seam between each link and its parent: plane z (in the child link frame) and radius, measured on the STL files.
const SEAMS = [[-0.112, 0.0476], [0.0755, 0.0476], [0.0677, 0.0423], [-0.173, 0.0423], [-0.0045, 0.0375], [-0.028, 0.037]];

const toThree = (m, out = new THREE.Matrix4()) => out.set(m[0], m[1], m[2], m[3], m[4], m[5], m[6], m[7], m[8], m[9], m[10], m[11], m[12], m[13], m[14], m[15]);
const toRows = (M) => { const e = M.elements; return [e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14], e[3], e[7], e[11], e[15]]; };

async function loadLink(loader, file) {
  const raw = await loader.loadAsync(new URL(file, ASSETS).href);
  raw.deleteAttribute('normal');
  // weld + crease at 40 degrees (own implementation: three's toCreasedNormals quantises to 1 cm in metre units)
  let g = creaseNormals(raw, (40 * Math.PI) / 180, 1e-5);
  g = mergeVertices(g, 1e-6);
  g.computeBoundingBox(); g.computeBoundingSphere();
  return g;
}

function fixedGroup(m16, name) {
  const g = new THREE.Group();
  g.name = name; g.matrixAutoUpdate = false; toThree(m16, g.matrix);
  return g;
}

function ringGeometry(r, half = 0.0026) {
  const o = r + 0.0007, c = 0.0006;
  const g = creaseNormals(latheClosed([[r - 0.003, -half], [o - c, -half], [o, -half + c], [o, half - c], [o - c, half], [r - 0.003, half]], 56), (30 * Math.PI) / 180, 1e-6);
  g.rotateX(Math.PI / 2);          // lathe axis y -> joint axis z
  return g;
}

/** GL projection for pinhole intrinsics. Pixel centres sit on integer (u, v), so K applies to pixel indices as they are. */
export function projectionFromK({ fx, fy, cx, cy, width, height, near, far }, out = new THREE.Matrix4()) {
  const gx = cx + 0.5, gy = cy + 0.5;
  return out.set(
    (2 * fx) / width, 0, 1 - (2 * gx) / width, 0,
    0, (2 * fy) / height, (2 * gy) / height - 1, 0,
    0, 0, -(far + near) / (far - near), (-2 * far * near) / (far - near),
    0, 0, -1, 0);
}

function buildWristCamera(config, lib) {
  const C = config.CAMERA;
  const frame = fixedGroup(mul(trans(...C.mount.xyz), rpy(...C.mount.rpy)), 'camera_optical');   // x right, y down, z forward
  const cam = new THREE.PerspectiveCamera(60, C.width / C.height, C.near, C.far);
  cam.name = 'wristCamera';
  cam.rotation.x = Math.PI;                              // three cameras look down -z with y up
  cam.updateMatrix();
  const intr = { fx: C.fx, fy: C.fy, cx: C.cx, cy: C.cy, width: C.width, height: C.height, near: C.near, far: C.far };
  const apply = () => {
    projectionFromK(intr, cam.projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    cam.userData.fovY = THREE.MathUtils.radToDeg(2 * Math.atan(intr.height / 2 / intr.fy));
    cam.fov = cam.userData.fovY; cam.aspect = intr.width / intr.height; cam.near = intr.near; cam.far = intr.far;
    cam.userData.intrinsics = { ...intr };
  };
  cam.userData.setIntrinsics = (o = {}) => { Object.assign(intr, o); apply(); };
  cam.updateProjectionMatrix = apply;                    // keep three from overwriting the pinhole projection
  apply();
  frame.add(cam);

  // body: long side along optical x, lenses on the +z face. The optical origin is the RGB lens.
  const [bw, bh, bd] = C.body;
  const body = new THREE.Group();
  body.name = 'camera_body';
  const off = -0.012;                                    // the RGB lens is not in the middle of the bar
  const b = new Batch();
  b.box(lib.aluminium, bw, bh, bd - 0.002, off, 0, -bd / 2 - 0.001, { r: 0.0085, seg: 3 });
  b.box(lib.lensGlass, bw - 0.014, bh - 0.009, 0.0016, off, 0, -0.0012, { r: 0.0007, seg: 1 });
  const lens = (x, r) => {
    b.add(lib.gripperBlack, new THREE.CylinderGeometry(r + 0.0016, r + 0.0016, 0.0022, 28).rotateX(Math.PI / 2), { pos: [x, 0, -0.0002] });
    b.add(lib.lensGlass, new THREE.SphereGeometry(r * 1.6, 20, 10, 0, Math.PI * 2, 0, 0.675).rotateX(Math.PI / 2).translate(0, 0, -r * 1.6 * Math.cos(0.675)), { pos: [x, 0, 0.0009] });
  };
  lens(off - 0.0475, 0.0046); lens(off + 0.0475, 0.0046); lens(0, 0.0052);
  b.add(lib.gripperBlack, new THREE.CylinderGeometry(0.003, 0.003, 0.002, 16).rotateX(Math.PI / 2), { pos: [off + 0.022, 0, -0.0002] });
  // bracket between the gripper body and the camera (camera -y is gripper +x... the gripper lies on the +y side here)
  b.box(lib.gripperBody, 0.062, 0.022, 0.02, off * 0.3, bh / 2 + 0.0105, -bd / 2 - 0.002, { r: 0.003 });
  b.box(lib.gripperBody, 0.07, 0.004, bd + 0.004, off * 0.3, bh / 2 + 0.002, -bd / 2 - 0.001, { r: 0.0015 });
  // USB socket and a short strain relief on the short side
  b.box(lib.gripperBlack, 0.014, 0.011, 0.016, off - bw / 2 - 0.006, 0, -bd / 2, { r: 0.003 });
  b.build(body, { name: 'camera_body' });
  frame.add(body);
  return { frame, cam, body, intr };
}

function buildMobileBase(config, lib, L) {
  const g = new THREE.Group();
  g.name = 'mobileBase';
  const mb = L.mobileBase, [len, hgt, wid] = mb.size, cx = mb.center[0], cz = mb.center[2];
  const b = new Batch();
  const wr = 0.092, ww = 0.072, wx = len / 2 - 0.115, wz = wid / 2 - ww / 2 - 0.006;
  // tyre profile (lathe about y, then laid on its side)
  const tyre = () => {
    const c = 0.014, pr = [[wr * 0.6, -ww / 2]];
    for (let i = 0; i <= 4; i++) { const a = -Math.PI / 2 + (i / 4) * (Math.PI / 2); pr.push([wr - c + c * Math.cos(a), -ww / 2 + c + c * Math.sin(a)]); }
    for (let i = 0; i <= 4; i++) { const a = (i / 4) * (Math.PI / 2); pr.push([wr - c + c * Math.cos(a), ww / 2 - c + c * Math.sin(a)]); }
    pr.push([wr * 0.6, ww / 2]);
    return creaseNormals(latheClosed(pr, 40), (35 * Math.PI) / 180, 1e-6).rotateX(Math.PI / 2);
  };
  const hubCap = () => creaseNormals(latheClosed([[0, -ww / 2 - 0.002], [wr * 0.58, -ww / 2 - 0.002], [wr * 0.62, -ww / 2 + 0.006], [wr * 0.62, ww / 2 - 0.006], [wr * 0.58, ww / 2 + 0.002], [0, ww / 2 + 0.002]], 32), (35 * Math.PI) / 180, 1e-6).rotateX(Math.PI / 2);
  const fender = (sx) => {
    // arc band over the wheel, open toward the ground
    const s = new THREE.Shape();
    const r0 = wr + 0.012, r1 = wr + 0.024, a0 = -0.35, a1 = Math.PI + 0.35;
    s.absarc(0, 0, r1, a0, a1, false); s.absarc(0, 0, r0, a1, a0, true); s.closePath();
    const e = new THREE.ExtrudeGeometry(s, { depth: ww + 0.016, bevelEnabled: true, bevelSize: 0.003, bevelThickness: 0.003, bevelOffset: -0.003, bevelSegments: 2, curveSegments: 28 });
    e.translate(0, 0, -(ww + 0.016) / 2);
    void sx;
    return e;
  };
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    const p = [cx + sx * wx, wr, cz + sz * wz];
    b.add(lib.tyre, tyre(), { pos: p });
    b.add(lib.chassisLight, hubCap(), { pos: p });
    b.add(lib.chassis, fender(sx), { pos: p });
    // steering column from the fender up into the deck
    b.cyl(lib.chassis, 0.03, hgt - 0.03 - (2 * wr + 0.02), p[0], (hgt - 0.03 + 2 * wr + 0.02) / 2, p[2], { seg: 20 });
  }
  const deckT = 0.05, deckY = hgt - 0.006 - deckT / 2;
  b.box(lib.chassis, len - 2 * (len / 2 - wx) - 2 * wr - 0.05, hgt - 0.12, wid - 0.02, cx, 0.07 + (hgt - 0.12) / 2, cz, { r: 0.03, seg: 3 });   // centre body between the wheel pairs
  b.box(lib.chassis, len, deckT, wid, cx, deckY, cz, { r: 0.02, seg: 3 });                                                                   // deck over the wheels
  b.box(lib.treadPlate, len - 0.07, 0.006, wid - 0.07, cx, hgt - 0.003, cz, { r: 0.0025, seg: 1, tile: lib.tiles.metal });                                       // top cover plate
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(lib.gripperBlack, 0.006, 0.003, cx + sx * (len / 2 - 0.06), hgt + 0.001, cz + sz * (wid / 2 - 0.06), { seg: 12 });
  // bumpers
  for (const sx of [-1, 1]) b.box(lib.rubber, 0.018, 0.03, wid - 0.16, cx + sx * (len / 2 + 0.004), deckY - 0.004, cz, { r: 0.008, seg: 2 });
  // riser and mounting plate under the arm
  const bx = config.ROBOT.basePosition[0], bz = config.ROBOT.basePosition[2], topY = mb.topY;
  b.box(lib.chassis, 0.17, topY - hgt - 0.012, 0.17, bx, hgt + (topY - hgt - 0.012) / 2, bz, { r: 0.012, seg: 2 });
  b.box(lib.chassisLight, 0.2, 0.012, 0.2, bx, topY - 0.006, bz, { r: 0.004, seg: 2 });
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) b.cyl(lib.gripperBlack, 0.0055, 0.004, bx + sx * 0.085, topY + 0.001, bz + sz * 0.085, { seg: 12 });
  // control box at the rear of the deck
  const kx = cx + len / 2 - 0.2;
  b.box(lib.chassis, 0.2, 0.1, 0.26, kx, hgt + 0.05, cz, { r: 0.01, seg: 2 });
  b.box(lib.chassisLight, 0.003, 0.05, 0.16, kx - 0.1005, hgt + 0.052, cz, { r: 0.001 });
  // emergency stop on the deck
  const ex = cx - len / 2 + 0.07, ez = cz + wid / 2 - 0.075;
  b.cyl(lib.estopYellow, 0.034, 0.014, ex, hgt + 0.007, ez, { seg: 28 });
  b.cyl(lib.gripperBlack, 0.014, 0.014, ex, hgt + 0.021, ez, { seg: 16 });
  b.add(lib.estopRed, creaseNormals(latheClosed([[0, 0.016], [0.012, 0.0155], [0.02, 0.012], [0.0235, 0.006], [0.0235, 0.002], [0.021, 0], [0, 0]], 28), 0.7, 1e-6), { pos: [ex, hgt + 0.027, ez] });
  b.build(g, { name: 'mobile-base' });
  // status light strips (emissive, picked up by bloom)
  const strips = [];
  const strip = (w, d, x, z, mat) => { const m = new THREE.Mesh(rbox(w, 0.01, d, 0.003, 1), mat); m.position.set(x, deckY + 0.002, z); g.add(m); strips.push(m); };
  const ready = lib.led(0x2ee6a6, 5.5), white = lib.led(0xdfeaff, 5), redL = lib.led(0xff2a1a, 4.5);
  for (const sz of [-1, 1]) strip(len - 0.3, 0.004, cx, cz + sz * (wid / 2 + 0.0005), ready);
  for (const sz of [-1, 1]) strip(0.004, 0.07, cx - len / 2 - 0.0135, cz + sz * (wid / 2 - 0.05), white);
  for (const sz of [-1, 1]) strip(0.004, 0.07, cx + len / 2 + 0.0135, cz + sz * (wid / 2 - 0.05), redL);
  const boxLed = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, 0.002, 12).rotateZ(Math.PI / 2), ready);
  boxLed.position.set(kx - 0.1025, hgt + 0.088, cz + 0.105); g.add(boxLed);
  return { group: g, strips, materials: { ready } };
}

export async function createRobot(config, lib, L) {
  const R = config.ROBOT;
  const loader = new STLLoader();
  const files = ['xarm6/link_base.stl', ...[1, 2, 3, 4, 5, 6].map((i) => `xarm6/link${i}.stl`),
    'gripper/base_link.stl', 'gripper/left_outer_knuckle.stl', 'gripper/left_finger.stl', 'gripper/left_inner_knuckle.stl',
    'gripper/right_outer_knuckle.stl', 'gripper/right_finger.stl', 'gripper/right_inner_knuckle.stl'];
  const geos = await Promise.all(files.map((f) => loadLink(loader, f)));
  const G = Object.fromEntries(files.map((f, i) => [f.split('/')[1].replace('.stl', '') + (f.startsWith('gripper') ? '' : ''), geos[i]]));

  const group = new THREE.Group();
  group.name = 'robot';
  group.userData.captureId = config.IDS?.robot ?? 7;
  const root = fixedGroup(R.baseToWorld, 'robot_base');
  group.add(root);
  const mesh = (geo, mat, name) => { const m = new THREE.Mesh(geo, mat); m.name = name; m.castShadow = true; m.receiveShadow = true; return m; };
  const links = {};
  links.link_base = root;
  root.add(mesh(G.link_base, lib.armDark, 'link_base'));

  // arm chain
  const joints = [];
  let parent = root;
  const linkMat = [lib.armWhite, lib.armWhite, lib.armWhite, lib.armWhite, lib.armWhite, lib.aluminium];
  for (let i = 0; i < 6; i++) {
    const origin = fixedGroup(mul(trans(...JOINTS[i].xyz), rpy(...JOINTS[i].rpy)), `joint${i + 1}_origin`);
    const j = new THREE.Group();
    j.name = `link${i + 1}`;
    origin.add(j); parent.add(origin);
    j.add(mesh(G[`link${i + 1}`], linkMat[i], `link${i + 1}`));
    const ring = mesh(ringGeometry(SEAMS[i][1]), lib.armRing, `seam${i + 1}`);
    ring.position.z = SEAMS[i][0];
    j.add(ring);
    joints.push(j); links[`link${i + 1}`] = j; parent = j;
  }
  const flange = joints[5];

  // gripper
  const gripper = new THREE.Group();
  gripper.name = 'gripper_base';
  flange.add(gripper);
  gripper.add(mesh(G.base_link, lib.gripperBody, 'gripper_base'));
  links.gripper_base = gripper;
  const padInner = -G.left_finger.boundingBox.min.y;                 // inner (contact) face of the finger, in its own frame
  const padT = R.gripper.padSize[1], padZc = (GRIP.padZ[0] + GRIP.padZ[1]) / 2;
  const side = (sgn, prefix) => {
    const outerO = new THREE.Group(); outerO.position.set(0, sgn * GRIP.outer[1], GRIP.outer[2]);
    const outer = new THREE.Group(); outerO.add(outer); gripper.add(outerO);
    outer.add(mesh(G[`${prefix}_outer_knuckle`], lib.aluminium, `${prefix}_outer_knuckle`));
    const fingerO = new THREE.Group(); fingerO.position.set(0, sgn * GRIP.finger[1], GRIP.finger[2]);
    const finger = new THREE.Group(); fingerO.add(finger); outer.add(fingerO);
    finger.add(mesh(G[`${prefix}_finger`], lib.gripperBlack, `${prefix}_finger`));
    const innerO = new THREE.Group(); innerO.position.set(0, sgn * GRIP.inner[1], GRIP.inner[2]);
    const inner = new THREE.Group(); innerO.add(inner); gripper.add(innerO);
    inner.add(mesh(G[`${prefix}_inner_knuckle`], lib.aluminium, `${prefix}_inner_knuckle`));
    const pad = new THREE.Object3D(); pad.name = `${prefix}_pad`;
    pad.position.set(0, -sgn * (padInner - padT / 2), padZc);          // centre of the pad box; contact face at y = -sgn * padT/2
    finger.add(pad);
    links[`${prefix}_outer_knuckle`] = outer; links[`${prefix}_finger`] = finger; links[`${prefix}_inner_knuckle`] = inner;
    return { outer, finger, inner, pad, sgn };
  };
  const left = side(1, 'left'), right = side(-1, 'right');
  const tcp = new THREE.Object3D(); tcp.name = 'tcp'; tcp.position.z = TCP_Z; gripper.add(tcp);

  // wrist camera on the gripper base
  const wc = buildWristCamera(config, lib);
  gripper.add(wc.frame);
  links.camera_body = wc.frame;

  // mobile base (world frame, static)
  const base = buildMobileBase(config, lib, L);
  group.add(base.group);

  const state = { q: [0, 0, 0, 0, 0, 0], width: R.gripper.strokeMax, drive: 0 };
  const Rl = Math.hypot(GRIP.finger[1], GRIP.finger[2]), phi = Math.atan2(GRIP.finger[2], GRIP.finger[1]);
  const widthMax = 2 * (GRIP.outer[1] + GRIP.finger[1] - padInner);
  const driveClosed = Math.acos((padInner - GRIP.outer[1]) / Rl) - phi;

  function setJoints(q) {
    for (let i = 0; i < 6; i++) { state.q[i] = q[i]; joints[i].rotation.z = q[i]; }
    dirty = true;
  }
  /** Opening between the two pad faces in metres. The linkage angle is solved from the real four-bar geometry. */
  function setGripper(width) {
    const w = Math.min(Math.max(0, width), Math.min(R.gripper.strokeMax, widthMax));
    const th = Math.min(driveClosed, Math.max(0, Math.acos(Math.min(1, Math.max(-1, (w / 2 + padInner - GRIP.outer[1]) / Rl))) - phi));
    state.width = w; state.drive = th;
    for (const s of [left, right]) {
      s.outer.rotation.x = s.sgn * th; s.inner.rotation.x = s.sgn * th; s.finger.rotation.x = -s.sgn * th;
    }
    dirty = true;
  }
  let dirty = true;
  const sync = () => { if (dirty) { root.updateMatrixWorld(true); dirty = false; } };
  const rowsOf = (o) => { sync(); return toRows(o.matrixWorld); };
  const _m = new THREE.Matrix4(), _flip = new THREE.Matrix4().makeRotationX(Math.PI);

  setJoints(R.home); setGripper(R.gripper.strokeMax);

  return {
    group, root, joints, gripper, tcp, links, mobileBase: base,
    wristCamera: wc.cam, cameraFrame: wc.frame,
    setJoints, setGripper,
    getJoints: () => state.q.slice(),
    getGripper: () => ({ width: state.width, drive: state.drive, widthMax, driveClosed }),
    getTcpMatrix: () => rowsOf(tcp),
    /** Pad frames: origin at the centre of the pad box, axes parallel to the gripper base (x width, y closing, z along the finger). */
    getPadMatrices: () => ({ left: rowsOf(left.pad), right: rowsOf(right.pad) }),
    getLinkMatrices() { sync(); const o = {}; for (const [k, v] of Object.entries(links)) o[k] = toRows(v.matrixWorld); o.tcp = toRows(tcp.matrixWorld); return o; },
    /** Local axis-aligned bounds of each link mesh (link frame, metres): useful for sizing colliders. */
    getLinkBounds() {
      const o = {};
      for (const [k, v] of Object.entries(links)) {
        const m = v.children.find((c) => c.isMesh && c.name === k);
        if (m) o[k] = { min: m.geometry.boundingBox.min.toArray(), max: m.geometry.boundingBox.max.toArray() };
      }
      return o;
    },
    /** Optical frame (x right, y down, z forward) to world, row-major. */
    getCameraMatrix: () => { sync(); wc.cam.updateWorldMatrix(false, false); return toRows(_m.copy(wc.cam.matrixWorld).multiply(_flip)); },
    setIntrinsics: (o) => wc.cam.userData.setIntrinsics(o),
    getIntrinsics: () => ({ ...wc.cam.userData.intrinsics }),
    sync,
    triangles: geos.reduce((s, g) => s + (g.index ? g.index.count : g.attributes.position.count) / 3, 0),
  };
}
