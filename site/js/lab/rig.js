// buildRig(): the picture layer of the lab. It owns three.js; the simulation layer drives it through this interface
// (docs/lab.md section 3). Lengths in metres, angles in radians, matrices row-major arrays of 16,
// quaternions [x, y, z, w], part frames as in config.FRAMES (bottom-face centre, +y along the bore).

import * as THREE from 'three';
import { createWorld, QUALITY } from './world.js';
import { createParts, poseFor, checkAssembly, gearBody } from './parts.js';
import { createRobot } from './robot.js';
import { createOverlays } from './overlays.js';
import { createCapture, projectPoint, backProject } from './capture.js';
import * as kin from './kinematics.js';

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

function idleScreenTexture(config) {
  const c = document.createElement('canvas'); c.width = 1024; c.height = 576;
  const g = c.getContext('2d');
  g.fillStyle = '#0D1014'; g.fillRect(0, 0, 1024, 576);
  g.fillStyle = '#151A20'; g.fillRect(0, 0, 1024, 44);
  g.fillStyle = '#2B343E'; g.fillRect(0, 44, 1024, 2);
  g.font = '600 20px "Cascadia Mono", Consolas, monospace'; g.fillStyle = '#E6EAEE'; g.textBaseline = 'middle';
  g.fillText('wrist camera', 20, 23);
  g.fillStyle = '#8C97A3'; g.fillText(`RGB ${config.CAMERA.width}x${config.CAMERA.height}   fx ${config.CAMERA.fx}   Demo`, 200, 23);
  g.fillStyle = '#FFB454'; g.fillRect(990, 16, 12, 12);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export async function buildRig(container, config, { quality = 'auto', reducedMotion = false } = {}) {
  const world = await createWorld(container, config, { quality, reducedMotion });
  const { renderer, scene, camera, controls, lib } = world;
  const parts = createParts(config, lib);
  scene.add(parts.group);
  const robot = await createRobot(config, lib, world.layout);
  scene.add(robot.group);
  world.hooks.wristCamera = robot.wristCamera;
  const overlays = createOverlays({ container, scene, camera, renderer, config, robot, parts });
  const cap = createCapture({ renderer, scene, robot, config });
  const B = config.ROBOT.baseToWorld;

  // ---- side-table monitor: idle header, plus a 4:3 live view of the wrist camera
  const screen = world.room.screen;
  screen.material.map = idleScreenTexture(config); screen.material.color.set(0xffffff).multiplyScalar(0.9); screen.material.needsUpdate = true;
  const sp = screen.geometry.parameters, fh = sp.height * 0.83, fw = Math.min(sp.width * 0.9, (fh * config.CAMERA.width) / config.CAMERA.height);
  const feedQuad = new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), new THREE.MeshBasicMaterial({ color: 0x000000 }));
  feedQuad.position.set(0, -sp.height * 0.06, 0.0006); feedQuad.visible = false;
  screen.add(feedQuad);
  let feedRT = null, feedOn = false, feedFrame = 0;
  const ensureFeed = () => {
    const [w, h] = QUALITY[world.getQuality().level].feedSize;
    if (feedRT && feedRT.width === w && feedRT.height === h) return;
    feedRT?.dispose();
    feedRT = new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, depthBuffer: true, samples: 2 });
    feedQuad.material.map = feedRT.texture; feedQuad.material.color.set(0xffffff); feedQuad.material.needsUpdate = true;
  };
  const renderFeed = () => {
    const every = QUALITY[world.getQuality().level].feedEvery;
    if (!feedOn || !every) { feedQuad.visible = false; return; }
    ensureFeed();
    if (feedFrame++ % every !== 0 && feedQuad.visible) return;
    const prev = renderer.getRenderTarget();
    feedQuad.visible = false;                       // never show the monitor to itself
    renderer.setRenderTarget(feedRT);
    renderer.render(scene, robot.wristCamera);
    renderer.setRenderTarget(prev);
    feedQuad.visible = true;
  };
  world.hooks.beforeRender = () => { robot.sync(); renderFeed(); overlays.update(); };
  world.on('resize', (w, h) => overlays.resize(w, h));
  world.on('quality', () => { if (feedRT) { feedRT.dispose(); feedRT = null; } });
  world.resize();

  // ---- optional internal loop (the dev page uses it; index.js may call rig.render(dt) from its own loop instead)
  let raf = 0, lastT = 0, frameCb = null;
  const tick = (t) => {
    raf = requestAnimationFrame(tick);
    const dt = Math.min(0.1, lastT ? (t - lastT) / 1000 : 1 / 60); lastT = t;
    if (!world.isActive()) return;
    frameCb?.(dt);
    world.render(dt);
  };

  const rig = {
    THREE, renderer, scene, camera, controls,
    world, lib, config, gpu: world.gpu, layout: world.layout,
    robot: {
      setJoints: robot.setJoints, setGripper: robot.setGripper,
      getJoints: robot.getJoints, getGripper: robot.getGripper,
      getTcpMatrix: robot.getTcpMatrix, getPadMatrices: robot.getPadMatrices,
      getLinkMatrices: robot.getLinkMatrices, getLinkBounds: robot.getLinkBounds,
      getCameraMatrix: robot.getCameraMatrix, setIntrinsics: robot.setIntrinsics, getIntrinsics: robot.getIntrinsics,
      wristCamera: robot.wristCamera, object: robot.group,
    },
    parts: parts.parts,
    setPartPose: parts.setPose,
    getPartObject: (key) => parts.parts[key]?.object ?? null,
    /** World pose of a part from config: state 'home' (disassembled) or 'seat' (assembled). key may be 'cover'. */
    poseFor: (key, state = 'home') => poseFor(config, key, state),
    /** Put all five parts in one of the two reference states. */
    setPartsState: (state) => { parts.setState(state); overlays.edges.refresh(); },
    capture: (o) => cap.capture(o),
    overlays,
    setQuality: (q) => world.setQuality(q),
    getQuality: () => world.getQuality().level,
    getQualityRequest: () => world.getQuality().requested,
    setCameraPreset: (name, o) => world.setCameraPreset(name, o),
    setOrbit: (on) => world.setOrbit(on), getOrbit: () => world.getOrbit(), onOrbit: (fn) => world.onOrbit(fn),
    getCameraPreset: world.getCameraPreset,
    setDepthOfField: world.setDepthOfField,
    setLabels: (on) => { on ? overlays.labels.show() : overlays.labels.hide(); },
    setScreenFeed: (on) => { feedOn = !!on; feedFrame = 0; if (!feedOn) feedQuad.visible = false; },
    spinGears: (angleRedRad, o) => parts.spin(angleRedRad, o),
    render: (dt, o) => world.render(dt, o),
    resize: () => world.resize(),
    setPaused: (v) => world.setPaused(v),
    start(onFrame) { frameCb = onFrame ?? null; if (!raf) { lastT = 0; raf = requestAnimationFrame(tick); } },
    stop() { cancelAnimationFrame(raf); raf = 0; },
    stats: () => world.stats(),
    /** Renders one frame now and returns it as a PNG data URL. */
    snapshot(type = 'image/png', q) { world.render(0, { force: true }); return renderer.domElement.toDataURL(type, q); },
    selfTest: () => selfTest(),
    dispose() {
      rig.stop(); cap.dispose(); overlays.dispose(); feedRT?.dispose();
      world.dispose();
    },
  };

  // ------------------------------------------------------------------ self-test (site/dev/rig.html?selftest=1)
  function selfTest() {
    const out = { ok: true, gpu: world.gpu };
    const saved = { q: robot.getJoints(), w: robot.getGripper().width, poses: Object.fromEntries(config.PARTS.map((p) => [p.key, [parts.parts[p.key].object.position.toArray(), parts.parts[p.key].object.quaternion.toArray()]])) };
    const rnd = mulberry(config.SEED * 31 + 5);

    // 1. joint tree against kinematics.fk
    let posErr = 0, rotErr = 0, linkErr = 0;
    for (let n = 0; n < 5; n++) {
      const q = kin.JOINTS.map((j) => j.lo + rnd() * (j.hi - j.lo));
      robot.setJoints(q);
      const T = robot.getTcpMatrix(), F = kin.fk(q, B), L = robot.getLinkMatrices();
      posErr = Math.max(posErr, Math.hypot(T[3] - F.tcp[3], T[7] - F.tcp[7], T[11] - F.tcp[11]));
      for (const i of [0, 1, 2, 4, 5, 6, 8, 9, 10]) rotErr = Math.max(rotErr, Math.abs(T[i] - F.tcp[i]));
      for (let i = 0; i < 6; i++) { const M = L[`link${i + 1}`], G = F.frames[i]; linkErr = Math.max(linkErr, Math.hypot(M[3] - G[3], M[7] - G[7], M[11] - G[11])); }
    }
    out.fk = { samples: 5, tcpPosErrMm: posErr * 1e3, tcpRotErr: rotErr, linkPosErrMm: linkErr * 1e3, pass: posErr < 1e-4 };
    if (!out.fk.pass) out.ok = false;

    // 2. gripper linkage: pad gap equals the requested width
    robot.setJoints(config.ROBOT.home);
    const padT = config.ROBOT.gripper.padSize[1];
    let gapErr = 0, tipZ = [];
    const flangeInv = () => kin.invRigid(robot.getLinkMatrices().gripper_base);
    for (const w of [0, 0.01, 0.024, 0.048, 0.072, config.ROBOT.gripper.strokeMax]) {
      robot.setGripper(w);
      const P = robot.getPadMatrices(), inv = flangeInv();
      const l = kin.xform(inv, kin.pos(P.left)), r = kin.xform(inv, kin.pos(P.right));
      gapErr = Math.max(gapErr, Math.abs(l[1] - r[1] - padT - w), Math.abs(l[0]) + Math.abs(r[0]), Math.abs(l[2] - r[2]));
      tipZ.push(+(l[2] + config.ROBOT.gripper.padSize[2] / 2).toFixed(4));
    }
    out.gripper = { padGapErrMm: gapErr * 1e3, padTipZ_closedToOpen: tipZ, tcpZ: kin.TCP_Z, drive: robot.getGripper(), pass: gapErr < 1e-4 };
    if (!out.gripper.pass) out.ok = false;

    // 3. capture: K / depth / id round trip, looking straight down at the disassembled parts
    parts.setState('home');
    const top = config.TABLE.topY;
    // kinematics.ik takes the target in the frame that `base` maps into, here the world
    const sol = kin.ik({ p: [0.26, top + 0.25, 0.1], z: [0, -1, 0], x: [-1, 0, 0] }, config.ROBOT.home, { base: B });
    robot.setJoints(sol.q); robot.setGripper(config.ROBOT.gripper.strokeMax);
    world.render(0, { force: true });               // make sure the shadow map and matrices are current
    const IDS = config.IDS;
    const F = config.GEAR.faceWidth;
    const probes = [];
    for (let i = 0; i < 7; i++) for (let j = 0; j < 7; j++) probes.push({ P: [0.0 + i * 0.07, top, -0.08 + j * 0.07], id: IDS.table, plane: top });
    for (const def of config.PARTS.filter((p) => p.kind === 'gear')) {
      const b = gearBody(config.GEAR, def.size), r = ((b.rimIn + b.root) / 2) * 1e-3;
      for (let k = 0; k < 8; k++) { const a = (k / 8) * Math.PI * 2 + 0.2; probes.push({ P: [def.home.x + r * Math.cos(a), top + F, def.home.z + r * Math.sin(a)], id: IDS[def.key], plane: top + F }); }
    }
    const check = (o) => {
      const c = rig.capture(o), { K, camToWorld: M, width: w, height: h } = c;
      const res = { path: c.depthPath, size: `${w}x${h}`, used: 0, skipped: 0, rayPlaneErrMm: 0, roundTripErrMm: 0, idMismatch: 0, idsSeen: [...new Set(c.id)].sort((a, b) => a - b) };
      const o3 = [M[3], M[7], M[11]];
      for (const pr of probes) {
        const { u, v } = projectPoint(K, M, pr.P), ui = Math.round(u), vi = Math.round(v);
        if (ui < 2 || vi < 2 || ui > w - 3 || vi > h - 3) { res.skipped++; continue; }
        let clean = true;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (c.id[(vi + dy) * w + ui + dx] !== pr.id) clean = false;
        if (!clean) {
          // a table probe may lie under a part, and the gripper may hide a gear: neither is an error.
          // A gear-top probe that shows any other id is.
          const seen = c.id[vi * w + ui];
          if (pr.id !== IDS.table && seen !== pr.id && seen !== IDS.robot) res.idMismatch++;
          res.skipped++; continue;
        }
        res.used++;
        // (a) the stored pixel, back-projected, against the exact ray-plane intersection for that pixel
        const d = c.depth[vi * w + ui], Pb = backProject(K, M, ui, vi, d);
        const dir = kin.xdir(M, [(ui - K[2]) / K[0], (vi - K[5]) / K[4], 1]), t = (pr.plane - o3[1]) / dir[1];
        const Pt = [o3[0] + dir[0] * t, o3[1] + dir[1] * t, o3[2] + dir[2] * t];
        res.rayPlaneErrMm = Math.max(res.rayPlaneErrMm, Math.hypot(Pb[0] - Pt[0], Pb[1] - Pt[1], Pb[2] - Pt[2]) * 1e3);
        // (b) the known world point: project, sample depth at the sub-pixel position (inverse depth is linear on a plane), back-project
        const u0 = Math.floor(u), v0 = Math.floor(v), fu = u - u0, fv = v - v0;
        const iz = (x, y) => 1 / c.depth[y * w + x];
        const di = 1 / ((1 - fu) * (1 - fv) * iz(u0, v0) + fu * (1 - fv) * iz(u0 + 1, v0) + (1 - fu) * fv * iz(u0, v0 + 1) + fu * fv * iz(u0 + 1, v0 + 1));
        const Pr = backProject(K, M, u, v, di);
        res.roundTripErrMm = Math.max(res.roundTripErrMm, Math.hypot(Pr[0] - pr.P[0], Pr[1] - pr.P[1], Pr[2] - pr.P[2]) * 1e3);
      }
      res.pass = res.used >= 12 && res.rayPlaneErrMm < 1 && res.roundTripErrMm < 1 && res.idMismatch === 0;
      return res;
    };
    out.capture = { ikOk: sol.ok, ikErrMm: sol.err * 1e3, floatSupported: cap.floatOK, full: check({}), packed: check({ packed: true }), half: check({ width: config.CAMERA.width / 2, height: config.CAMERA.height / 2 }) };
    for (const k of ['full', 'packed', 'half']) if (!out.capture[k].pass) out.ok = false;

    // 4. layout checks from config and the generated tooth outlines
    out.assembly = checkAssembly(config);
    if (!out.assembly.ok) out.ok = false;
    const flat = config.PARTS.every((p) => Math.abs(poseFor(config, p.key, 'home').position[1] - top) < 1e-9);
    out.homeOnTable = flat;

    // restore
    robot.setJoints(saved.q); robot.setGripper(saved.w);
    for (const [k, [p, q]] of Object.entries(saved.poses)) parts.setPose(k, p, q);
    return out;
  }

  return rig;
}
