// Off-screen capture from the wrist camera: RGB, linear depth and object id.
//
// Conventions (the simulation layer relies on these):
//   - Pixel (u, v): u to the right, v down, origin at the TOP-LEFT pixel. Arrays are row-major: index = v * width + u.
//   - Pixel centres sit on integer (u, v) (OpenCV convention). So for the stored pixel (u, v) with depth d:
//         P_cam = d * K^-1 * [u, v, 1]^T        (Eq. 4)        no half-pixel correction needed
//   - depth: Float32, metres ALONG THE OPTICAL AXIS (camera-frame z, not the ray length), written by a shader as
//     view-space z. It is not read from the non-linear depth buffer. Pixels with nothing between near and far hold 0.
//   - id: Uint8, values from config.IDS (0 = background: room, furniture; the robot and the table have their own ids).
//   - rgb: Uint8 RGBA, sRGB, tone-mapped like the stage.
//   - camToWorld: 4x4 row-major, optical frame (x right, y down, z forward) to world.
//   - K = [fx, 0, cx, 0, fy, cy, 0, 0, 1]. At a size other than CAMERA.width x CAMERA.height, K is rescaled.

import * as THREE from 'three';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { projectionFromK } from './robot.js';

const VERT = /* glsl */`
#include <common>
varying float vViewZ;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  vViewZ = -mvPosition.z;
}`;
const FRAG = /* glsl */`
uniform float uId;
uniform float uFar;
varying float vViewZ;
vec4 pack32(float v) {
  vec4 e = fract(v * vec4(1.0, 255.0, 65025.0, 16581375.0));
  e -= e.yzww * vec4(1.0 / 255.0, 1.0 / 255.0, 1.0 / 255.0, 0.0);
  return e;
}
void main() {
  #if MODE == 0
    gl_FragColor = vec4(vViewZ, uId, 0.0, 1.0);
  #elif MODE == 1
    gl_FragColor = pack32(clamp(vViewZ / uFar, 0.0, 0.99999994));
  #else
    gl_FragColor = vec4(uId / 255.0, 0.0, 0.0, 1.0);
  #endif
}`;

export function createCapture({ renderer, scene, robot, config }) {
  const cam = robot.wristCamera;
  const C = config.CAMERA;
  const floatOK = renderer.capabilities.isWebGL2 !== false && renderer.extensions.has('EXT_color_buffer_float');
  const out = new OutputPass();
  out.renderToScreen = false;
  const targets = new Map();
  const mats = [new Map(), new Map(), new Map()];           // per mode: id -> material
  const matFor = (mode, id) => {
    if (!mats[mode].has(id)) {
      mats[mode].set(id, new THREE.ShaderMaterial({
        vertexShader: VERT, fragmentShader: FRAG, defines: { MODE: mode }, side: THREE.DoubleSide,
        uniforms: { uId: { value: id }, uFar: { value: C.far } }, blending: THREE.NoBlending,
      }));
    }
    return mats[mode].get(id);
  };
  const getTargets = (w, h) => {
    const k = `${w}x${h}`;
    if (!targets.has(k)) {
      const opt = { minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, depthBuffer: true, stencilBuffer: false, generateMipmaps: false };
      targets.set(k, {
        hdr: new THREE.WebGLRenderTarget(w, h, { type: THREE.HalfFloatType, samples: 4, depthBuffer: true, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter }),
        ldr: new THREE.WebGLRenderTarget(w, h, { ...opt, depthBuffer: false }),
        data: floatOK ? new THREE.WebGLRenderTarget(w, h, { ...opt, type: THREE.FloatType }) : null,
        packed: new THREE.WebGLRenderTarget(w, h, opt),
        f32: floatOK ? new Float32Array(w * h * 4) : null, u8: new Uint8Array(w * h * 4),
      });
    }
    return targets.get(k);
  };
  const idOf = (o) => { for (let p = o; p; p = p.parent) if (p.userData.captureId !== undefined) return p.userData.captureId; return 0; };
  const _clear = new THREE.Color();

  /**
   * @param {{width?:number,height?:number,rgb?:boolean,packed?:boolean}} o  packed forces the 8-bit fallback path (for testing).
   */
  function capture({ width = C.width, height = C.height, rgb: wantRgb = true, packed = false } = {}) {
    const w = Math.round(width), h = Math.round(height);
    const T = getTargets(w, h);
    const base = robot.getIntrinsics();
    const sx = w / base.width, sy = h / base.height;
    const K = { fx: base.fx * sx, fy: base.fy * sy, cx: (base.cx + 0.5) * sx - 0.5, cy: (base.cy + 0.5) * sy - 0.5, width: w, height: h, near: base.near, far: base.far };
    const savedProj = cam.projectionMatrix.clone(), savedInv = cam.projectionMatrixInverse.clone();
    projectionFromK(K, cam.projectionMatrix);
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    robot.sync();
    scene.updateMatrixWorld();
    const camToWorld = robot.getCameraMatrix();

    const prevTarget = renderer.getRenderTarget(), prevAuto = renderer.autoClear, prevAlpha = renderer.getClearAlpha();
    renderer.getClearColor(_clear);
    const prevBg = scene.background, prevInfo = renderer.info.autoReset;
    renderer.autoClear = true;

    // --- RGB
    const rgbOut = new Uint8Array(w * h * 4);
    if (wantRgb) {
      renderer.setRenderTarget(T.hdr);
      renderer.setClearColor(0x000000, 1);
      renderer.render(scene, cam);
      out.render(renderer, T.ldr, T.hdr);
      renderer.readRenderTargetPixels(T.ldr, 0, 0, w, h, T.u8);
      for (let y = 0; y < h; y++) rgbOut.set(T.u8.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    }

    // --- depth + id: swap every visible mesh to a flat data material
    const swapped = [];
    scene.traverseVisible((o) => { if (o.isMesh && o.layers.test(cam.layers)) swapped.push([o, o.material, idOf(o)]); });
    const hidden = [];
    scene.traverse((o) => { if ((o.isLine || o.isPoints || o.isSprite) && o.visible) { hidden.push(o); o.visible = false; } });
    scene.background = null;
    const depth = new Float32Array(w * h), id = new Uint8Array(w * h);
    const pass = (mode, target) => {
      for (const [o, , i] of swapped) o.material = matFor(mode, i);
      renderer.setRenderTarget(target);
      renderer.setClearColor(0x000000, 0);
      renderer.render(scene, cam);
    };
    if (floatOK && !packed) {
      pass(0, T.data);
      renderer.readRenderTargetPixels(T.data, 0, 0, w, h, T.f32);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4, dst = y * w;
        for (let x = 0; x < w; x++) { depth[dst + x] = T.f32[src + x * 4]; id[dst + x] = Math.round(T.f32[src + x * 4 + 1]); }
      }
    } else {
      pass(1, T.packed);
      renderer.readRenderTargetPixels(T.packed, 0, 0, w, h, T.u8);
      const far = C.far;
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4, dst = y * w;
        for (let x = 0; x < w; x++) {
          const i = src + x * 4;
          depth[dst + x] = (T.u8[i] / 255 + T.u8[i + 1] / 65025 + T.u8[i + 2] / 16581375 + T.u8[i + 3] / 4228250625) * far;
        }
      }
      pass(2, T.packed);
      renderer.readRenderTargetPixels(T.packed, 0, 0, w, h, T.u8);
      for (let y = 0; y < h; y++) {
        const src = (h - 1 - y) * w * 4, dst = y * w;
        for (let x = 0; x < w; x++) id[dst + x] = T.u8[src + x * 4];
      }
    }
    for (const [o, m] of swapped) o.material = m;
    for (const o of hidden) o.visible = true;
    scene.background = prevBg;
    renderer.setRenderTarget(prevTarget);
    renderer.setClearColor(_clear, prevAlpha);
    renderer.autoClear = prevAuto;
    renderer.info.autoReset = prevInfo;
    cam.projectionMatrix.copy(savedProj); cam.projectionMatrixInverse.copy(savedInv);

    return {
      width: w, height: h, rgb: rgbOut, depth, id,
      K: [K.fx, 0, K.cx, 0, K.fy, K.cy, 0, 0, 1],
      camToWorld,
      near: K.near, far: K.far, depthBackground: 0, depthPath: floatOK && !packed ? 'float32' : 'packed-rgba8',
    };
  }

  return {
    capture, floatOK,
    dispose() {
      for (const t of targets.values()) { t.hdr.dispose(); t.ldr.dispose(); t.data?.dispose(); t.packed.dispose(); }
      for (const m of mats) for (const x of m.values()) x.dispose();
      out.dispose?.();
    },
  };
}

// ------------------------------------------------------------------ pinhole helpers (row-major 4x4, K as 9 numbers)

/** World point -> { u, v, d } (d: depth along the optical axis). */
export function projectPoint(K, camToWorld, P) {
  const m = camToWorld;
  const dx = P[0] - m[3], dy = P[1] - m[7], dz = P[2] - m[11];
  const x = m[0] * dx + m[4] * dy + m[8] * dz, y = m[1] * dx + m[5] * dy + m[9] * dz, z = m[2] * dx + m[6] * dy + m[10] * dz;
  return { u: (K[0] * x) / z + K[2], v: (K[4] * y) / z + K[5], d: z };
}

/** Pixel + depth -> world point. Eq. (4) then Eq. (5). */
export function backProject(K, camToWorld, u, v, d) {
  const x = ((u - K[2]) / K[0]) * d, y = ((v - K[5]) / K[4]) * d, z = d, m = camToWorld;
  return [m[0] * x + m[1] * y + m[2] * z + m[3], m[4] * x + m[5] * y + m[6] * z + m[7], m[8] * x + m[9] * y + m[10] * z + m[11]];
}
