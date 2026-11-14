# 素材與第三方程式的來源、授權

涵蓋 `site/assets/`、`site/vendor/` 與 `site/media/figures/`。網址於 2026-11-12 檢查過可開啟；Poly Haven 的七個素材代號另外用它的 API（`https://api.polyhaven.com/info/<代號>`）確認存在。

「上游版本」一欄寫「不確定」的，是檔案本身沒有帶版本資訊、repo 裡也沒有下載紀錄。

## `site/assets/`

| 路徑 | 內容 | 來源 | 授權 | 用在哪裡 |
| --- | --- | --- | --- | --- |
| `env/small_empty_room_3_1k.hdr` | 室內 HDRI，1k | Poly Haven「Small Empty Room 3」<br>https://polyhaven.com/a/small_empty_room_3 | CC0 1.0<br>https://polyhaven.com/license | `js/lab/world.js`：環境光（PMREM） |
| `textures/laminate_floor_02/` | 木紋地板 PBR 貼圖（diffuse、normal GL、ARM），1k | Poly Haven<br>https://polyhaven.com/a/laminate_floor_02 | CC0 1.0 | 地板 |
| `textures/plywood/` | 合板 PBR 貼圖，1k | Poly Haven<br>https://polyhaven.com/a/plywood | CC0 1.0 | 桌面（底紋，另由程式調成米色並加細點）、邊桌桌面 |
| `textures/painted_plaster_wall/` | 粉刷牆 PBR 貼圖，1k | Poly Haven<br>https://polyhaven.com/a/painted_plaster_wall | CC0 1.0 | 牆（只用 normal 與 roughness；顏色由程式設成白色） |
| `textures/wood_cabinet_worn_long/` | 深色舊木板 PBR 貼圖，1k | Poly Haven<br>https://polyhaven.com/a/wood_cabinet_worn_long | CC0 1.0 | 門、木櫃 |
| `textures/metal_plate/` | 金屬板 PBR 貼圖，1k | Poly Haven<br>https://polyhaven.com/a/metal_plate | CC0 1.0 | 移動底盤的上蓋板（只用 normal 貼圖做止滑紋；顏色由程式設成鋁色） |
| `textures/concrete_floor_painted/` | 塗漆水泥地 PBR 貼圖，1k | Poly Haven<br>https://polyhaven.com/a/concrete_floor_painted | CC0 1.0 | 目前沒有載入 |
| `robot/xarm6/link_base.stl`、`link1.stl`…`link6.stl` | xArm6 七個連桿的網格（公尺） | `xArm-Developer/xarm_ros`<br>https://github.com/xArm-Developer/xarm_ros<br>上游 commit 不確定 | BSD 3-Clause，Copyright (c) 2018, UFACTORY Inc.<br>全文在 `robot/LICENSE-xarm_ros.txt` | `js/lab/robot.js`：手臂 |
| `robot/gripper/*.stl`（7 個） | xArm Gripper 的網格（公尺） | 同上 | 同上 | `js/lab/robot.js`：夾爪 |
| `robot/LICENSE-xarm_ros.txt` | xarm_ros 的授權全文 | 同上 | — | 隨網格一起散布 |

夾爪各關節的原點與轉軸、xArm6 的關節原點與限位，是從 xarm_ros 的 `xarm_gripper.urdf.xacro` 與 `xarm6_default_kinematics.yaml` 抄數值到 `js/lab/robot.js`、`js/lab/kinematics.js`，沒有複製檔案。

使用時的注意：

- BSD 3-Clause 要求再散布時保留著作權聲明與授權全文，所以 `LICENSE-xarm_ros.txt` 要跟著 STL 走。
- 不用 UFACTORY 的名義替這份報告背書（授權第三條）。
- STL 在載入時做了頂點合併與折角法線（`robot.js`），檔案本身沒有改。

## 程式生成、沒有外部素材的東西

這些都在瀏覽器裡用程式建出來，沒有用任何廠商的 CAD 或圖片：

| 東西 | 在哪裡 | 說明 |
| --- | --- | --- |
| 四個齒輪、白色蓋板、鋼軸、六角螺帽 | `js/lab/parts.js` | 自己設計的教學用齒輪箱（`Demo`），不是論文裡的零件 |
| 移動底盤 | `js/lab/robot.js` | 簡化外型。論文寫 AgileX Ranger Mini 3，這個模型不是它的 CAD |
| 腕部相機 | `js/lab/robot.js` | 圓角長條加三個鏡頭。論文寫 RealSense D455，這個模型不是它的 CAD |
| 房間、桌子、門、櫃、窗、邊桌、螢幕、線材、工具箱 | `js/lab/world.js` | — |
| 桌面的米色細點貼圖、窗外的天空與遠景、螢幕待機畫面 | `js/lab/world.js`、`js/lab/rig.js` | 用 canvas 畫的 |
| Product1–5 的零件模型，以及滾珠螺桿線性模組 | `js/models/products.js` | 照論文圖 4 下半（第 5 頁）與圖 6 中間下方（第 6 頁）看得到的外型、顏色、標籤，用程式重建（`Demo`）。尺寸是從圖上估的。沒有用論文作者的 CAD，也沒有複製圖檔；齒形沿用 `js/lab/parts.js` 的漸開線函式。滾珠螺桿另外畫了圖上看不出來的外部細節：固定螺絲與沉頭孔、軸承環、刮刷環、油嘴、銑過的座面、馬達的接頭。這些是照這類線性模組常見的構造自己加的，不是論文的內容 |
| 模型檢視器的燈光、材質、地面的接觸陰影與柔光圓盤 | `js/models/viewer.js` | 環境光是 three.js 內建的 RoomEnvironment；兩張放射漸層貼圖用 canvas 畫的 |
| 實驗室工作桌：鋼架、調整腳、桌面、洞洞板、延長線插座、上層架與燈條 | `js/models/labbench.js` | 參考一般鋼架實驗桌的構造自己畫的，不是任何廠商的產品。桌面的細點與刮痕、粉體塗裝的橘皮紋、洞洞板的孔、插座面板都用 canvas 畫的 |

## 論文的圖（`site/media/figures/`）

| 路徑 | 內容 | 來源 | 授權 | 用在哪裡 |
| --- | --- | --- | --- | --- |
| `fig1.jpg`…`fig7.jpg` | 論文圖 1–7 的整張圖 | Li, Yan, Wang, Gao, *Robotics and Computer-Integrated Manufacturing* 94 (2025) 102978，https://doi.org/10.1016/j.rcim.2025.102978 | © Elsevier，保留所有權利 | 正文不再直接引用整張；只當作裁切的來源 |
| `crops/*.jpg`（13 張） | 圖 1、3、7 的照片與機器人畫面，圖 2 輸入的組裝圖，圖 4 上半與圖 6 的工程圖 | 自上列整張圖裁切 | 同上。課堂報告中為評論與說明而部分引用，每張圖說都標出處 | KP01–KP10 的 `.fig-crops` 與重繪圖裡的照片格 |

流程圖、prompt、triple 表改用 HTML 重繪，框裡的字照抄原圖（短的引文）；Product1–5 與滾珠螺桿改用程式重建的 3D（見上一節）。

## `site/vendor/`

| 路徑 | 內容 | 來源 | 授權 |
| --- | --- | --- | --- |
| `three/build/`、`three/addons/` | three.js 0.186.1（`REVISION` 186）與官方 addons | https://github.com/mrdoob/three.js | MIT，Copyright © 2010-2026 three.js authors。全文在 `three/LICENSE` |
| `rapier/rapier.js`（旁邊的 `package.json` 標 module） | `@dimforge/rapier3d-compat` 0.21.0，wasm 內嵌。上游的 `rapier.js` 本身沒有版本字串；版本記在同目錄的 `package.json`（我們放的，讓瀏覽器把它當 ES 模組）與 `docs/architecture.md` | https://github.com/dimforge/rapier.js | Apache License 2.0。全文在 `rapier/LICENSE` |
| `katex/` | KaTeX 0.16.25（`katex.min.js` 內的版本字串）、字型與 contrib | https://github.com/KaTeX/KaTeX | MIT。全文在 `katex/LICENSE`；那份檔只有 MIT 本文。字型來自上游的 katex-fonts 專案，同樣是 MIT（https://github.com/KaTeX/katex-fonts ，2026-11-14 查過 LICENSE） |

three.js 的 addons 裡有幾個檔另帶自己的授權註記（例如 `addons/libs/` 下的第三方函式庫）。這一頁沒有逐檔審過 `addons/libs/`；畫面層用到的 addons 是 controls、loaders（STL、HDR）、geometries（RoundedBox）、lights（RectAreaLightUniformsLib）、lines、postprocessing、renderers（CSS2D）、shaders、utils（BufferGeometryUtils），都是 three.js 本體的 MIT。
