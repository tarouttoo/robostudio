# Ticket #64 — Scene on the outcome; dialog through the Orbit Camera

Goal: swap the contract. The Generation outcome carries the **Preview
Scene** (renamed `previewFrames` → `previewScene`); the dialog renders
the scene every animation frame through the Orbit Camera; the exact-
pixels plumbing is retired. Playback pacing untouched.

## Approach

1. **Carry the scene on the run**
   - `src/export/pipeline.ts`: `runPipeline` calls `buildPreviewScene`
     once, renders the GIF from that one document (extend
     `MotionPreviewInput` with an optional prebuilt scene — the additive
     path #61 prepared), adds `previewScene` to `PipelineResult`. The
     `export` stage detail text keeps its shape (frame count + bytes +
     `robot_motion.gif`) so `pipeline.test.ts` stays green.
   - `src/ui/generation.ts`: the `ok` outcome replaces
     `previewFrames: renderMotionPreviewFrames(…)` with
     `previewScene: result.previewScene` (one build per run — today the
     frames are rendered a *second* time in the session; that
     duplication disappears). Update the module-header JSDoc ("the
     Motion Preview frames ride on the outcome…" → the scene).
   - `src/ui/App.tsx`: read `generation.previewScene`, pass it to the
     dialog (the disabled-button logic and title stay).

2. **Dialog rendering** (`src/ui/MotionPreviewDialog.tsx`):
   - Props become `{ scene: PreviewScene; durationMs; onClose }`.
   - Hold an `OrbitCamera` in state, initialized to
     `defaultOrbitCamera(scene.boundsMm, viewport)` (measure the canvas
     via ref on mount/resize — ADR 0007 reactive-transform discipline).
   - Every rAF (and every camera change), redraw the whole scene:
     project with `projectOrbit`, sort primitives by `depthOrbit`
     (painter's algorithm — per-primitive mean depth is fine; keep the
     sort deterministic/stable), stroke on the 2D canvas.
   - Draw order & semantics (match #62's look in spirit): background
     panes/grid optional in the dialog — the Spec requires the dialog to
     render the same scene, not the same pixels; trajectory polylines
     colored per-sample along scene `tMs` through a fixed gradient ramp
     (hardcode a canvas RGB ramp mirroring #62's palette ramp — document
     the pairing), dashed PTP via `ctx.setLineDash`, travelled part
     thicker in its distinct color **computed from the scene's travelled
     counts up to the current moment** (not per-frame primitives — the
     scene carries the data), robot skeleton thicker, TCP marker, PTP
     trace runs clipped to moments ≤ current, Home Point marker **every
     frame** (locatable from any angle). No text in the render.
   - The moments' `tMs` selection uses `frameIndexAt(scene.moments,
     timeMs)` — widen `frameIndexAt`'s parameter in
     `src/ui/preview-playback.ts` to `readonly { readonly tMs: number }[]`
     (structural). **`src/ui/preview-playback.test.ts` stays untouched
     and passing** (its `MotionPreviewFrame[]` fixtures satisfy the
     wider type).
   - Keep the playback loop, «Пуск»/«Пауза», scrub, readout, Esc,
     restart-from-start logic exactly as-is.

3. **Interactivity**: pointer drag = `orbitCamera(camera, dx, dy)` on
   pointermove while pressed (pointer capture); wheel = `zoomCamera`;
   «Вписать» button and canvas double-click = reset to
   `defaultOrbitCamera(scene.boundsMm, viewport)` (exact equality with a
   fresh default record). No inertia, no animated transitions.
   **React's `onWheel` is passive** — attach the wheel listener with
   `addEventListener("wheel", handler, { passive: false })` in an effect
   so `preventDefault()` works and the page doesn't scroll.

4. **Retire the exact-pixels contract**:
   - Remove `rasterizePreviewFrame` (+ `MotionPreviewFrame`/
     `PreviewPrimitive` types if they move to the scene module) from
     `src/export/index.ts` exports. The GIF renderer keeps its raster
     step **internal** to `motion-preview.ts`
     (`motion-preview.test.ts` imports `./motion-preview` directly, so
     its tests survive; the test "rasterizes the frames the dialog
     consumes…" needs its dialog-facing wording updated).
   - Delete the dialog's ImageData/palette painting path; the dialog no
     longer imports `MOTION_PREVIEW_PALETTE`/`rasterizePreviewFrame`.
   - Update stale doc-claims in the touched module headers (CODING_
     STANDARDS: same commit). ADR edits belong to #65 — do not touch
     `docs/adr/`.

## Files

- Changed: `src/export/pipeline.ts`, `src/export/index.ts`,
  `src/ui/generation.ts`, `src/ui/App.tsx`, `src/ui/MotionPreviewDialog.tsx`,
  `src/ui/MotionPreviewDialog.test.tsx`, `src/ui/generation.test.ts`,
  `src/ui/preview-playback.ts` (element-type widening only), and the
  minimal `src/export/motion-preview.ts` touch needed to drop the
  exported rasterize seam from the public index (keep internals).
- Untouched: `src/ui/preview-playback.test.ts`, `src/app/**`.

## Test seams

- `MotionPreviewDialog.test.tsx` (renderToString prior art): modal
  «Предпросмотр движения», plays on open («Пауза» offered, no
  `>Пуск<`), time scrub `max` = real duration, readout
  `Время, с: 0.00 / 0.12`, **«Вписать» control present**, «Закрыть»,
  Esc behavior unchanged. Canvas painting isn't testable at this seam
  (CODING_STANDARDS: interaction logic lives in the pure modules — the
  camera is tested in #63's suite).
- `generation.test.ts`: replace the `previewFrames` describe block —
  the `ok` outcome carries the scene (sampled moments' `tMs` span
  `0 → durationMs`; scene equals `buildPreviewScene` of the same
  inputs), `failed`/`blocked` carry none (`"previewScene" in failed ===
  false`). Update the header comment block names accordingly.
- `pipeline.test.ts`: stays green — `motionGif` bytes still byte-
  deterministic; `previewScene` is additive.
- `App.test.tsx`: the dialog-offer test (line ~150) reads only outcome
  kind — should pass untouched; verify.

## Pitfalls

- One scene per run: do **not** rebuild the scene in the dialog or the
  session — `PipelineResult.previewScene` is the single source; the GIF
  and the dialog must consume the identical document (story 16/13).
- Don't move kinematics/planning into the UI: the scene carries chains
  per moment; the dialog never calls `chainPoints` itself.
- Depth sorting must be stable for equal depths (tie → keep draw order)
  so no flicker between frames.
- The dialog canvas now renders at CSS size with device pixel ratio
  backing (`canvas/transform.ts`'s `backingSize` pattern) — crisp
  strokes without re-deriving the camera in physical pixels.
- Keep `frameIndexAt`'s behavior byte-identical; only the type widens.
- Scrubbing while orbiting: camera state and plan time are independent
  state — a camera change must not restart playback.

Gate: `npm run typecheck` && `npm test`, `src/layers.test.ts` green,
no new runtime deps.
