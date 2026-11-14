# 架構

[English](../architecture.md) | **繁體中文**

## 檔案怎麼來的

報告在另一個私有 repo 撰寫：十一個知識點片段、各節的專名與符號資料，以及把它們組成 `site/index.html` 的建置腳本。每次發布前，私有 repo 會先建置，跑連結、雙語對稱、論文數字檢查與單元測試，再把 `site/` 複製到這個 repo。這裡只放建置好的檔案，[Pages workflow](../../.github/workflows/pages.yml) 原樣上傳。

所以 `site/index.html` 是產物。發現問題請開 issue，不要直接改這裡的 HTML，下一次發布會蓋掉。

## 網站結構

```text
site/
├── index.html        報告：封面，往下是文章與舞台雙欄
├── lab.html          全螢幕 3D 實驗室（共用 js/lab/）
├── css/              tokens.css 定義所有顏色、字級與間距
├── js/
│   ├── main.js       啟動順序：偏好 → 符號表 → 公式排版 → 舞台 → 導覽
│   ├── ui/           偏好、設定面板、分隔線、導覽與同步、說明框、KaTeX 排版、封面場景、計時
│   ├── stage/        即時公式、實驗室儀表板、實拍與偵測疊圖、場景圖、R／mR 計分
│   ├── models/       Product 1–5 與滾珠螺桿的程序化模型與檢視器
│   ├── metrics.js    R／mR 計分（瀏覽器與 Node 共用）
│   └── lab/          3D 實驗室
│       ├── config.js       尺寸、位姿、預設參數（契約）
│       ├── kinematics.js   xArm6 正、逆運動學
│       ├── icp.js          質心加 ICP
│       ├── backproject.js  式 (4)(5)(6)
│       ├── physics.js      Rapier 世界、碰撞體、夾取判定
│       ├── control.js      軌跡、式 (7) 路點、成功判定
│       ├── sim.js          可步進的模擬
│       ├── rig.js          three.js 場景、手臂、疊圖、腕部相機
│       └── index.js        createLab()：把模擬與畫面接起來
├── data/             paper.json（論文數字）、vlm/（原始輸出與彙總）、
│                     perception/（Grounding DINO + SAM 2.1）、lab/（計劃）
├── media/            論文圖、照片、附 .vtt 字幕的 1080p 靜音影片
├── assets/           xarm_ros 網格、HDRI、PBR 貼圖、LICENSES.md
└── vendor/           three 0.186.1、rapier3d-compat 0.21.0、KaTeX 0.16.25
```

## 技術決定

| 決定 | 理由 |
| --- | --- |
| three.js 的 WebGLRenderer（WebGL2）加 EffectComposer，不用 WebGPU，也不用 Unity WebGL | 教室電腦與 iPad Safari 都要開得起來；文章與場景透過 DOM 雙向連動 |
| 物理用 `rapier3d-compat`，wasm 內嵌 | 單一 `.mjs`，不用另外載 wasm，Pages 與離線都能用 |
| 幾何在瀏覽器裡生成（漸開線齒輪、圓角盒、車削） | 尺寸直接來自 `config.js`，碰撞體與外觀同源 |
| 兩指墊片都碰到零件且夾爪閉合，才算夾住 | 純摩擦夾持在即時引擎裡不穩；這樣保留了「夾偏就夾不到」 |
| 成功與否看零件最後的位姿，不擲骰子 | 結果由物理決定 |
| 感知在 3D 場景上實算：腕部相機渲染 RGB、公尺深度與物件 ID，再跑式 (4)–(6) 與 ICP | 調參數會經由真的資料流改變式子裡的數字 |
| VLM 輸出事先跑好 | Pages 沒有後端；原始回覆公開在 `site/data/vlm/raw/` |
| 不用框架與打包工具，原生 ES modules 加 import map | 原始碼能直接讀；Pages 不需要 Node 建置 |
| 用系統字體堆疊，數學字型由 KaTeX 自帶 | 中文網頁字型太大；頁面保持可攜、可離線 |

## 模組邊界

- `js/lab/` 只碰交給它的容器，其他模組只用 `createLab()` 回傳的物件與事件。
- `js/main.js` 與 `js/stage/` 不直接碰 three.js 物件，只透過實驗室 API。
- 文章與舞台只靠屬性耦合：`data-stage`、`data-enter`、`data-cue`、`data-act`、`data-bind`。
- 偏好只經過 `js/ui/prefs.js`，其他模組不直接讀寫 `localStorage`。
- 論文數字只放在 `site/data/paper.json`，頁面用鍵取值，例如 `data-paper="table1.0.rT"`。
