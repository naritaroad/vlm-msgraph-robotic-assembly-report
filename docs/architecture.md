# Architecture

**English** | [繁體中文](zh-TW/architecture.md)

## How the files get here

The report is written in a private source repo: eleven knowledge-point fragments, per-section term and symbol data, and a build script that assembles them into `site/index.html`. Before each release the source repo builds the page, runs its link, bilingual-parity and paper-number checks plus the unit tests, and copies `site/` into this repo. This repo holds only those built files, and [the Pages workflow](../.github/workflows/pages.yml) uploads them unchanged.

`site/index.html` is therefore generated. Fix a problem by opening an issue rather than editing the HTML here; the next release would overwrite the edit.

## Site layout

```text
site/
├── index.html        report: cover, then article and stage side by side
├── lab.html          full-screen 3D lab (shares js/lab/)
├── css/              tokens.css holds every colour, size and spacing value
├── js/
│   ├── main.js       start-up: preferences → symbols → equations → stage → navigation
│   ├── ui/           preferences, settings panel, divider, navigation and sync,
│   │                 pop-up definitions, KaTeX typesetting, cover scene, timer
│   ├── stage/        live equations, lab dashboard, real photos and detections,
│   │                 scene graph, R / mR scores
│   ├── models/       procedural Product 1–5 and ball-screw models and their viewer
│   ├── metrics.js    R / mR scoring (shared with Node)
│   └── lab/          the 3D lab
│       ├── config.js       sizes, poses and default parameters (the contract)
│       ├── kinematics.js   xArm6 forward and inverse kinematics
│       ├── icp.js          centroid plus ICP
│       ├── backproject.js  Eq. (4)(5)(6)
│       ├── physics.js      Rapier world, colliders, grasp test
│       ├── control.js      trajectories, Eq. (7) waypoints, success test
│       ├── sim.js          steppable simulation
│       ├── rig.js          three.js scene, robot, overlays, wrist camera
│       └── index.js        createLab(): joins simulation and rendering
├── data/             paper.json (paper numbers), vlm/ (raw runs and summary),
│                     perception/ (Grounding DINO + SAM 2.1), lab/ (plans)
├── media/            figures, photos, 1080p muted videos with .vtt captions
├── assets/           xarm_ros meshes, HDRI, PBR textures, LICENSES.md
└── vendor/           three 0.186.1, rapier3d-compat 0.21.0, KaTeX 0.16.25
```

## Technical decisions

| Decision | Reason |
| --- | --- |
| three.js WebGLRenderer (WebGL2) with EffectComposer, not WebGPU or Unity WebGL | Has to open on classroom PCs and iPad Safari; the article and the scene talk to each other through the DOM |
| Rapier through `rapier3d-compat`, wasm inlined | One `.mjs` file, no separate wasm request, works on Pages and offline |
| Geometry generated in the browser (involute gears, rounded boxes, lathes) | Sizes come straight from `config.js`, so colliders and visuals share one source |
| Grasp holds only when both finger pads touch the part and the gripper is closed | Friction-only grasps are unstable in a real-time engine; this keeps "an off-centre grasp fails" |
| Success judged from the part's final pose, never by a random draw | The outcome follows from the physics |
| Perception computed on the 3D scene: the wrist camera renders RGB, metric depth and object IDs, then Eq. (4)–(6) and ICP run on them | Changing a parameter changes the numbers in the equations through a real data flow |
| VLM outputs recorded in advance | Pages has no backend; the raw replies are published in `site/data/vlm/raw/` |
| No framework, no bundler: native ES modules and an import map | Readable source, no Node build on Pages |
| System font stack, KaTeX's own math fonts | CJK web fonts are too large; the page stays portable and offline |

## Module boundaries

- `js/lab/` touches only the container it is given. Everything else uses the object `createLab()` returns and its events.
- `js/main.js` and `js/stage/` never reach into three.js objects; they go through the lab API.
- Article and stage are coupled only through attributes: `data-stage`, `data-enter`, `data-cue`, `data-act` and `data-bind`.
- Preferences go through `js/ui/prefs.js`; other modules do not read or write `localStorage` directly.
- Paper numbers live only in `site/data/paper.json`; the page reads them by key, such as `data-paper="table1.0.rT"`.
