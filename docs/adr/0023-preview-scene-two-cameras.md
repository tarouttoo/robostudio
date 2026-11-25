# One Preview Scene feeds two cameras: the GIF renders fixed, the dialog orbits

The Motion Preview upgrade moved the preview's seam one step back, into
millimetre space. The Generation outcome no longer carries projected
pixel frames that the playback dialog replays verbatim; it carries the
**Preview Scene** — one headless scene document in millimetres,
assembled at Generation time by pure functions from the Trajectory, its
Motion Plan, and the Robot Model — and two renderers consume that one
document: the exported GIF draws it through the charts' fixed isometric
camera (ADR 0013), the playback dialog draws it through a hand-rolled
interactive **Orbit Camera**. The contract changes from «the dialog
paints exactly the GIF's pixels» to «the dialog and the GIF render the
same Preview Scene through two cameras». This ADR supersedes the
affected statements of ADR 0018 and records what there still stands.

## The seam moves back one step: the outcome carries a scene, not pixels

ADR 0018's outcome carried the GIF's projected pixel frames, and the
dialog rasterized exactly those frames: faithful to the GIF, but frozen
— the operator could not rotate or zoom to inspect the motion. The seam
now sits earlier, where nothing is projected yet: `buildPreviewScene`
(`src/export/preview-scene.ts`) assembles, by pure functions, one
document carrying

- per-Segment polylines of the drawn Trajectory with a plan time per
  sample — derived linearly in arc length as a schedule cue for the
  renderers' time-gradient coloring (the Motion Profile is nonlinear in
  time, so this is not a plan row time);
- at most 300 sampled plan moments (the existing pacing budget), each
  with the robot chain skeleton (`RobotModel.chainPoints`,
  `joints.length + 2` points — the ADR 0018 seam), the TCP position
  (per-frame forward kinematics), and the travelled extent per plan
  range;
- the PTP TCP trace runs — a PTP Move guarantees only arrival, so its
  actual TCP path is the FK path (ADR 0016, ADR 0017);
- the Home Point and the scene bounds — the box every camera of the
  scene fits against.

Pure millimetre-space data: no projection, no rasterization, no DOM or
canvas work — turning the document into pixels is a renderer's job.
The pipeline result carries it (`PipelineResult.previewScene`), the ok
outcome hands it to the UI (`GenerationOutcome.ok.previewScene`), and
identical inputs yield identical documents — pinned by golden tests of
the scene's millimetre geometry, ADR 0006's discipline applied one
level earlier than the bytes. This supersedes ADR 0018's pixel-frame
seam.

## Two cameras over one scene

The new contract: **the dialog and the GIF render the same Preview
Scene through two cameras.** What the operator explores interactively
and what they share are the same scene, never two diverging renderings.

- The GIF renders the scene through the fixed charts' isometric
  projection (`projectIsometric`, ADR 0013). The camera stays fixed on
  purpose: the animation communicates the robot's motion, and a moving
  camera would confuse the depth it is meant to show.
- The dialog renders the same scene through the **Orbit Camera**
  (`src/ui/orbit-camera.ts`): pointer drag orbits (yaw around +Z, pitch
  clamped inside the poles), the wheel dollies, «Вписать» and a
  double-click reset. It is pure functions over an immutable record —
  no DOM, no canvas, no time, no state outside the passed record — in
  the drawing-canvas camera's tradition (ADR 0007): one uniform mm→px
  scale (equal aspect, ADR 0007's anti-distortion rule), the viewport
  measured live on every resize (the reactive-transform rule). Its
  default angles reproduce the charts' isometric convention, so the
  reset view is exactly the GIF's fixed camera. No three.js and no new
  runtime dependency (ADR 0004's dependency stance): hand-rolled math,
  pinned by headless pure-function tests (default fit, orbit from a
  drag delta, zoom, reset).

The dialog repaints the whole scene on every animation frame and every
camera move, depth-sorted far-to-near (painter's algorithm, stable on
ties) onto the 2D canvas with the canvas's own anti-aliasing. The GIF's
raster and palette are not involved there: the old exact-pixels dialog
contract is superseded, and the shared artifact is the scene, not the
pixels.

The look is richer on both sides, in the matplotlib mplot3d spirit:
frames grow to 800×600; back panes and a grid replace axis labels (no
text is ever drawn — ADR 0013's font argument still decides against
fonts in the headless path); the Trajectory is colored along a fixed
time gradient by each sample's plan time; strokes are anti-aliased; the
robot skeleton strokes thicker than the trajectory. The older visual
semantics keep their meanings on both renderers: the travelled part
highlighted in its distinct color over the gradient, PTP Move geometry
dashed, and the TCP marker, the PTP trace, and the Home Point distinct
(ADR 0016, ADR 0017).

## The raster relaxes: deterministic float math, pinned bytes

ADR 0018 said "pure integer pixel math" over the palette. Anti-aliased
strokes need blending, so the GIF renderer rasterizes by fixed-factor
supersampling — integer pens on an oversampled grid, a box filter down
to the frame, each blended pixel mapped to its nearest palette entry
with stable first-index tie-breaking. The statement relaxes to
**deterministic float math**: no randomness, and identical input still
yields byte-identical GIF output, pinned by golden tests over a frozen
scene. A look change is still a deliberate, reviewable golden re-pin,
never an accident inside a feature PR (ADR 0006's discipline, unchanged
by the relaxation).

## What remains true from ADR 0018

- The self-contained pure GIF 89a encoder (`src/export/gif.ts`), pinned
  by round-trip tests with an independent test-side decoder.
- Pacing: frames sample at most 300 plan rows, evenly paced over the
  plan's real duration; one even delay per frame at the GIF's 1/100 s
  granularity, floored at 20 ms. The dialog's playback keeps the same
  wall-clock moment selection («Пуск»/«Пауза», time scrub, stop on the
  final frame) — no kinematics or planning math moves into the UI.
- The `RobotModel.chainPoints` skeleton seam (ADR 0008's Robot Model
  grown by one chain-description method, not renderer surgery).
- The frames stay text-free; the GIF bytes ride the pipeline result and
  land as `robot_motion.gif` next to the CSVs under the same staging
  discipline.
- The export layer stays headless — no canvas, DOM, or three.js imports
  anywhere in the export path (ADR 0012, ADR 0013); the layer test is
  the guard. The Orbit Camera and the dialog live in the ui layer,
  where canvas work belongs.

## Consequences

- `src/export/preview-scene.ts` exports the scene builder and the scene
  document; `src/export/motion-preview.ts` keeps the renderer seam
  (`renderMotionPreviewFrames`, `renderMotionPreviewGif`, the palette
  and color contract) but projects the carried scene instead of
  assembling pixel frames from the plan; `src/ui/orbit-camera.ts`
  exports the camera math. The pipeline result and the ok outcome carry
  `previewScene` where they used to carry `previewFrames`.
- Golden tests pin three layers headlessly: the scene's millimetre
  geometry, the fixed-camera frame geometry, and the GIF's bytes. The
  Orbit Camera is pinned like the canvas camera (ADR 0007) — pure
  functions, headless tests.
- Changing the projection, the fit, the palette, the time ramp, or the
  draw order remains a deliberate golden-test update (ADR 0006); ADR
  0018's consequences paragraph stands with the float relaxation above.
- Superseded by this ADR: ADR 0018's pixel-frame seam (the outcome no
  longer carries projected pixel frames), its exact-pixels dialog
  contract, and its pure-integer-pixel statement. Everything else in
  ADR 0018 stands as written.
- The dialog and the GIF cannot drift apart in content — one document,
  two cameras. Their looks may differ in raster technique (supersampled
  palette bytes versus the canvas's anti-aliased strokes); that is the
  contract, not drift. Deliberate divergence beyond that needs an ADR.
