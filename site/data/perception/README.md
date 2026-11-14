# Perception run: Grounding DINO + SAM 2.1 on our desk footage

This folder holds real outputs of the perception step that VLM-MSGraph (Li et al., RCIM 2025) describes in §3.2: Grounding DINO turns a text prompt into labelled boxes c_i, and a SAM-family model turns each box into a mask m_i. We ran off-the-shelf weights on our own phone footage. Nothing was fine-tuned. The prompts were written before any result was seen and were not changed afterwards.

Script: `tools/run_perception.py` (run from the repo root with the vision venv). Run date: 2026-11-12.

## What was run

| Item | Value |
| --- | --- |
| Detector | `IDEA-Research/grounding-dino-tiny`, revision `a2bb814dd30d776dcf7e30523b00659f4f141c71` |
| Segmenter | `facebook/sam2.1-hiera-small`, revision `ee5bba1d82bb8749febdf90f45e84b687142ba03`, box prompt, `multimask_output=False` |
| Library | transformers 5.20.2 (`AutoModelForZeroShotObjectDetection`, `Sam2Model` / `Sam2Processor`), torch 2.14.1+cu126, torchvision 0.29.1, OpenCV 5.0.0, Python 3.10.9 |
| GPU | NVIDIA GeForce RTX 3070 (8 GB), CUDA 12.6 |
| Thresholds | box 0.35, text 0.25 (Grounding DINO defaults); per-prompt NMS at IoU 0.5 |
| Fallback | box 0.25, stills only, only for a prompt that found nothing at 0.35. Used once: "stapler" in Scene A. |
| Query style | one phrase per call (`"<prompt>."`), so labels from different prompts cannot mix |

transformers warns that the SAM 2.1 checkpoint's config is of type `sam2_video` while we load it into the image model `Sam2Model`. All 357 weight tensors loaded and no missing-key warning appeared. The masks in the overlays follow object outlines.

Prompt deviation: the plan said "red scissors". The real scissors have grey handles, so the prompt is "scissors".

## Inputs

- Scene A still: `my_object_real_photo/Scene_1/20261112_031159675.JPG` (4000×2250). Downscaled with Lanczos to 1600×900 and saved as `site/media/perception/sceneA_still_base.jpg`.
- Scene B stills: `site/media/photo/20261112_031939410.jpg` (disassembled) and `site/media/photo/20261112_032046206.jpg` (assembled). Both are already 1600×900 and were used as they are, so `base_image` in their JSON points to those files instead of a copy.
- Scene A video: `site/media/video/scene1_sweep_1080.mp4` (1080×1920, 30 fps, 26.9 s, handheld sweep).
- Scene B video: `site/media/video/scene2_assembly_1080.mp4` (1920×1080, 30 fps, 50.5 s; a hand assembles two gel pens, then the fidget spinner).

## Outputs

| File | Content |
| --- | --- |
| `sceneA_still.json`, `sceneB_disassembled.json`, `sceneB_assembled.json` | Image size and, for each prompt, every box kept after NMS: `box` [x1,y1,x2,y2] in base-image pixels, `score`, `polygon` (largest mask contour, `cv2.approxPolyDP`, ≤60 points), `mask_area_px`, `centroid`, `mask_components` |
| `count_check.json` | Expected vs detected counts, plus a manual box-by-box check (see below) |
| `scene1_tracks.json`, `scene2_tracks.json` | Per sampled frame `t` (s): the best box per prompt (two best for "metal clip" and "small round metal cap") as [x1,y1,x2,y2,score], and the number of boxes kept (`counts`). Independent per-frame detection, with no tracking or smoothing. No masks. |
| `run_meta.json` | Model ids, revisions, versions, thresholds, timings |
| `../../media/perception/*_overlay.jpg` | All prompts on one image (boxes, 45% masks, labels). Labels overlap where prompts hit the same object. |
| `../../media/perception/*_per_prompt.jpg` | One panel per prompt, boxes numbered by rank with scores. This is the readable view. |

## Timings (RTX 3070)

- Model load: 28.4 s, including the first download.
- Stills (1600×900): about 2.0–2.4 s of detection per image for 8–9 prompts (≈0.25 s per prompt) and 0.2 s for one SAM 2.1 pass over all boxes.
- Scene A video: 54 frames at 2 fps × 9 prompts in 124 s. Scene B video: 102 frames at 2 fps × 8 prompts in 208 s. About 0.25 s per prompt per frame. 2 fps was fast enough, so no fallback to 1 fps was needed.

## Count check (box threshold 0.35)

"Detected" counts the boxes left after NMS. "Correct" and "top-1 right" come from a manual check of each box against the photo, done after the run. They are not model output.

**Scene A still** (all parts separate)

| Prompt | Expected | Detected | Correct | Top-1 right | Wrong boxes on |
| --- | --- | --- | --- | --- | --- |
| scissors | 1 | 3 | 1 | yes | wrench, alligator clip |
| silver adjustable wrench | 1 | 1 | 1 | yes | |
| silver utility knife | 1 | 1 | 1 | yes | |
| thin metal rod | 1 | 1 | 1 | yes | |
| nail clipper | 1 | 6 | 1 (rank 3) | no | spring clip (rank 1), wrench, stapler, knife, alligator clip |
| stapler | 1 | **0** | 0 | no | at the 0.25 fallback: 1 box, correct, score 0.276 |
| metal clip | 2 | 5 | 2 (ranks 2, 5) | no | wrench (rank 1), knife, nail clipper |
| small silver hexagonal nut | 6 | 6 | 6 | yes | none; all scores 0.356–0.387, just above 0.35 |
| steel ruler | 1 | 1 | 1 | yes | |

**Scene B still, disassembled**

| Prompt | Expected | Detected | Correct | Top-1 right | Wrong boxes on |
| --- | --- | --- | --- | --- | --- |
| transparent pen barrel with black clip | 1 | 3 | **0** | no | black refill, red grip, black grip |
| transparent pen barrel with red clip | 1 | 2 | 0 (1 partial) | no | red grip (rank 1); rank 2 covers only the red clip end |
| black pen refill | 1 | 3 | 1 (rank 2) | no | purple refill (0.638 vs 0.634), black grip |
| purple pen refill | 1 | 6 | 1 | yes | all five other pen parts |
| black rubber pen grip | 1 | 4 | 1 (rank 3) | no | purple refill, black refill, black-clip barrel |
| red rubber pen grip | 1 | 6 | 1 (rank 3) | no | both refills, both barrels, black grip |
| silver three-lobed spinner | 1 | 3 | 1 | yes | both caps |
| small round metal cap | 2 | 2 | 2 | yes | none |

**Scene B still, assembled.** The refills and grips sit inside or on the barrels and the caps sit on the spinner, so the expected counts of a parts-apart view do not apply directly.

| Prompt | Detected | What the boxes cover |
| --- | --- | --- |
| barrel with black clip | 3 | spinner (rank 1, 0.636), whole black pen, its clip end |
| barrel with red clip | 4 | spinner (rank 1), whole red pen, its clip end, whole black pen |
| black pen refill | 2 | whole black pen (rank 1, holds the black refill), whole red pen |
| purple pen refill | 2 | whole red pen and whole black pen, both 0.711 |
| black rubber pen grip | 2 | whole black pen (rank 1), whole red pen |
| red rubber pen grip | 2 | whole red pen (rank 1), whole black pen |
| silver three-lobed spinner | 1 | spinner |
| small round metal cap (expected 2) | 1 | the whole spinner, with the caps mounted |

## What the results show

- Single objects with a distinctive name and shape work: the rod, ruler, wrench, knife and scissors are top-1 correct, and all six nuts are found. The nut scores sit barely above the cut, so a slightly stricter threshold would lose them.
- Silver-on-silver confusion is the main failure in Scene A. "nail clipper" and "metal clip" fire on almost every shiny tool, and the top-1 box is wrong for both. "stapler" falls below 0.35.
- Transparent barrels are the main failure in Scene B. The model never boxes the black-clip barrel itself. Colour words work as loose cues, not as part identity: every pen part prompt returns most pen-shaped objects.
- The two caps work while they are separate. In the assembly video the cap prompt returns two boxes away from the spinner until about 37.5 s. From about 40 s on it returns one box that coincides with the spinner box (IoU ≈ 0.97–1.0). That matches the caps being mounted, and it also shows the detector cannot see a mounted cap as its own part.
- Video (2 fps, independent frames): every prompt returns at least one box in nearly every frame. "stapler" is the exception: 48 of 54 frames in Scene A. A box above threshold is therefore no evidence that the object is present. Over the frames, the median box count per prompt is 7 for "nail clipper" and "metal clip", 1 for "thin metal rod" (54/54 frames), and 6 for nuts (39/54 frames with exactly 6; per-frame correctness was not checked). The Scene A frames we spot-checked show the "nail clipper" top-1 box on the wrench. In Scene B, "silver three-lobed spinner" gives exactly one box in 83/102 frames, and the caps give two boxes in 74/102 frames.

## Limitations

- Phone RGB only, with no depth. Nothing here gives 3D positions.
- Handheld camera, so the viewpoint changes across frames and there is no fixed workspace frame.
- No checkerboard was filmed, so there is no camera intrinsics calibration and no metric back-projection.
- Weights are the public checkpoints, not fine-tuned on our parts.
- Prompts were fixed in advance and not tuned to the results. Better wording might change several rows.
- The video passes are per-frame detection only. SAM 2's video propagation was not used.
- The correct / top-1 columns are one person's visual check, not a labelled ground-truth set.
