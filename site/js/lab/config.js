// Lab contract: every dimension, pose, name and default parameter lives here.
// World frame: y up, metres (three.js). Robot kinematics (kinematics.js) use the ROS frame (z up).
// The gearbox is our own design for teaching (tag: Demo). It is not the part used in the paper.
// Plain data only: this file is imported by the browser and by Node tests.

const mm = (v) => v / 1000;
const deg = (v) => (v * Math.PI) / 180;

export const SEED = 7;

// ---------------------------------------------------------------- room and table
export const ROOM = {
  size: [5.2, 2.9, 4.4],            // x, y (height), z
  center: [-0.2, 0, 0.2],           // floor centre
  windowWall: '-z',                 // wall carrying the window; door and cabinet are on '-x'
};

export const TABLE = {
  topY: 0.74,                       // height of the work surface
  size: [1.2, 0.03, 0.7],           // top slab: x, thickness, z
  center: [-0.15, 0.0],             // x, z of the slab centre  -> spans x in [-0.75, 0.45]
  legInset: 0.05,
  frameTube: 0.04,
};

// ---------------------------------------------------------------- robot
// xArm6 base frame in ROS: z up, x forward. Mounted on the mobile base, facing -x (toward the table).
export const ROBOT = {
  basePosition: [0.70, 0.52, 0.0],  // world position of the xArm base origin
  // 4x4 row-major, ROS base -> world. ROS x -> world -x, ROS y -> world +z, ROS z -> world +y.
  baseToWorld: [
    -1, 0, 0, 0.70,
     0, 0, 1, 0.52,
     0, 1, 0, 0.0,
     0, 0, 0, 1,
  ],
  // TCP at ROS (0.30, 0, 0.45), tool down: 0.23 m above the table. (The first draft, [0,-0.6,-0.6,0,1.2,0],
  // put the TCP 9 mm below the table top.)
  home: [0, -0.4694, -1.3975, 0, 1.8669, 0],
  jointVelMax: Math.PI,             // rad/s (xArm6 spec: 180 deg/s)
  jointAccMax: 20.0,                // rad/s^2 (controller default 1145 deg/s^2)
  tcpSpeedMax: 0.25,                // m/s used for Cartesian segments in the demo
  gripper: {
    strokeMax: 0.085,               // m, opening between the pads when fully open
    padSize: [0.022, 0.006, 0.038], // pad collider: width, thickness, height (m)
    closeSpeed: 0.06,               // m/s
    tcpOffset: 0.172,               // gripper base -> TCP along tool z
  },
  mobileBase: { size: [0.74, 0.34, 0.50], topY: 0.52, label: 'mobile base (simplified)' },
};

// Wrist camera (stands in for the RealSense D455). Optical frame: x right, y down, z forward.
export const CAMERA = {
  width: 640,
  height: 480,
  fx: 385, fy: 385, cx: 320, cy: 240,   // pixels (Demo values)
  near: 0.05,
  far: 3.0,
  body: [0.124, 0.029, 0.026],          // m
  // Pose of the optical frame in the gripper-base (link6 flange) frame, ROS convention.
  mount: { xyz: [0.07, 0.0, 0.035], rpy: [0, 0, Math.PI / 2] },
  defaultViews: 3,
};

// ---------------------------------------------------------------- gears, nut, cover
export const GEAR = {
  module: mm(2),
  pressureAngle: deg(20),
  faceWidth: mm(20),
  bore: mm(9.0),                    // hole diameter
  boreChamfer: mm(1.5),
  large: { teeth: 34 },             // pitch 68 mm, outside 72 mm
  medium: { teeth: 22 },            // pitch 44 mm, outside 48 mm
};

export const NUT = { acrossFlats: mm(17), height: mm(8), bore: mm(9.0), chamfer: mm(1.0) };

// Cover frame: origin on the outer bottom face directly under the green shaft, z up (ROS-like), x along the long axis.
export const COVER = {
  floor: mm(3),
  wall: mm(3),
  wallHeight: mm(10),                // shallow tray: the pads (6 mm thick) grip a layer-1 gear above the rim, not in a 6 mm slot
  bossHeight: mm(4),
  bossDiameter: mm(16),
  shaftDiameter: mm(8.0),
  shaftChamfer: mm(1.5),
  // Inner outline = convex hull of two circles (teardrop), centres on the x axis.
  outline: [
    { x: mm(56), r: mm(42) },       // red end
    { x: mm(-44), r: mm(30) },      // yellow end
  ],
  shafts: {
    shaft_red:    { x: mm(56),  y: 0, top: mm(3 + 4 + 20 + 3) },
    shaft_green:  { x: 0,       y: 0, top: mm(3 + 4 + 20 + 20 + 8 + 2) },
    shaft_yellow: { x: mm(-44), y: 0, top: mm(3 + 4 + 20 + 3) },
  },
  // World pose of the cover on the table: position of its origin (on the table top) and yaw about world y.
  world: { position: [0.24, 0.74, -0.12], yaw: deg(0) },
};

const L1 = COVER.floor + COVER.bossHeight;          // bottom face of layer-1 gears, in the cover frame
const L2 = L1 + GEAR.faceWidth;                     // bottom face of the blue gear
const L3 = L2 + GEAR.faceWidth;                     // bottom face of the nut

// Canonical parts. `name` is the paper's text prompt (Table 3). `key` is the short id used in code.
// `home` is the disassembled pose on the table (world x, z, yaw); parts lie flat, bottom face on the table.
// `seat` is the assembled pose in the cover frame: shaft and height of the bottom face.
export const PARTS = [
  { key: 'red',    name: 'red large gear',            kind: 'gear', size: 'large',  color: '#D7263D', short: 'R',
    home: { x: 0.30, z: 0.14, yaw: deg(10) }, seat: { shaft: 'shaft_red',    z: L1 }, object: 'white cover' },
  { key: 'green',  name: 'green medium gear',         kind: 'gear', size: 'medium', color: '#1E9E5A', short: 'G',
    home: { x: 0.18, z: 0.12, yaw: deg(-25) }, seat: { shaft: 'shaft_green',  z: L1 }, object: 'white cover' },
  { key: 'yellow', name: 'yellow medium gear',        kind: 'gear', size: 'medium', color: '#E8A917', short: 'Y',
    home: { x: 0.20, z: 0.21, yaw: deg(40) }, seat: { shaft: 'shaft_yellow', z: L1 }, object: 'white cover' },
  { key: 'blue',   name: 'blue large gear',           kind: 'gear', size: 'large',  color: '#1F6FD0', short: 'B',
    home: { x: 0.40, z: 0.02, yaw: deg(0) }, seat: { shaft: 'shaft_green',  z: L2 }, object: 'green medium gear' },
  { key: 'nut',    name: 'white tiny hexagonal nut',  kind: 'nut',                  color: '#E9E7E1', short: 'N',
    home: { x: 0.27, z: 0.24, yaw: deg(15) }, seat: { shaft: 'shaft_green',  z: L3 }, object: 'blue large gear' },
];

export const FIXTURES = [{ key: 'cover', name: 'white cover', color: '#E9E7E1', short: 'C' }];

// The five triples of Fig. 7 (paper). This is the reference plan.
export const PAPER_PLAN = [
  ['red large gear', 'attached to', 'white cover'],
  ['green medium gear', 'attached to', 'white cover'],
  ['yellow medium gear', 'attached to', 'white cover'],
  ['blue large gear', 'attached to', 'green medium gear'],
  ['white tiny hexagonal nut', 'attached to', 'blue large gear'],
];

// Fig. 5 relation list (paper), spelled as printed.
export const RELATIONS = ['attached to', 'wrapping', 'inside', 'screw', 'hanging from', 'goes through', 'inserted into', 'meshed with', 'below', 'above'];

// Aliases used to map free-text names in VLM output onto the canonical parts.
export const ALIASES = {
  red: ['red large gear', 'red gear', 'large red gear', 'red big gear'],
  green: ['green medium gear', 'green gear', 'medium green gear', 'green small gear'],
  yellow: ['yellow medium gear', 'yellow gear', 'medium yellow gear', 'orange gear', 'yellow small gear'],
  blue: ['blue large gear', 'blue gear', 'large blue gear', 'blue big gear'],
  nut: ['white tiny hexagonal nut', 'white nut', 'hexagonal nut', 'hex nut', 'nut', 'white hexagonal nut', 'tiny nut'],
  cover: ['white cover', 'cover', 'white box', 'box', 'housing', 'white housing', 'gearbox cover', 'white tray', 'tray', 'base'],
};

// ---------------------------------------------------------------- frames and ids (shared by sim and rig)
// Conventions the simulation core uses. The rig may build its meshes differently; index.js measures the
// offset once through rig.poseFor() and converts.
export const FRAMES = {
  // Part body frame: origin at the centre of the BOTTOM face, local +y along the bore axis, yaw about +y.
  part: 'origin: centre of bottom face; +y: bore axis',
  // Cover frame (z up) -> world (y up): world = COVER.world.position + Ry(yaw) * (x_c, z_c, -y_c).
  cover: 'world = position + Ry(yaw) * (x, z, -y)',
  // Gripper: pads close along the flange y axis (xarm_gripper URDF: knuckles rotate about x). Pad 0 is +y, pad 1 is -y.
  gripper: { closeAxis: 'y', widthAxis: 'x', approachAxis: 'z' },
};
// Values written to the object-id image by rig.capture() (Uint8). 0 = background/room/table.
export const IDS = { background: 0, cover: 1, red: 2, green: 3, yellow: 4, blue: 5, nut: 6, robot: 7, table: 8 };

// ---------------------------------------------------------------- physics
export const PHYSICS = {
  dt: 1 / 240,
  gravity: [0, -9.81, 0],
  friction: { part: 0.6, pad: 1.4, table: 0.5 },
  density: { plastic: 1100 },        // kg/m^3 (the gears and nut are treated as ABS-like plastic)
  gearSegments: 14,                  // convex blocks forming the ring around the bore
  graspOpposeAngle: deg(150),        // the two pad contact normals must be at least this far apart
  settleTime: 0.6,                   // s to wait after release before judging the step
  // ---- values found by experiment (tools/tests/README.md, "Physics tuning")
  scale: 20,                         // the Rapier world is built 20x larger (parry's manifold cache has a fixed 1 mm threshold)
  lengthUnit: 1,                     // World.lengthUnit in the scaled world (a gear is about 1 unit across)
  predictionDistance: 0.00005,       // m; larger values let speculative contacts hold a gear above the shaft
  solverIterations: 8,
  softCcd: 0,                        // m; off (same reason as predictionDistance)
  ccd: false,
  linearDamping: 0.2,                // 1/s
  angularDamping: 0.5,               // 1/s
  pitchInset: 0.0003,                // m; collision radius of a gear body = pitch radius - this, so meshed neighbours do not jam
  contactDist: 0.0002,               // m; a pad "touches" a part when the contact distance is below this
  settleSpeed: 0.003,                // m/s; a released part counts as at rest below this (and 0.1 rad/s)
  settleMax: 2.5,                    // s; give up waiting for rest after this long
};
PHYSICS.friction.shaft = 0.2;        // steel shaft against plastic bore

// Grasp and release geometry used by control.js / sim.js (Demo values, our design).
export const GRASP = {
  lift: { gear: 0.006, nut: 0.0015 },  // m; TCP (pad tips) above the part's bottom face when gripping
  squeeze: 0.0003,                     // m; extra closing after both pads touch
  minWidth: 0.004,                     // m; closing stops here if nothing was caught
  releaseClear: 0.0015,                // m; the part's bottom face is this far above the shaft top when released
  safeHeight: 0.13,                    // m above the table for joint-space transfers
  anisotropy: 1.3,                     // PCA eigenvalue ratio below which the cloud is treated as round (default jaw axis)
  defaultJawAxis: [0, 0, 1],           // world; closing direction for round parts = the cover's short axis at yaw 0
  topBand: 0.0015,                     // m; points this close to the top plane count as the top face
};

// Scene-level scan: k wrist-camera views on a circle above this point, all looking at it (Eq. 6).
export const SCAN = {
  center: [0.29, 0.74, 0.04],          // world; sees the home area and the cover together
  height: 0.36,                        // m, camera above the table
  radius: 0.08,                        // m, circle radius (k = 1 uses the centre, straight down)
  dwell: 0.15,                         // s the arm rests at each view before the shot
  voxel: 0.002,                        // m, voxel size for down-sampling the fused cloud
  minPixels: 12,                       // below this many mask pixels (at 640 px width) the part is "not detected"
  icpTopOnly: true,                    // ICP on the top faces only: the side faces seen at home and on the seat differ and bias a full-cloud fit by 3-10 mm
  icpTrim: 1,                          // fraction of closest pairs kept per ICP iteration
};

// Capsule radii for the arm links (upper arm, forearm, wrist, gripper body) and planning clearances.
export const ARM_COLLISION = { radii: [0.055, 0.045, 0.042, 0.04], handLength: 0.08, tableClearance: 0.005 };

// Oracle perception (Node tests and the sweep, no renderer): true pose plus errors of the same kind the
// image pipeline makes. Fitted to the image pipeline with tools/tests/calibrate_oracle.mjs (640x480 ray-cast
// camera, 24 seeds per cell, k = 1, 3, 6, sigma = 2 and 6 mm); see tools/tests/README.md.
// With sigma_d = depth.sigmaMm * (d / d0)^2 at the part's distance d and g = tanh(sigma_d / knee):
//   top-face centre, horizontal axes: 1-sigma = hypot(floor * g, cXZ * sigma_d / k^0.25)
//   top-face centre, height:          1-sigma = cY * sigma_d / k^0.25
//   place target (ICP) on top of the memory centre: 1-sigma = icp * g per horizontal axis, 0.2 * icp * g in height
export const ORACLE = { floor: 0.0002, cXZ: 0.15, cY: 0.06, icp: 0.00045, knee: 0.0005 };

// A step succeeds when the part rests on its seat within these limits.
export const SUCCESS = { posMm: 2.0, heightMm: 2.0, tiltDeg: 3.0 };

// ---------------------------------------------------------------- tunable parameters (lab.setParam)
// Each entry: default, min, max, step, unit, and the equation or table it belongs to.
export const PARAMS = {
  'eq7.a':            { v: 0.80, min: 0.50, max: 0.95, step: 0.01, unit: '',    ref: 'Eq. (7)' },
  'eq7.b':            { v: 0.92, min: 0.60, max: 0.99, step: 0.01, unit: '',    ref: 'Eq. (7)' },
  'eq7.c':            { v: 0.96, min: 0.70, max: 1.00, step: 0.01, unit: '',    ref: 'Eq. (7)' },
  'approach.height':  { v: 0.10, min: 0.04, max: 0.15, step: 0.01, unit: 'm',   ref: 'Eq. (7), |T|' },   // 0.15: above this the arm cannot reach P over the cover
  'depth.sigmaMm':    { v: 0.0,  min: 0.0,  max: 6.0,  step: 0.1,  unit: 'mm',  ref: 'Eq. (4), d_t' },
  'views.k':          { v: 3,    min: 1,    max: 6,    step: 1,    unit: '',    ref: 'Eq. (6), k' },
  'mask.erodePx':     { v: 0,    min: 0,    max: 8,    step: 1,    unit: 'px',  ref: 'Eq. (6), m_i' },
  'detect.threshold': { v: 0.35, min: 0.05, max: 0.95, step: 0.01, unit: '',    ref: 'Grounding DINO box threshold' },
  'camera.fx':        { v: 385,  min: 250,  max: 700,  step: 5,    unit: 'px',  ref: 'Eq. (4), K' },
  'handeye.errMm':    { v: 0.0,  min: 0.0,  max: 8.0,  step: 0.1,  unit: 'mm',  ref: 'Gamma_obj = Gamma_b^c x Gamma_grasp' },
  'icp.maxIters':     { v: 30,   min: 0,    max: 60,   step: 1,    unit: '',    ref: 'ICP [32]' },
  // 1: a triple runs only if subject AND object are parts of the scene. 0: the subject is enough; the place pose
  // comes from the subject's remembered pose (the paper's low level uses the memory [R, T], not the object name).
  'match.strict':     { v: 0,    min: 0,    max: 1,    step: 1,    unit: '',    ref: 'MSGraph nodes N and detections, §3.2' },
  'speed':            { v: 1.0,  min: 0.25, max: 3.0,  step: 0.25, unit: 'x',   ref: 'playback' },
};

// Depth noise model (Demo): sigma(d) = sigmaMm * (d / d0)^2, Gaussian, per pixel. d0 = 0.5 m.
export const DEPTH_NOISE = { d0: 0.5 };

// Synthetic detector score (Demo): score = clamp(base - occlusionPenalty * hiddenFraction - sizePenalty / sqrt(maskPixels)).
// A part is "detected" when score >= detect.threshold. This replaces Grounding DINO in the lab and is labelled as such.
export const DETECTOR = { base: 0.82, occlusionPenalty: 0.6, sizePenalty: 6.0 };

// Camera presets for lab.camera(name): eye and target in world coordinates.
export const VIEWS = {
  hero:  { eye: [-0.55, 1.30, 1.25], target: [0.25, 0.80, -0.02], fov: 38 },
  top:   { eye: [0.24, 1.75, 0.03],  target: [0.24, 0.74, 0.02],  fov: 36 },
  side:  { eye: [0.25, 0.95, 1.35],  target: [0.30, 0.82, 0.0],   fov: 34 },
  close: { eye: [-0.05, 0.98, 0.32], target: [0.24, 0.77, -0.08], fov: 32 },
  robot: { eye: [0.12, 1.22, 0.92], target: [0.74, 0.96, 0.0],  fov: 42 },   // the arm and the mobile base, not the table
};

export const UNITS = { mm, deg };
