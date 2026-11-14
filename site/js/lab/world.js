// Renderer, room, table, lights, material library, post-processing, quality tiers and camera presets.
// World frame: y up, metres. Contract dimensions come from config.js; furniture that is only decoration
// (window, door, cabinets, side table, clutter) is laid out here relative to the room and the table.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { HDRLoader } from 'three/addons/loaders/HDRLoader.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { RectAreaLightUniformsLib } from 'three/addons/lights/RectAreaLightUniformsLib.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { BokehPass } from 'three/addons/postprocessing/BokehPass.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

export const LAYER_OVERLAY = 1;      // helpers, point clouds, lines: seen by the stage camera, not by the wrist camera

export const QUALITY = {
  high:   { pixelRatio: 2,   shadow: 4096, ao: 1,   aoSamples: 16, bloom: true,  smaa: true,  vignette: true,  rect: true,  feedEvery: 2, feedSize: [640, 480], aniso: 16, texLow: false },
  medium: { pixelRatio: 1.5, shadow: 2048, ao: 0.5, aoSamples: 8,  bloom: false, smaa: true,  vignette: true,  rect: true,  feedEvery: 4, feedSize: [320, 240], aniso: 8,  texLow: false },
  low:    { pixelRatio: 1,   shadow: 1024, ao: 0,   aoSamples: 0,  bloom: false, smaa: false, vignette: false, rect: false, feedEvery: 0, feedSize: [320, 240], aniso: 2,  texLow: true },
};

const ASSETS = new URL('../../assets/', import.meta.url);

/** Positions that robot.js and rig.js share with the room. Derived from config; nothing here changes the contract. */
export function layout(config) {
  const { ROOM, TABLE, ROBOT } = config;
  const x0 = ROOM.center[0] - ROOM.size[0] / 2, x1 = ROOM.center[0] + ROOM.size[0] / 2;
  const z0 = ROOM.center[2] - ROOM.size[2] / 2, z1 = ROOM.center[2] + ROOM.size[2] / 2;
  const mb = ROBOT.mobileBase.size;
  return {
    room: { x0, x1, z0, z1, h: ROOM.size[1] },
    tableX: [TABLE.center[0] - TABLE.size[0] / 2, TABLE.center[0] + TABLE.size[0] / 2],
    tableZ: [TABLE.center[1] - TABLE.size[2] / 2, TABLE.center[1] + TABLE.size[2] / 2],
    // The arm stands on the front part of the chassis so that the chassis stops just short of the table edge.
    mobileBase: { center: [ROBOT.basePosition[0] + mb[0] / 2 - 0.235, 0, ROBOT.basePosition[2]], size: mb, topY: ROBOT.mobileBase.topY },
    sideTable: { center: [0.86, z0 + 0.34], size: [0.95, 0.72, 0.56] },
    window: { x: [TABLE.center[0] - 1.2, TABLE.center[0] + 0.45], y: [0.95, 2.25] },
  };
}

// ------------------------------------------------------------------ small geometry helpers

/** UVs in metres from the dominant normal axis, so textures keep their real scale on any box. */
export function worldUV(geo, tileU = 1, tileV = tileU, grainAlongX = false) {
  const p = geo.attributes.position, n = geo.attributes.normal;
  const uv = new Float32Array(p.count * 2);
  for (let i = 0; i < p.count; i++) {
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    let u, v;
    if (ay >= ax && ay >= az) { u = p.getX(i); v = p.getZ(i); }
    else if (ax >= az) { u = p.getZ(i); v = p.getY(i); }
    else { u = p.getX(i); v = p.getY(i); }
    if (grainAlongX) { const t = u; u = v; v = t; }
    uv[i * 2] = u / tileU; uv[i * 2 + 1] = v / tileV;
  }
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geo;
}

export function rbox(w, h, d, r = 0.004, seg = 2) {
  const rr = Math.min(r, w / 2 - 1e-4, h / 2 - 1e-4, d / 2 - 1e-4);
  return rr > 2e-4 ? new RoundedBoxGeometry(w, h, d, seg, rr) : new THREE.BoxGeometry(w, h, d);
}

/** Collects static geometry per material and merges it into one mesh per material. */
export class Batch {
  constructor() { this.items = new Map(); }
  add(mat, geo, { pos = [0, 0, 0], rot = [0, 0, 0], tile = null, grainX = false } = {}) {
    let g = geo.index ? geo.toNonIndexed() : geo;
    if (rot[0] || rot[1] || rot[2]) g.applyMatrix4(new THREE.Matrix4().makeRotationFromEuler(new THREE.Euler(rot[0], rot[1], rot[2])));
    g.translate(pos[0], pos[1], pos[2]);
    if (!g.attributes.normal) g.computeVertexNormals();
    if (tile) worldUV(g, tile[0], tile[1], grainX);
    else if (!g.attributes.uv) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    for (const k of Object.keys(g.attributes)) if (!['position', 'normal', 'uv'].includes(k)) g.deleteAttribute(k);
    if (!this.items.has(mat)) this.items.set(mat, []);
    this.items.get(mat).push(g);
    return this;
  }
  box(mat, w, h, d, x, y, z, o = {}) { return this.add(mat, rbox(w, h, d, o.r ?? 0.004, o.seg ?? 1), { pos: [x, y, z], rot: o.rot, tile: o.tile, grainX: o.grainX }); }
  cyl(mat, r, h, x, y, z, o = {}) { return this.add(mat, new THREE.CylinderGeometry(o.rTop ?? r, r, h, o.seg ?? 20), { pos: [x, y, z], rot: o.rot }); }
  build(parent, { cast = true, receive = true, name = '' } = {}) {
    const meshes = [];
    for (const [mat, list] of this.items) {
      const m = new THREE.Mesh(mergeGeometries(list, false), mat);
      for (const g of list) g.dispose();
      m.castShadow = cast; m.receiveShadow = receive; m.name = name;
      m.matrixAutoUpdate = false;
      parent.add(m); meshes.push(m);
    }
    this.items.clear();
    return meshes;
  }
}

export function tube(points, radius, segments = 64, radial = 8) {
  const curve = new THREE.CatmullRomCurve3(points.map((p) => new THREE.Vector3(...p)), false, 'centripetal', 0.5);
  return new THREE.TubeGeometry(curve, segments, radius, radial, false);
}

function mulberry(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ------------------------------------------------------------------ materials

const NOISE_GLSL = /* glsl */`
float labHash(vec3 p){ p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float labNoise(vec3 p){ vec3 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(labHash(i), labHash(i + vec3(1,0,0)), f.x), mix(labHash(i + vec3(0,1,0)), labHash(i + vec3(1,1,0)), f.x), f.y),
             mix(mix(labHash(i + vec3(0,0,1)), labHash(i + vec3(1,0,1)), f.x), mix(labHash(i + vec3(0,1,1)), labHash(i + vec3(1,1,1)), f.x), f.y), f.z); }
`;

/** Adds a faint object-space roughness variation: moulded plastic and paint are never perfectly even. */
function withSurfaceNoise(mat, { fine = 900, coarse = 90, amount = 0.14 } = {}) {
  mat.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vLabObj;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvLabObj = position;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\nvarying vec3 vLabObj;\n${NOISE_GLSL}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = clamp(roughnessFactor + (labNoise(vLabObj * ${fine.toFixed(1)}) - 0.5) * ${amount.toFixed(3)} + (labNoise(vLabObj * ${coarse.toFixed(1)}) - 0.5) * ${(amount * 0.8).toFixed(3)}, 0.05, 1.0);`);
  };
  mat.customProgramCacheKey = () => `labNoise:${fine}:${coarse}:${amount}`;
  return mat;
}

async function loadTextures(renderer) {
  const loader = new THREE.TextureLoader();
  // only the maps that a material really uses are fetched
  const want = {
    laminate_floor_02: ['map', 'normalMap', 'arm'], plywood: ['map', 'normalMap', 'arm'], wood_cabinet_worn_long: ['map', 'normalMap', 'arm'],
    painted_plaster_wall: ['normalMap', 'arm'], metal_plate: ['normalMap'],
  };
  const file = { map: 'diffuse_1k.jpg', normalMap: 'nor_gl_1k.jpg', arm: 'arm_1k.jpg' };
  const sets = {};
  await Promise.all(Object.entries(want).map(async ([n, keys]) => {
    const base = new URL(`textures/${n}/${n}_`, ASSETS).href;
    const loaded = await Promise.all(keys.map((k) => loader.loadAsync(base + file[k])));
    sets[n] = {};
    keys.forEach((k, i) => {
      const t = loaded[i];
      if (k === 'map') t.colorSpace = THREE.SRGBColorSpace;
      t.wrapS = t.wrapT = THREE.RepeatWrapping; t.userData.full = t.image;
      sets[n][k] = t;
    });
  }));
  return sets;
}

/** Beige laminate for the table top: the plywood grain, lightened, with fine speckles like the top in Fig. 7. */
function tableTopTexture(plywoodImage, seed) {
  const s = 1024, c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  g.fillStyle = '#cfc3a9'; g.fillRect(0, 0, s, s);
  g.globalAlpha = 0.22; g.globalCompositeOperation = 'multiply'; g.drawImage(plywoodImage, 0, 0, s, s);
  g.globalCompositeOperation = 'source-over';
  const rnd = mulberry(seed * 977 + 13);
  for (let i = 0; i < 5200; i++) {
    const x = rnd() * s, y = rnd() * s, r = 0.45 + rnd() * 1.0, dark = rnd() < 0.6;
    g.globalAlpha = dark ? 0.10 + rnd() * 0.2 : 0.06 + rnd() * 0.12;
    g.fillStyle = dark ? '#6b5f4c' : '#fbf6ea';
    g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
  }
  g.globalAlpha = 1;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping; t.userData.full = c;
  return t;
}

function outsideTexture() {
  const c = document.createElement('canvas'); c.width = 512; c.height = 512;
  const g = c.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, 512);
  sky.addColorStop(0, '#9fc3ea'); sky.addColorStop(0.55, '#dbe9f6'); sky.addColorStop(0.72, '#f3f1ea'); sky.addColorStop(1, '#c9c7bd');
  g.fillStyle = sky; g.fillRect(0, 0, 512, 512);
  const rnd = mulberry(4242);
  g.filter = 'blur(3px)';
  for (let i = 0; i < 9; i++) {           // soft far buildings
    const x = i * 60 - 20 + rnd() * 20, w = 46 + rnd() * 40, h = 70 + rnd() * 120;
    g.fillStyle = `rgba(${150 + rnd() * 40 | 0},${155 + rnd() * 40 | 0},${160 + rnd() * 40 | 0},0.75)`;
    g.fillRect(x, 512 - 130 - h, w, h + 130);
  }
  g.filter = 'none';
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function createMaterials(tex, seed) {
  const P = (o) => new THREE.MeshPhysicalMaterial(o);
  const S = (o) => new THREE.MeshStandardMaterial(o);
  const set = (name, tileU, tileV = tileU) => {
    const t = tex[name];
    const out = {};
    for (const k of ['map', 'normalMap', 'arm']) if (t[k]) { out[k] = t[k].clone(); out[k].userData.full = t[k].userData.full; out[k].repeat.set(1, 1); out[k].needsUpdate = true; }
    out.tile = [tileU, tileV];
    return out;
  };
  const pbr = (s, extra = {}) => S({ map: s.map, normalMap: s.normalMap, roughnessMap: s.arm, metalnessMap: s.arm, aoMap: s.arm, metalness: 1, roughness: 1, ...extra });
  const floorSet = set('laminate_floor_02', 1.6), wallSet = set('painted_plaster_wall', 1.8), woodSet = set('wood_cabinet_worn_long', 1.2, 0.6);
  const plySet = set('plywood', 0.45), metalSet = set('metal_plate', 0.2);
  const tableMap = tableTopTexture(tex.plywood.map.image, seed);
  const gearCache = new Map();
  const lib = {
    textures: [floorSet, wallSet, woodSet, plySet, metalSet].flatMap((s) => [s.map, s.normalMap, s.arm]).filter(Boolean).concat(tableMap),
    tiles: { floor: floorSet.tile, wall: wallSet.tile, wood: woodSet.tile, ply: plySet.tile, metal: metalSet.tile, table: [0.7, 0.7] },
    floor: pbr(floorSet, { metalness: 0, color: 0xb9a89a, roughness: 0.82, normalScale: new THREE.Vector2(0.6, 0.6), envMapIntensity: 0.7 }),
    // white paint: the plaster set gives relief and roughness only; its grey albedo would read as bare concrete
    wall: S({ normalMap: wallSet.normalMap, roughnessMap: wallSet.arm, color: 0xe9e9e4, roughness: 1, metalness: 0, normalScale: new THREE.Vector2(0.35, 0.35), envMapIntensity: 0.45 }),
    ceiling: S({ color: 0xf1f1ee, roughness: 0.95, metalness: 0 }),
    wood: pbr(woodSet, { metalness: 0, color: 0x9a8370, roughness: 0.9, normalScale: new THREE.Vector2(0.8, 0.8), envMapIntensity: 0.6 }),
    woodFrame: S({ color: 0x33221a, roughness: 0.6, metalness: 0 }),
    tableTop: P({ map: tableMap, normalMap: plySet.normalMap, normalScale: new THREE.Vector2(0.12, 0.12), roughness: 0.58, metalness: 0, clearcoat: 0.08, clearcoatRoughness: 0.5, envMapIntensity: 0.7 }),
    sideTop: S({ map: plySet.map, normalMap: plySet.normalMap, roughnessMap: plySet.arm, color: 0xd9c8b2, roughness: 0.8, metalness: 0, normalScale: new THREE.Vector2(0.4, 0.4) }),
    frameBlack: S({ color: 0x17181a, roughness: 0.48, metalness: 0.35 }),
    baseboard: S({ color: 0x2b211c, roughness: 0.55, metalness: 0 }),
    whiteTrim: S({ color: 0xe9e9e6, roughness: 0.45, metalness: 0 }),
    blinds: S({ color: 0xe6e3da, roughness: 0.5, metalness: 0.1, side: THREE.DoubleSide }),
    glass: P({ color: 0xffffff, roughness: 0.03, metalness: 0, transparent: true, opacity: 0.1, envMapIntensity: 1.6, depthWrite: false }),
    chrome: S({ color: 0xc9ccd0, roughness: 0.22, metalness: 1 }),
    brushed: S({ color: 0xa9adb3, roughness: 0.42, metalness: 1 }),
    darkPlastic: S({ color: 0x1c1d20, roughness: 0.5, metalness: 0 }),
    greyPlastic: S({ color: 0x8b9096, roughness: 0.55, metalness: 0 }),
    whitePlastic: S({ color: 0xe8e8e4, roughness: 0.4, metalness: 0 }),
    rubber: S({ color: 0x0f0f10, roughness: 0.9, metalness: 0 }),
    caseBlue: S({ color: 0x27384a, roughness: 0.55, metalness: 0 }),
    cableBlack: S({ color: 0x101012, roughness: 0.55, metalness: 0 }),
    cableYellow: S({ color: 0xd9a514, roughness: 0.5, metalness: 0 }),
    cableGrey: S({ color: 0x9a9da0, roughness: 0.6, metalness: 0 }),
    treadPlate: S({ color: 0xb6b9be, roughness: 0.4, metalness: 0.9, normalMap: metalSet.normalMap, normalScale: new THREE.Vector2(0.9, 0.9) }),
    screenBezel: S({ color: 0x0c0c0d, roughness: 0.35, metalness: 0.1 }),
    // robot
    armWhite: withSurfaceNoise(P({ color: 0xf1f1ee, roughness: 0.32, metalness: 0, clearcoat: 0.7, clearcoatRoughness: 0.14, envMapIntensity: 1.0 }), { fine: 260, coarse: 40, amount: 0.05 }),
    armDark: P({ color: 0x3b3e43, roughness: 0.42, metalness: 0.75, envMapIntensity: 1.0 }),
    armRing: S({ color: 0x565a60, roughness: 0.3, metalness: 1.0 }),
    aluminium: S({ color: 0xb4b8bd, roughness: 0.36, metalness: 1.0 }),
    gripperBody: withSurfaceNoise(P({ color: 0x54585f, roughness: 0.5, metalness: 0.25, clearcoat: 0.25, clearcoatRoughness: 0.35 }), { fine: 500, coarse: 60, amount: 0.08 }),
    gripperBlack: withSurfaceNoise(S({ color: 0x121214, roughness: 0.62, metalness: 0.05 }), { fine: 700, coarse: 80, amount: 0.12 }),
    chassis: withSurfaceNoise(P({ color: 0x25282d, roughness: 0.5, metalness: 0.3, clearcoat: 0.25, clearcoatRoughness: 0.35 }), { fine: 300, coarse: 30, amount: 0.08 }),
    chassisLight: S({ color: 0xc4c7cb, roughness: 0.4, metalness: 0.85 }),
    tyre: S({ color: 0x0d0d0e, roughness: 0.92, metalness: 0 }),
    estopRed: P({ color: 0xc8161d, roughness: 0.3, metalness: 0, clearcoat: 0.6, clearcoatRoughness: 0.2 }),
    estopYellow: S({ color: 0xe2b616, roughness: 0.5, metalness: 0 }),
    lensGlass: P({ color: 0x05060a, roughness: 0.04, metalness: 0, clearcoat: 1, clearcoatRoughness: 0.02, envMapIntensity: 1.8 }),
    led: (hex, k = 4) => new THREE.MeshBasicMaterial({ color: new THREE.Color(hex).multiplyScalar(k) }),
    // gearbox parts
    coverPlastic: withSurfaceNoise(P({ color: 0xe9e7e1, roughness: 0.5, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.45, envMapIntensity: 0.85 }), { fine: 1100, coarse: 70, amount: 0.12 }),
    polishedSteel: S({ color: 0xd2d5d9, roughness: 0.16, metalness: 1, envMapIntensity: 1.3 }),
    gearPlastic(hex) {
      if (!gearCache.has(hex)) gearCache.set(hex, withSurfaceNoise(P({ color: new THREE.Color(hex), roughness: 0.4, metalness: 0, clearcoat: 0.32, clearcoatRoughness: 0.3, envMapIntensity: 0.9 }), { fine: 1200, coarse: 110, amount: 0.14 }));
      return gearCache.get(hex);
    },
    nutPlastic(hex) { return this.gearPlastic(hex); },
  };
  lib.sets = { floorSet, wallSet, woodSet, plySet, metalSet };
  tableMap.repeat.set(1, 1);
  return lib;
}

// ------------------------------------------------------------------ room

function buildRoom(config, lib, L) {
  const group = new THREE.Group();
  group.name = 'room';
  const { x0, x1, z0, z1, h: H } = L.room;
  const W = x1 - x0, D = z1 - z0, cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, T = 0.14;
  const shell = new Batch(), deco = new Batch();

  // floor and ceiling
  shell.add(lib.floor, new THREE.PlaneGeometry(W, D).rotateX(-Math.PI / 2), { pos: [cx, 0, cz], tile: lib.tiles.floor });
  shell.add(lib.ceiling, new THREE.PlaneGeometry(W, D).rotateX(Math.PI / 2), { pos: [cx, H, cz] });
  // walls: +z, +x, -x are plain boxes; -z carries the window
  const wt = lib.tiles.wall;
  shell.add(lib.wall, new THREE.BoxGeometry(W + 2 * T, H, T), { pos: [cx, H / 2, z1 + T / 2], tile: wt });
  shell.add(lib.wall, new THREE.BoxGeometry(T, H, D), { pos: [x1 + T / 2, H / 2, cz], tile: wt });
  shell.add(lib.wall, new THREE.BoxGeometry(T, H, D), { pos: [x0 - T / 2, H / 2, cz], tile: wt });
  const [wx0, wx1] = L.window.x, [wy0, wy1] = L.window.y, ww = wx1 - wx0, wh = wy1 - wy0, wcx = (wx0 + wx1) / 2, wcy = (wy0 + wy1) / 2;
  shell.add(lib.wall, new THREE.BoxGeometry(wx0 - x0 + T, H, T), { pos: [(x0 - T + wx0) / 2, H / 2, z0 - T / 2], tile: wt });
  shell.add(lib.wall, new THREE.BoxGeometry(x1 + T - wx1, H, T), { pos: [(x1 + T + wx1) / 2, H / 2, z0 - T / 2], tile: wt });
  shell.add(lib.wall, new THREE.BoxGeometry(ww, wy0, T), { pos: [wcx, wy0 / 2, z0 - T / 2], tile: wt });
  shell.add(lib.wall, new THREE.BoxGeometry(ww, H - wy1, T), { pos: [wcx, (H + wy1) / 2, z0 - T / 2], tile: wt });
  shell.build(group, { cast: false, receive: true, name: 'room-shell' });

  // window: frame, mullion, sill, glass, blinds, bright outside
  const fz = z0 - 0.075, fw = 0.05, fd = 0.07;
  deco.box(lib.whiteTrim, ww, fw, fd, wcx, wy1 - fw / 2, fz).box(lib.whiteTrim, ww, fw, fd, wcx, wy0 + fw / 2, fz)
    .box(lib.whiteTrim, fw, wh, fd, wx0 + fw / 2, wcy, fz).box(lib.whiteTrim, fw, wh, fd, wx1 - fw / 2, wcy, fz)
    .box(lib.whiteTrim, fw * 0.9, wh, fd, wcx, wcy, fz)
    .box(lib.whiteTrim, ww + 0.1, 0.028, T + 0.06, wcx, wy0 - 0.012, z0 - T / 2 + 0.03, { r: 0.006 });
  const slatTop = wy1 - 0.075, slatGap = 0.0215, nSlat = Math.floor((wh * 0.46) / slatGap);
  deco.box(lib.whiteTrim, ww - 0.11, 0.03, 0.04, wcx, wy1 - 0.065, z0 - 0.03, { r: 0.004 });
  for (let i = 0; i < nSlat; i++) deco.add(lib.blinds, new THREE.BoxGeometry(ww - 0.13, 0.0012, 0.025), { pos: [wcx, slatTop - 0.02 - i * slatGap, z0 - 0.03], rot: [0.62, 0, 0] });
  deco.box(lib.whiteTrim, ww - 0.11, 0.018, 0.03, wcx, slatTop - 0.03 - nSlat * slatGap, z0 - 0.03, { r: 0.004 });
  for (const sx of [-0.3, 0.3]) deco.add(lib.cableGrey, new THREE.CylinderGeometry(0.0008, 0.0008, nSlat * slatGap + 0.02, 5), { pos: [wcx + sx * ww, slatTop - 0.02 - (nSlat * slatGap) / 2, z0 - 0.03] });
  const glass = new THREE.Mesh(new THREE.PlaneGeometry(ww - 2 * fw, wh - 2 * fw), lib.glass);
  glass.position.set(wcx, wcy, z0 - 0.085); glass.renderOrder = 2; group.add(glass);
  const outside = new THREE.Mesh(new THREE.PlaneGeometry(ww + 2.4, wh + 1.6), new THREE.MeshBasicMaterial({ map: outsideTexture(), color: new THREE.Color(2.6, 2.6, 2.6) }));
  outside.position.set(wcx, wcy + 0.15, z0 - 1.0); outside.name = 'outside'; group.add(outside);

  // ceiling light panels above the table (emissive faces; the area lights live in createWorld)
  const panels = [];
  const tcx = config.TABLE.center[0], tcz = config.TABLE.center[1];
  for (const px of [tcx - 0.55, tcx + 0.75]) {
    const pz = tcz + 0.25;
    deco.box(lib.whiteTrim, 0.66, 0.02, 1.26, px, H - 0.008, pz, { r: 0.004 });
    const face = new THREE.Mesh(new THREE.PlaneGeometry(0.6, 1.2).rotateX(Math.PI / 2), lib.led(0xfff3e2, 7));
    face.position.set(px, H - 0.0195, pz); face.name = 'ceiling-panel'; group.add(face);
    panels.push({ x: px, z: pz, w: 0.6, d: 1.2 });
  }

  // baseboards (skipped where the door and the tall cabinet stand)
  const bb = lib.baseboard, bh = 0.08, bt = 0.014;
  deco.box(bb, W, bh, bt, cx, bh / 2, z0 + bt / 2, { r: 0.003 }).box(bb, W, bh, bt, cx, bh / 2, z1 - bt / 2, { r: 0.003 })
    .box(bb, bt, bh, D, x1 - bt / 2, bh / 2, cz, { r: 0.003 });
  const doorZ = cz + 1.0, doorW = 0.9, doorH = 2.05;
  deco.box(bb, bt, bh, doorZ - doorW / 2 - 0.07 - z0, x0 + bt / 2, bh / 2, (z0 + doorZ - doorW / 2 - 0.07) / 2, { r: 0.003 })
    .box(bb, bt, bh, z1 - (doorZ + doorW / 2 + 0.07), x0 + bt / 2, bh / 2, (z1 + doorZ + doorW / 2 + 0.07) / 2, { r: 0.003 });

  // door on the -x wall
  const wd = lib.tiles.wood;
  deco.box(lib.wood, 0.042, doorH, doorW, x0 + 0.03, doorH / 2 + 0.005, doorZ, { r: 0.004, tile: wd })
    .box(lib.woodFrame, 0.09, doorH + 0.07, 0.07, x0 + 0.02, (doorH + 0.07) / 2, doorZ - doorW / 2 - 0.038, { r: 0.006 })
    .box(lib.woodFrame, 0.09, doorH + 0.07, 0.07, x0 + 0.02, (doorH + 0.07) / 2, doorZ + doorW / 2 + 0.038, { r: 0.006 })
    .box(lib.woodFrame, 0.09, 0.07, doorW + 0.146, x0 + 0.02, doorH + 0.04, doorZ, { r: 0.006 })
    .cyl(lib.brushed, 0.026, 0.008, x0 + 0.055, 1.0, doorZ + doorW / 2 - 0.07, { rot: [0, 0, Math.PI / 2] })
    .cyl(lib.brushed, 0.009, 0.05, x0 + 0.08, 1.0, doorZ + doorW / 2 - 0.07, { rot: [0, 0, Math.PI / 2], seg: 12 })
    .box(lib.brushed, 0.016, 0.016, 0.12, x0 + 0.1, 1.0, doorZ + doorW / 2 - 0.12, { r: 0.007 });

  // cabinets: a low one beside the door (-x wall) and a tall one in the -z / +x corner, behind the robot as in Fig. 7
  const cabinet = (px, pz, w, h, d, ry) => {
    const g = new Batch();
    const plinth = 0.08;
    g.box(lib.frameBlack, w - 0.04, plinth, d - 0.05, 0, plinth / 2, -0.02, { r: 0.002 });
    g.box(lib.wood, w, h - plinth, d - 0.02, 0, plinth + (h - plinth) / 2, -0.01, { r: 0.005, tile: wd });
    g.box(lib.woodFrame, w + 0.02, 0.025, d + 0.01, 0, h + 0.0125, 0, { r: 0.005 });
    const dw = (w - 0.012) / 2, dh = h - plinth - 0.012;
    for (const s of [-1, 1]) {
      g.box(lib.wood, dw - 0.004, dh, 0.02, (s * (dw + 0.004)) / 2, plinth + 0.006 + dh / 2, d / 2 - 0.008, { r: 0.004, tile: wd });
      g.box(lib.brushed, 0.012, Math.min(0.32, dh * 0.3), 0.012, s * 0.035, plinth + dh * 0.55, d / 2 + 0.022, { r: 0.005 });
      for (const o of [-1, 1]) g.box(lib.brushed, 0.01, 0.01, 0.022, s * 0.035, plinth + dh * 0.55 + o * Math.min(0.13, dh * 0.12), d / 2 + 0.012, { r: 0.003 });
    }
    const holder = new THREE.Group();
    holder.position.set(px, 0, pz); holder.rotation.y = ry; holder.updateMatrix();
    for (const m of g.build(holder, { name: 'cabinet' })) { m.matrixAutoUpdate = false; }
    holder.updateMatrixWorld(true);
    group.add(holder);
  };
  cabinet(x1 - 0.5, z0 + 0.235, 0.96, 2.02, 0.45, 0);
  cabinet(x0 + 0.225, cz - 1.25, 1.3, 0.86, 0.43, Math.PI / 2);

  // side table with monitor, keyboard and laptop
  const st = L.sideTable, sx = st.center[0], sz = st.center[1], sh = st.size[1], sw = st.size[0], sd = st.size[2];
  deco.box(lib.sideTop, sw, 0.028, sd, sx, sh - 0.014, sz, { r: 0.006, seg: 2, tile: lib.tiles.ply });
  for (const ax of [-1, 1]) for (const az of [-1, 1]) deco.box(lib.frameBlack, 0.03, sh - 0.028, 0.03, sx + ax * (sw / 2 - 0.04), (sh - 0.028) / 2, sz + az * (sd / 2 - 0.04), { r: 0.004 });
  deco.box(lib.frameBlack, sw - 0.1, 0.03, 0.02, sx, sh - 0.05, sz - sd / 2 + 0.04, { r: 0.003 }).box(lib.frameBlack, sw - 0.1, 0.03, 0.02, sx, sh - 0.05, sz + sd / 2 - 0.04, { r: 0.003 });
  const mon = { w: 0.56, h: 0.335, x: sx - 0.12, y: sh + 0.295, z: sz - 0.08, tilt: -0.08 };
  deco.box(lib.screenBezel, mon.w, mon.h, 0.022, mon.x, mon.y, mon.z, { r: 0.006, seg: 2, rot: [mon.tilt, 0, 0] })
    .box(lib.darkPlastic, 0.05, 0.2, 0.03, mon.x, sh + 0.11, mon.z - 0.03, { r: 0.008 })
    .box(lib.darkPlastic, 0.24, 0.012, 0.17, mon.x, sh + 0.006, mon.z - 0.01, { r: 0.005 })
    .box(lib.darkPlastic, 0.36, 0.014, 0.12, mon.x, sh + 0.008, sz + 0.14, { r: 0.005 })
    .box(lib.greyPlastic, 0.3, 0.014, 0.21, sx + 0.3, sh + 0.007, sz + 0.08, { r: 0.005, rot: [0, -0.25, 0] })
    .box(lib.greyPlastic, 0.3, 0.2, 0.008, sx + 0.326, sh + 0.11, sz - 0.03, { r: 0.003, rot: [-0.3, -0.25, 0] });
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(mon.w - 0.024, mon.h - 0.028), new THREE.MeshBasicMaterial({ color: 0x050607 }));
  screen.position.set(mon.x, mon.y + 0.002, mon.z + 0.0118); screen.rotation.x = mon.tilt; screen.name = 'monitor-screen';
  group.add(screen);
  const lapScreen = new THREE.Mesh(new THREE.PlaneGeometry(0.28, 0.18), new THREE.MeshBasicMaterial({ color: new THREE.Color(0.10, 0.13, 0.18) }));
  lapScreen.position.set(sx + 0.3252, sh + 0.111, sz - 0.0255); lapScreen.rotation.set(-0.3, -0.25, 0, 'YXZ'); group.add(lapScreen);

  // clutter on the far left corner of the work table: a closed tool case
  const tb = { x: L.tableX[0] + 0.2, z: L.tableZ[0] + 0.16, y: config.TABLE.topY };
  deco.box(lib.caseBlue, 0.3, 0.1, 0.19, tb.x, tb.y + 0.05, tb.z, { r: 0.014, seg: 2, rot: [0, 0.18, 0] })
    .box(lib.darkPlastic, 0.305, 0.012, 0.195, tb.x, tb.y + 0.062, tb.z, { r: 0.004, rot: [0, 0.18, 0] })
    .box(lib.darkPlastic, 0.11, 0.016, 0.022, tb.x, tb.y + 0.108, tb.z, { r: 0.007, rot: [0, 0.18, 0] })
    .box(lib.estopYellow, 0.03, 0.022, 0.012, tb.x - 0.085 + 0.017, tb.y + 0.062, tb.z + 0.098 + 0.015, { r: 0.003, rot: [0, 0.18, 0] })
    .box(lib.estopYellow, 0.03, 0.022, 0.012, tb.x + 0.085 + 0.017, tb.y + 0.062, tb.z + 0.092 - 0.015, { r: 0.003, rot: [0, 0.18, 0] });

  // power strip, wall socket and floor cables
  const mb = L.mobileBase, rear = mb.center[0] + mb.size[0] / 2;
  const strip = { x: rear + 0.22, z: z0 + 0.5 };
  deco.box(lib.whitePlastic, 0.34, 0.036, 0.058, strip.x, 0.018, strip.z, { r: 0.008, seg: 2, rot: [0, 0.3, 0] });
  for (let i = 0; i < 4; i++) deco.box(lib.darkPlastic, 0.04, 0.004, 0.04, strip.x - 0.1 * Math.cos(0.3) + i * 0.062 * Math.cos(0.3), 0.0365, strip.z + 0.1 * Math.sin(0.3) - i * 0.062 * Math.sin(0.3), { r: 0.002, rot: [0, 0.3, 0] });
  const sw1 = new THREE.Mesh(rbox(0.022, 0.008, 0.014, 0.003, 1), lib.led(0xff3a22, 2.2));
  sw1.position.set(strip.x + 0.145 * Math.cos(0.3), 0.038, strip.z - 0.145 * Math.sin(0.3)); sw1.rotation.y = 0.3; group.add(sw1);
  deco.box(lib.whitePlastic, 0.085, 0.085, 0.01, strip.x + 0.25, 0.3, z0 + 0.005, { r: 0.006 });
  const fl = 0.0045;
  const boxY = mb.size[1] + 0.04;                 // cables leave the back of the control box on the chassis deck
  deco.add(lib.cableBlack, tube([[rear - 0.11, boxY, 0.07], [rear - 0.04, boxY + 0.012, 0.07], [rear + 0.035, boxY - 0.08, 0.065], [rear + 0.05, 0.12, 0.05], [rear + 0.075, fl, 0.0], [rear + 0.16, fl, -0.45], [rear + 0.1, fl, -0.9], [strip.x - 0.12, fl, strip.z + 0.2], [strip.x - 0.16, 0.02, strip.z + 0.05]], 0.0042, 90, 8));
  deco.add(lib.cableBlack, tube([[strip.x + 0.17, 0.018, strip.z - 0.055], [strip.x + 0.27, fl, strip.z - 0.12], [strip.x + 0.3, fl, z0 + 0.12], [strip.x + 0.25, 0.14, z0 + 0.035], [strip.x + 0.25, 0.29, z0 + 0.02]], 0.004, 50, 8));
  deco.add(lib.cableYellow, tube([[rear - 0.11, boxY, -0.07], [rear - 0.04, boxY + 0.01, -0.07], [rear + 0.03, boxY - 0.08, -0.08], [rear + 0.045, 0.12, -0.11], [rear + 0.06, 0.0035, -0.2], [rear - 0.12, 0.0035, -0.7], [rear - 0.3, 0.0035, -1.0], [sx + 0.2, 0.0035, sz + 0.45], [sx + 0.36, 0.0035, sz + 0.2], [sx + 0.4, 0.3, sz - 0.2], [sx + 0.36, sh + 0.02, sz - 0.02]], 0.0032, 120, 7));
  deco.add(lib.cableBlack, tube([[mon.x, sh + 0.12, mon.z - 0.05], [mon.x + 0.02, sh - 0.05, sz - sd / 2 + 0.02], [mon.x + 0.1, 0.25, sz - sd / 2 + 0.03], [strip.x - 0.3, fl, sz + 0.05], [strip.x - 0.1, fl, strip.z - 0.06], [strip.x - 0.02, 0.02, strip.z - 0.01]], 0.0035, 70, 7));
  deco.build(group, { name: 'room-deco' });

  return { group, screen, panels, glass, outside, monitor: mon };
}

function buildTable(config, lib) {
  const { TABLE } = config;
  const g = new THREE.Group();
  g.name = 'table';
  g.userData.captureId = config.IDS?.table ?? 8;
  const [w, th, d] = TABLE.size, [cx, cz] = TABLE.center, top = TABLE.topY, tube_ = TABLE.frameTube, inset = TABLE.legInset;
  const slabGeo = new RoundedBoxGeometry(w, th, d, 3, 0.0035);
  slabGeo.translate(cx, top - th / 2, cz);
  worldUV(slabGeo, lib.tiles.table[0], lib.tiles.table[1]);
  const slab = new THREE.Mesh(slabGeo, lib.tableTop);
  slab.castShadow = true; slab.receiveShadow = true; slab.name = 'table-top'; slab.matrixAutoUpdate = false;
  g.add(slab);
  const b = new Batch();
  const lx = w / 2 - inset - tube_ / 2, lz = d / 2 - inset - tube_ / 2, legH = top - th;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
    b.box(lib.frameBlack, tube_, legH - 0.012, tube_, cx + sx * lx, 0.012 + (legH - 0.012) / 2, cz + sz * lz, { r: 0.005 });
    b.cyl(lib.darkPlastic, 0.018, 0.012, cx + sx * lx, 0.006, cz + sz * lz, { seg: 16 });
  }
  const railH = 0.05, ry = legH - railH / 2;
  for (const sz of [-1, 1]) b.box(lib.frameBlack, 2 * lx - tube_, railH, tube_ * 0.6, cx, ry, cz + sz * lz, { r: 0.004 });
  for (const sx of [-1, 1]) b.box(lib.frameBlack, tube_ * 0.6, railH, 2 * lz - tube_, cx + sx * lx, ry, cz, { r: 0.004 });
  // lower stretchers: both short sides and the back, leaving the robot side open
  for (const sx of [-1, 1]) b.box(lib.frameBlack, tube_ * 0.7, tube_ * 0.7, 2 * lz - tube_, cx + sx * lx, 0.16, cz, { r: 0.004 });
  b.box(lib.frameBlack, 2 * lx - tube_, tube_ * 0.7, tube_ * 0.7, cx, 0.16, cz - lz, { r: 0.004 });
  b.build(g, { name: 'table-frame' });
  return g;
}

// ------------------------------------------------------------------ world

export async function createWorld(container, config, { quality = 'auto', reducedMotion = false } = {}) {
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, stencil: false, powerPreference: 'high-performance' });
  if (!gl) throw new Error('WebGL2 is not available');
  const renderer = new THREE.WebGLRenderer({ canvas, context: gl, antialias: true });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.shadowMap.autoUpdate = false;
  renderer.info.autoReset = false;
  if (getComputedStyle(container).position === 'static') container.style.position = 'relative';
  Object.assign(canvas.style, { display: 'block', width: '100%', height: '100%', touchAction: 'none' });
  container.appendChild(canvas);
  let gpu = 'unknown';
  try { const ext = gl.getExtension('WEBGL_debug_renderer_info'); gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch { /* keep unknown */ }

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1014);
  const L = layout(config);

  // environment and textures in parallel
  const pmrem = new THREE.PMREMGenerator(renderer);
  const [hdr, tex] = await Promise.all([
    new HDRLoader().loadAsync(new URL('env/small_empty_room_3_1k.hdr', ASSETS).href),
    loadTextures(renderer),
  ]);
  hdr.mapping = THREE.EquirectangularReflectionMapping;
  const envRT = pmrem.fromEquirectangular(hdr);
  hdr.dispose(); pmrem.dispose();
  scene.environment = envRT.texture;
  scene.environmentIntensity = 0.42;

  const lib = createMaterials(tex, config.SEED);
  const room = buildRoom(config, lib, L);
  const table = buildTable(config, lib);
  scene.add(room.group, table);

  // ---- lights
  RectAreaLightUniformsLib.init();
  const tcx = config.TABLE.center[0], tcz = config.TABLE.center[1], topY = config.TABLE.topY;
  const key = new THREE.DirectionalLight(0xfff0dc, 1.9);
  const keyTarget = new THREE.Vector3(tcx + 0.25, 0.45, tcz + 0.15);
  key.position.copy(keyTarget).add(new THREE.Vector3(1.0, 2.5, -1.25));
  key.target.position.copy(keyTarget);
  key.castShadow = true;
  Object.assign(key.shadow.camera, { left: -1.9, right: 1.9, top: 1.75, bottom: -1.75, near: 0.4, far: 7 });
  key.shadow.bias = -0.00012; key.shadow.normalBias = 0.0012; key.shadow.radius = 3.2;
  scene.add(key, key.target);
  const hemi = new THREE.HemisphereLight(0xf2f5fa, 0x8a7b6c, 0.25);
  scene.add(hemi);
  const rects = [];
  for (const p of room.panels) {
    const r = new THREE.RectAreaLight(0xfff1de, 4.6, p.w, p.d);
    r.position.set(p.x, L.room.h - 0.03, p.z); r.rotation.x = -Math.PI / 2;
    scene.add(r); rects.push(r);
  }
  {
    const [wx0, wx1] = L.window.x, [wy0, wy1] = L.window.y;
    const r = new THREE.RectAreaLight(0xdcebff, 3.6, wx1 - wx0, wy1 - wy0);
    r.position.set((wx0 + wx1) / 2, (wy0 + wy1) / 2, L.room.z0 + 0.02); r.rotation.y = Math.PI;
    scene.add(r); rects.push(r);
  }

  // ---- camera and controls
  const camera = new THREE.PerspectiveCamera(config.VIEWS.hero.fov, 16 / 9, 0.03, 40);
  camera.layers.enable(LAYER_OVERLAY);
  camera.position.fromArray(config.VIEWS.hero.eye);
  const controls = new OrbitControls(camera, canvas);
  controls.target.fromArray(config.VIEWS.hero.target);
  controls.enableDamping = true; controls.dampingFactor = 0.08;
  controls.minDistance = 0.18; controls.maxDistance = 4.2; controls.maxPolarAngle = Math.PI * 0.52;
  controls.zoomSpeed = 0.8; controls.rotateSpeed = 0.7;
  controls.autoRotate = false; controls.autoRotateSpeed = 1.2;
  controls.update();
  // the camera stays inside the room: past a wall the view would show the back of the wall
  const roomBox = (() => { const R = layout(config).room, m = 0.12; return { x0: R.x0 + m, x1: R.x1 - m, z0: R.z0 + m, z1: R.z1 - m, y0: 0.25, y1: R.h - 0.08 }; })();
  const clampToRoom = () => {
    const p = camera.position;
    p.x = Math.min(roomBox.x1, Math.max(roomBox.x0, p.x));
    p.y = Math.min(roomBox.y1, Math.max(roomBox.y0, p.y));
    p.z = Math.min(roomBox.z1, Math.max(roomBox.z0, p.z));
  };
  const orbitListeners = new Set();
  const setOrbit = (on) => { const v = !!on && !reducedMotion; if (controls.autoRotate === v) return; controls.autoRotate = v; orbitListeners.forEach((fn) => fn(v)); };
  controls.addEventListener('start', () => setOrbit(false));          // a drag or a wheel always stops the turntable

  // ---- post-processing
  const size = new THREE.Vector2(1, 1);
  const composer = new EffectComposer(renderer);
  const renderPass = new RenderPass(scene, camera);
  const gtao = new GTAOPass(scene, camera, 2, 2);
  gtao.blendIntensity = 1.0;
  gtao.updateGtaoMaterial({ radius: 0.07, distanceExponent: 1.2, thickness: 1.0, scale: 1.1, samples: 16, distanceFallOff: 1, screenSpaceRadius: false });
  gtao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 9, radiusExponent: 1.4, rings: 3, samples: 16 });
  // GTAOPass hides points and lines before it renders normals, but its test misses LineSegments2 (the fat lines of
  // the overlays: frustum, axes, edges). Drawn with the normal material their base quad becomes metres wide, and AO
  // paints it as a large black wedge hanging off the wrist camera. Hide every overlay object, and anything that does
  // not write depth, for that one render.
  gtao._overrideVisibility = function overrideVisibility() {
    const cache = this._visibilityCache;
    this.scene.traverse((o) => {
      if (!o.visible) return;
      const overlay = o.isPoints || o.isLine || o.isLine2 || o.isLineSegments2 || o.isSprite || o.isCSS2DObject
        || (o.layers && o.layers.mask === (1 << LAYER_OVERLAY))
        || (o.isMesh && o.material && !Array.isArray(o.material) && o.material.transparent && o.material.depthWrite === false);
      if (overlay) { o.visible = false; cache.push(o); }
    });
  };
  let aoScale = 1;
  const gtaoSetSize = gtao.setSize.bind(gtao);
  gtao.setSize = (w, h) => gtaoSetSize(Math.max(2, Math.round(w * aoScale)), Math.max(2, Math.round(h * aoScale)));
  const bloom = new UnrealBloomPass(new THREE.Vector2(256, 256), 0.22, 0.5, 3.0);      // threshold above any lit surface: only emissive parts glow
  const bokeh = new BokehPass(scene, camera, { focus: 0.6, aperture: 0.012, maxblur: 0.0045 });   // optional; focus follows the orbit target
  bokeh.enabled = false;
  const vignette = new ShaderPass({
    uniforms: { tDiffuse: { value: null }, amount: { value: 0.28 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'uniform sampler2D tDiffuse; uniform float amount; varying vec2 vUv; void main(){ vec4 c = texture2D(tDiffuse, vUv); vec2 d = vUv - 0.5; float v = smoothstep(0.25, 0.95, dot(d, d) * 2.0); gl_FragColor = vec4(c.rgb * (1.0 - amount * v), c.a); }',
  });
  const output = new OutputPass();
  const smaa = new SMAAPass();
  for (const p of [renderPass, gtao, bloom, bokeh, vignette, output, smaa]) composer.addPass(p);

  // ---- quality
  let requested = quality, level = quality === 'auto' ? 'medium' : quality;
  if (!QUALITY[level]) level = 'medium';
  let dofWanted = false;
  const auto = { frames: 0, time: 0, skip: 30, ceiling: null, settled: false };
  const lowCanvasCache = new Map();
  function applyTextureScale(low) {
    for (const t of lib.textures) {
      const full = t.userData.full;
      if (!full) continue;
      let img = full;
      if (low) {
        if (!lowCanvasCache.has(full)) {
          const c = document.createElement('canvas'); c.width = c.height = 512;
          c.getContext('2d').drawImage(full, 0, 0, 512, 512);
          lowCanvasCache.set(full, c);
        }
        img = lowCanvasCache.get(full);
      }
      if (t.image !== img) { t.image = img; t.needsUpdate = true; }
    }
  }
  function applyQuality(name) {
    level = name;
    const q = QUALITY[name];
    const pr = Math.min(window.devicePixelRatio || 1, q.pixelRatio);
    renderer.setPixelRatio(pr); composer.setPixelRatio(pr);
    if (key.shadow.mapSize.x !== q.shadow) {
      key.shadow.mapSize.set(q.shadow, q.shadow);
      if (key.shadow.map) { key.shadow.map.dispose(); key.shadow.map = null; }
    }
    key.shadow.radius = q.shadow >= 4096 ? 3.2 : q.shadow >= 2048 ? 2.4 : 1.8;
    for (const r of rects) r.visible = q.rect;
    hemi.intensity = q.rect ? 0.2 : 0.85;
    scene.environmentIntensity = q.rect ? 0.42 : 0.75;
    aoScale = q.ao || 1;
    gtao.enabled = q.ao > 0;
    if (q.ao > 0) { gtao.updateGtaoMaterial({ samples: q.aoSamples }); gtao.updatePdMaterial({ samples: q.aoSamples }); }
    bloom.enabled = q.bloom; smaa.enabled = q.smaa; vignette.enabled = q.vignette;
    bokeh.enabled = dofWanted && name === 'high';
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    for (const t of lib.textures) { const a = Math.min(q.aniso, maxAniso); if (t.anisotropy !== a) { t.anisotropy = a; t.needsUpdate = true; } }
    applyTextureScale(q.texLow);
    resize();
    listeners.quality.forEach((fn) => fn(level));
  }
  const listeners = { quality: [], resize: [] };

  function resize() {
    const w = Math.max(2, container.clientWidth), h = Math.max(2, container.clientHeight);
    size.set(w, h);
    renderer.setSize(w, h, false);
    composer.setSize(w, h);
    camera.aspect = w / h;
    applyFov();
    listeners.resize.forEach((fn) => fn(w, h));
  }

  // ---- camera presets
  let baseFov = config.VIEWS.hero.fov, preset = 'hero', follow = null, tween = null;
  function applyFov() {
    // presets are composed for a 3:2 stage or wider; on narrower stages widen the lens so the sides stay in frame
    const a = camera.aspect, k = Math.max(1, 1.5 / a);
    camera.fov = follow ? baseFov : THREE.MathUtils.radToDeg(2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(baseFov) / 2) * k));
    camera.updateProjectionMatrix();
  }
  function setCameraPreset(name, { animate = true } = {}) {
    if (name === 'free') { preset = 'free'; follow = null; tween = null; controls.enabled = true; applyFov(); return true; }
    if (name === 'wrist') {
      if (!hooks.wristCamera) return false;
      preset = 'wrist'; tween = null; follow = hooks.wristCamera; controls.enabled = false;
      baseFov = follow.userData.fovY || 60; applyFov();
      return true;
    }
    const v = config.VIEWS[name];
    if (!v) return false;
    if (follow) { follow = null; camera.up.set(0, 1, 0); }
    preset = name; controls.enabled = true;
    const to = { eye: new THREE.Vector3(...v.eye), target: new THREE.Vector3(...v.target), fov: v.fov };
    if (name === 'top') to.eye.z += 1e-3;                 // keep the up vector defined when looking straight down
    if (!animate || reducedMotion) {
      camera.position.copy(to.eye); controls.target.copy(to.target); baseFov = to.fov; applyFov(); controls.update(); tween = null;
    } else {
      tween = { t: 0, dur: 0.9, from: { eye: camera.position.clone(), target: controls.target.clone(), fov: baseFov }, to };
    }
    bokeh.enabled = dofWanted && level === 'high';
    return true;
  }
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function stepCamera(dt) {
    if (follow) {
      follow.updateWorldMatrix(true, false);
      follow.matrixWorld.decompose(camera.position, camera.quaternion, _scale);
      camera.updateMatrixWorld();
      return;
    }
    if (tween) {
      tween.t = Math.min(1, tween.t + dt / tween.dur);
      const k = ease(tween.t);
      camera.position.lerpVectors(tween.from.eye, tween.to.eye, k);
      controls.target.lerpVectors(tween.from.target, tween.to.target, k);
      baseFov = tween.from.fov + (tween.to.fov - tween.from.fov) * k; applyFov();
      if (tween.t >= 1) tween = null;
    }
    controls.update();
    clampToRoom();
    if (bokeh.enabled) bokeh.uniforms.focus.value = camera.position.distanceTo(controls.target);
  }
  const _scale = new THREE.Vector3();

  // ---- visibility and pausing
  let paused = false, onScreen = true;
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((es) => { onScreen = es[es.length - 1].isIntersecting; }, { threshold: 0.01 }) : null;
  io?.observe(container);
  const ro = 'ResizeObserver' in window ? new ResizeObserver(() => resize()) : null;
  ro?.observe(container);
  const isActive = () => !paused && onScreen && !document.hidden;

  // ---- frame
  const hooks = { wristCamera: null, beforeRender: null, afterRender: null };
  const fps = { value: 0, acc: 0, n: 0, last: 0 };
  const statsOut = { fps: 0, drawCalls: 0, triangles: 0 };
  function render(dt = 1 / 60, { force = false } = {}) {
    if (!force && !isActive()) return false;
    const now = performance.now();
    if (fps.last) {
      const d = (now - fps.last) / 1000;
      if (d < 0.5) { fps.acc += d; fps.n++; if (fps.acc >= 0.5) { fps.value = fps.n / fps.acc; fps.acc = 0; fps.n = 0; } trackAuto(d); }
    }
    fps.last = now;
    stepCamera(dt);
    renderer.info.reset();
    renderer.shadowMap.needsUpdate = true;
    hooks.beforeRender?.(dt);
    if (level === 'low') { renderer.setRenderTarget(null); renderer.render(scene, camera); } else composer.render(dt);
    statsOut.fps = fps.value; statsOut.drawCalls = renderer.info.render.calls; statsOut.triangles = renderer.info.render.triangles;
    hooks.afterRender?.(dt);
    return true;
  }
  function trackAuto(d) {
    if (requested !== 'auto' || auto.settled) return;
    if (auto.skip > 0) { auto.skip--; return; }
    auto.frames++; auto.time += d;
    if (auto.frames < 60) return;
    const avg = auto.frames / auto.time;
    auto.frames = 0; auto.time = 0; auto.skip = 30;
    const order = ['low', 'medium', 'high'], i = order.indexOf(level);
    if (avg > 55 && i < 2 && order[i + 1] !== auto.ceiling) applyQuality(order[i + 1]);
    else if (avg < 28 && i > 0) { auto.ceiling = level; applyQuality(order[i - 1]); }
    else auto.settled = true;
  }

  const world = {
    THREE, renderer, scene, camera, controls, composer, lib, layout: L, room, table, gpu, hooks,
    setOrbit, getOrbit: () => controls.autoRotate, onOrbit: (fn) => { orbitListeners.add(fn); return () => orbitListeners.delete(fn); },
    lights: { key, hemi, rects }, passes: { gtao, bloom, bokeh, vignette, output, smaa },
    render, resize, setCameraPreset,
    getCameraPreset: () => preset,
    setQuality(q) { requested = q; auto.settled = false; auto.ceiling = null; auto.frames = 0; auto.time = 0; auto.skip = 30; applyQuality(q === 'auto' ? 'medium' : (QUALITY[q] ? q : 'medium')); },
    getQuality: () => ({ requested, level }),
    setDepthOfField(on, { focus, aperture, maxblur } = {}) {
      dofWanted = !!on; bokeh.enabled = dofWanted && level === 'high';
      if (focus !== undefined) bokeh.uniforms.focus.value = focus;
      if (aperture !== undefined) bokeh.uniforms.aperture.value = aperture;
      if (maxblur !== undefined) bokeh.uniforms.maxblur.value = maxblur;
    },
    setPaused(v) { paused = !!v; if (!paused) fps.last = 0; },
    isActive,
    on(type, fn) { listeners[type]?.push(fn); },
    stats: () => ({ ...statsOut }),
    dispose() {
      io?.disconnect(); ro?.disconnect(); controls.dispose();
      scene.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      for (const t of lib.textures) t.dispose();
      envRT.dispose(); composer.dispose?.(); renderer.dispose();
      canvas.remove();
    },
  };
  applyQuality(level);
  return world;
}
