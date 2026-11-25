# Spec #59 exploration notes — Motion Preview upgrade (Preview Scene + two cameras)

Ground truth checked on `main` @ `78d3e21` (2025-11-25). Every claim below
was verified against the code at the cited paths.

## The one idea

Today the Motion Preview has **one seam at the wrong place**: the
Generation outcome carries *projected pixel frames* (`previewFrames`
= `renderMotionPreviewFrames` output in `src/export/motion-preview.ts`),
and the playback dialog paints exactly those rasterized pixels
(`rasterizePreviewFrame` + `MOTION_PREVIEW_PALETTE` → `putImageData`,
`src/ui/MotionPreviewDialog.tsx`). The upgrade moves the seam back one
step: a **Preview Scene document in millimetres** (`buildPreviewScene`,
new `src/export/preview-scene.ts`) rides the outcome; the GIF renderer
(export layer, fixed isometric camera) and the dialog (ui layer, new
interactive Orbit Camera) are two consumers of the *same* document.
Contract changes from «dialog paints the GIF's pixels» to «both render
one scene through two cameras».

## How the current code actually works (what the Tickets build on)

- `src/export/motion-preview.ts` exports: `MOTION_PREVIEW_MAX_FRAMES`
  (300), `MOTION_PREVIEW_WIDTH`/`HEIGHT` (480/360), `MOTION_PREVIEW_COLORS`
  (7 stable palette indices: background 0, robot 1, trajectory 2,
  travelled 3, tcp 4, ptpTrace 5, home 6), `MOTION_PREVIEW_PALETTE`
  (256 entries: the 7 colors, then web-safe 6×6×6 cube, then gray ramp),
  types `PreviewPrimitive` (`solid|dashed|dot`, pixel points, colorIndex,
  width), `MotionPreviewFrame` (`tMs` + primitives), `MotionPreviewInput`
  (trajectory/plan/model), and functions `renderMotionPreviewFrames`
  → `renderMotionPreviewGif` → `rasterizePreviewFrame`.
- The frame renderer's internals that the scene builder must absorb:
  `samplePlanRows` (one row per row, capped 300 by even index spacing
  `Math.round(i*(n-1)/299)`), `ptpSegmentIndices` (point Segments with
  `motionType === "PTP"`), `segmentPolylines` (consecutive same-
  `segmentIndex` runs of `discretizeTrajectory` samples; merged-away
  Segments contribute no polyline), `collectTraceRuns` (runs of
  consecutive rows with the same PTP `row.segmentIndex`), `nearestSample`
  (argmin squared 3D distance), `appendTravelled` (LIN ranges only;
  completion judged against `min(range.endMs, plan.durationMs)` with
  `TIME_SLACK_MS = 1e-9`; mid-range cut = nearest polyline sample to the
  frame's FK TCP; skip counts < 2), `appendTrace` (trace run indices
  ≤ frameIndex, ≥ 2 points).
- Chains: `model.chainPoints(row.q)` → `joints.length + 2` mm points
  (ADR 0018 seam; MiKo-mini: base foot, shoulder, elbow, wrist, TCP —
  `src/kinematics/miko-mini.ts`). TCP = last chain point (per-frame FK).
- Fit: `fitProjection` projects all scene points with `projectIsometric`
  (`src/export/charts.ts`: `right = (x−y)·cos30`, `up = z + (x+y)·sin30`),
  pads degenerate extents via `domain()`, one uniform mm→px scale inside
  `MARGIN_PX = 12`, y flipped, `Math.round` to whole pixels.
- Raster: pure-integer Bresenham + `width`×`width` block pen; dashes are
  pixel-step counted (`step % 7 < 4`); disc fill for dots. Background
  fill first, primitives in draw order.
- GIF: `src/export/gif.ts` `encodeGif` — pure GIF 89a, global 256
  palette, NETSCAPE2.0 loop, per-frame `delayCs = max(2, round(durationMs
  / frames / 10))`. Test-side decoder `decodeGifFrames` in
  `gif-test-support.ts` pins structure/delays/pixels independently.
- Pipeline: `runPipeline` (`src/export/pipeline.ts`) renders the GIF in
  the `export` stage, `PipelineResult.motionGif` bytes; detail text
  mentions frame count/bytes/`robot_motion.gif`. App writes them as
  `robot_motion.gif` (`src/app/export-ipc.ts`, `MOTION_GIF_FILE`).
- UI: `src/ui/generation.ts` — session binds model + spline planner once;
  `ok` outcome carries `charts` **and** `previewFrames` (rendered
  separately by `renderMotionPreviewFrames` from the same inputs).
  `src/ui/App.tsx` reads `generation.previewFrames`, disables the
  «Предпросмотр движения…» button while null, passes `frames` +
  `result.plan.durationMs` to the dialog. Dialog: wall-clock rAF loop,
  `frameIndexAt` (`src/ui/preview-playback.ts`), rasterize→palette→
  ImageData, «Пуск»/«Пауза», scrub, readout, Esc/«Закрыть», restart from
  frame 0 after end.
- Camera prior art: `src/ui/canvas/transform.ts` — immutable `Camera`
  record + pure mapping from a live `Viewport`, clamped zoom
  (`MIN/MAX_PX_PER_MM`), headless tests in `transform.test.ts`. ADR 0007.
- Plan data: `MotionPlan = { rows (20 ms grid), ranges (one per Segment
  with a positive length span, chaining end→start; `endMs` exclusive),
  durationMs (grid-rounded) }` — `src/motion/planner.ts`. A PTP Move is
  discretized at endpoint poses only (ADR 0016), so its polyline is 1–2
  samples spanning the hop's chord (dashed semantics, not guaranteed
  geometry).

## Ticket breakdown and ordering

| # | Deliverable | Depends on |
|---|---|---|
| 61 | `preview-scene.ts` seam + mm golden tests; motion-preview consumes the scene (behavior-preserving) | — |
| 62 | GIF look: 800×600, panes/grid, time gradient, AA raster; deliberate golden re-pin | 61 |
| 63 | `src/ui/orbit-camera.ts` pure functions + headless tests | — (independent) |
| 64 | Scene on the outcome; dialog renders through the Orbit Camera; retire exact-pixels contract | 61, 63, 62's stable renderer |
| 65 | ADR 0023 + GLOSSARY (docs only) | all above |

Suggested wave order: **61 → {62, 63 in parallel} → 64 → 65**.
(#65's ADR must describe the implemented state; #64 retires the
`rasterizePreviewFrame` export that #62's tests still exercise.)

## Decisions every Ticket must follow

1. **Layer discipline** (`src/layers.test.ts`): `preview-scene.ts` lives
   in `export` and may import only `core`, `kinematics`, `motion`.
   `orbit-camera.ts` lives in `ui` (may import `export` — use
   `../export/charts` `projectIsometric`/`domain` so the default view is
   literally the same code as the GIF camera). No DOM/canvas/three.js in
   export; ui never imports `node:`/`electron`.
2. **No new runtime dependencies; no three.js** (ADR 0004 stance). The
   Orbit Camera is hand-rolled in the ADR 0007 camera tradition: pure
   functions of explicit inputs, immutable record state.
3. **Golden discipline (ADR 0006/0018)**: changing projected pixels,
   palette, draw order, frame size is a deliberate golden re-pin,
   hand-verified — never an accidental diff. #61 must NOT change any
   pixel (existing motion-preview tests pass *unchanged*); #62 re-pins
   them once; #65 documents the change.
4. **Pacing untouched everywhere**: 300-frame budget, even row sampling,
   `durationMs`-paced delays, `frameIndexAt` wall-clock selection,
   stop-on-final-frame. `src/ui/preview-playback.test.ts` stays
   byte-untouched (widen `frameIndexAt`'s element type structurally).
5. **Visual semantics kept in both renderers**: PTP geometry dashed;
   travelled highlight thicker over the gradient; robot links thicker
   than the Trajectory; TCP/PTP-trace/Home distinct colors; **no text in
   any render** (ADR 0013 font argument — panes/grid replace labels).
6. **Time-gradient times are a schedule cue, not the profile**: per-sample
   plan time derived linearly from `plan.ranges` over the segment's arc
   length (`t = startMs + (s − sStart)/(sEnd − sStart)·(endMs − startMs)`),
   pinned by golden tests (the real S-curve is nonlinear — the travelled
   highlight stays honest via nearest-sample-to-FK-TCP instead).
7. **Determinism**: identical input → byte-identical GIF; identical
   records/projections from identical camera call sequences. No
   randomness, no wall-clock input to render math.
8. **Doc-claims-in-the-same-commit** (CODING_STANDARDS): when #64 retires
   the exact-pixels contract, update the JSDoc of motion-preview.ts,
   preview-playback.ts, generation.ts, App.tsx headers that still say
   "the dialog paints exactly the GIF's pixels". ADR edits wait for #65.

## Risks / pitfalls

- **AA vs 256-color palette**: anti-aliased edges produce blended colors
  that must map deterministically onto palette indices (nearest match).
  The current palette padding (web-safe cube + gray ramp) is coarse;
  #62 must grow the palette deliberately (keep indices 0–6 and their RGB
  stable — the "starts the palette with the preview colors in contract
  order" test pins them) and keep the total ≤ 256.
- **Perf in tests**: 300 frames × 800×600 px with a supersampling
  rasterizer runs ~100× the current pixel volume; keep the supersample
  factor small (2–3) or use coverage math; keep the existing per-test
  GIF round-trips green without timeouts.
- **Pane/grid geometry needs a new primitive kind** (polygon fill) or
  drawing panes directly in the rasterizer; keep `PreviewPrimitive`
  additive and document the draw order (panes → grid → trajectory →
  travelled → traces → robot → dots).
- **#62 × #64 file overlap**: #62 re-pins motion-preview tests that use
  `rasterizePreviewFrame`; #64 removes that export from
  `src/export/index.ts` (keep the function internal to the GIF renderer;
  motion-preview.test.ts imports `./motion-preview` directly, so its
  tests survive the index-export removal).
- **Dialog canvas size in #62**: the dialog reads
  `MOTION_PREVIEW_WIDTH/HEIGHT` constants, so 800×600 flows through with
  no dialog edit — do not hardcode 480×360 anywhere new.
- **Bounds must cover everything**: scene bounds = mm bbox over
  trajectory polylines + all chain points (the whole robot sweep) + Home
  Point. Both cameras fit against this one box; omitting chains makes the
  fixed-camera GIF clip the skeleton at 800×600 margins.
- **PTP polylines can be 1 sample** (merged hop or zero-length Point):
  travelled counts < 2 are skipped; trace runs need ≥ 2 indices; dashed
  stroking of a 1-point polyline must be a no-op (current behavior).
- **`plan.ranges` ↔ Segment correspondence**: one range per Segment with
  a positive span; a Segment whose samples merged away has no range and
  no polyline — time mapping must tolerate that.
- **Wheel events in React are passive**: `onWheel` cannot
  `preventDefault`; the dialog will need a non-passive listener attached
  via ref/effect for zoom.
