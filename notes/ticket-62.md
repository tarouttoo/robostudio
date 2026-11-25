# Ticket #62 — Richer fixed-camera GIF look (800×600, panes/grid, gradient, AA)

Goal: the GIF gets the matplotlib-mplot3d-spirit look while staying a
pure, byte-deterministic export-layer render. This is a **deliberate
golden re-pin** (ADR 0018's consequences discipline): re-derive the
frame-0 golden once, hand-verify, commit. Camera, pacing, 300-frame
budget, and the `gif.ts` encoder are untouched. `src/ui/**` untouched
(the dialog follows automatically via the `MOTION_PREVIEW_*` constants).

## Approach (in `src/export/motion-preview.ts`, consuming the scene)

1. **Frame size**: `MOTION_PREVIEW_WIDTH = 800`, `MOTION_PREVIEW_HEIGHT =
   600`. Everything fit-derived reads these constants — check no 480/360
   literals survive (the `keeps every pixel inside the frame` test
   hardcodes `480`/`360`; update it).

2. **Palette growth, indices 0–6 stable**: keep
   `MOTION_PREVIEW_COLORS.background…home` at 0–6 with the exact same RGB
   (the palette-contract test pins `PALETTE[i]` RGB). Append:
   background/pane/grid grays (distinct light grays), a fixed
   viridis-like time-gradient ramp (32–64 entries — enough for a smooth
   gradient after AA nearest-mapping), and distinct entries already
   covered by 1–6 for robot/travelled/tcp/ptpTrace/home. Keep total ≤ 256
   (the existing padding logic fills the rest deterministically). Expose
   the ramp as a small API the dialog will mirror in spirit in #64 (e.g.
   `MOTION_PREVIEW_TIME_RAMP: readonly number[]` of palette indices, plus
   a `timeToRampIndex(tMs01)`-style pure helper if useful).

3. **Panes + grid behind everything**: from the scene bounds' mm box,
   project the back panes (the three box faces facing away from the
   camera under `projectIsometric` — determine "back" deterministically
   from the projected corners) and draw: light pane fills, then light
   grid lines at fixed mm steps. Decide and **document** the step rule
   (e.g. a nice-step function of the bounds extent, deterministic). No
   text anywhere (ADR 0013). The projected polygon fill needs a new
   raster capability — either a new additive `PreviewPrimitive` kind
   (`fill`) or an internal pane-drawing step in the rasterizer; keep the
   primitive contract additive and pin the draw order:
   background → panes → grid → trajectory gradient → travelled →
   ptp trace → robot (thicker) → tcp/home dots.

4. **Time-gradient Trajectory**: color each trajectory polyline sample by
   its per-sample `tMs` from the scene (normalized by the plan's
   duration) through the ramp. This breaks the "one colorIndex per
   primitive" shape for trajectory strokes — either emit per-sample
   short primitives, per-runs of the same ramp color, or teach the
   rasterizer per-point colors. Prefer the minimal-contract change
   (per-color runs are wasteful; per-point colorIndex arrays on the
   primitive is the cleanest — additive field, existing tests updated
   once in the re-pin). Keep PTP segment polylines dashed, LIN solid.

5. **Deterministic AA rasterizer**: replace Bresenham + block pens with
   deterministic float-math stroking. Simplest robust option: fixed-factor
   supersampling (S = 2 or 3) — draw integer blocks on the S·800 × S·600
   grid exactly as today (proven code path), then box-downsample into
   float coverage and map each blended RGB to the nearest palette entry
   (deterministic tie-breaking: first index with minimal squared RGB
   distance). Watch:
   - dashes: today counted in pixel steps (`step % 7 < 4`); re-parameterize
     dashes by polyline arc length so the pattern is resolution-
     independent and stable (pin it in the golden).
   - robot links thicker (width 3–4) than the trajectory; travelled
     highlight thicker than the gradient under it.
   - every pixel stays inside the frame (clipping already exists — keep).
   - perf: 300 frames × 800×600 at S=3 ≈ 346M sub-pixel ops per GIF in
     tests; keep S small or downsample per frame; the round-trip decoder
     tests must stay comfortably fast.

6. **Keep the seams**: `renderMotionPreviewGif` returns the same
   `{ bytes, frameCount }`; pipeline/export-ipc shape untouched; delay
   pacing unchanged (`max(2, round(durationMs/frames/10))`).

## Files

- Changed: `src/export/motion-preview.ts`, `src/export/motion-preview.test.ts`
- Possibly: `src/export/pipeline.test.ts` (detail-text expectations only)
- Untouched: `src/export/gif.ts`, `src/export/preview-scene.ts`,
  `src/ui/**`

## Test seams

- **Golden re-pin** (hand-verify before committing): re-derive the frame-0
  golden for `LINE_SCENE` + `LINE_PLAN` at 800×600 with panes/grid/
  gradient — verify against the projection (`iso()` helper) and fit
  formulas by hand, as the current golden's comment requires. Keep the
  same structure style: primitive order, kinds, widths, exact points.
- Pixel-sample assertions on decoded GIF frames
  (`decodeGifFrames` from `gif-test-support.ts`) pin at known
  coordinates: background corner, pane gray, grid line, gradient colors
  at both ends of the trajectory, travelled highlight, robot, home dot.
- Round-trip structure/pacing tests keep passing (update expected
  dimensions via constants): frame count, even delay, 300-frame budget on
  the long plan, delays `0.02` s on the 100 ms plan.
- Determinism: byte-identical GIFs for identical input (also in
  `pipeline.test.ts`); two `rasterizePreviewFrame` calls of one frame
  identical.
- The `rasterizes the frames the dialog consumes…` test stays (it pins
  GIF decode == rasterize output) until #64 retires the dialog contract.
- `src/layers.test.ts` stays green (no DOM/canvas imports).

## Pitfalls

- Palette nearest-mapping is where determinism usually dies: no
  `Math.random`, no floating sort instability (ties → lowest index), and
  blended colors must land on entries that actually exist in the 256
  table — grow the table so edge blends of your inks don't snap to
  garbage colors.
- Don't let the gradient touch the travelled highlight, robot, tcp, or
  trace colors — they must stay visually distinct per the Spec's visual
  semantics (user stories 5, 10, 11).
- The dialog test `shows the shared renderer's canvas at the GIF's frame
  size` reads the constants — it will pass automatically; do not edit
  dialog tests here.
- Two GIFs in `pipeline.test.ts` pin byte-determinism — they re-render at
  800×600 now; runtime is fine but keep an eye on total suite time.

Gate: `npm run typecheck` && `npm test`, `src/layers.test.ts` green.
