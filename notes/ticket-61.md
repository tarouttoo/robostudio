# Ticket #61 — Preview Scene document seam (`buildPreviewScene`)

Goal: introduce `src/export/preview-scene.ts` — a pure mm-space scene
builder — and make `renderMotionPreviewFrames` its first consumer
**without changing any projected pixel** (all existing
`src/export/motion-preview.test.ts` tests pass unchanged, including the
frame-0 golden `[252,154] / [294,130] / [336,105] / skeleton …`).

## Approach

1. **New module `src/export/preview-scene.ts`** (export layer: imports
   only `core`, `kinematics`, `motion` — `src/layers.test.ts` guards).
   Export `buildPreviewScene(input: { trajectory, plan, model }): PreviewScene`
   plus the scene types. Suggested document shape (keep it data-only):

   ```ts
   interface PreviewScene {
     segments: readonly PreviewSceneSegment[];   // per-Segment polylines, traversal order
     moments: readonly PreviewSceneMoment[];     // ≤ 300 sampled plan moments
     traceRuns: readonly (readonly number[])[];  // moment-index runs under PTP
     homeMm: Vec3;                               // trajectory home
     boundsMm: { min: Vec3; max: Vec3 };         // bbox over polylines + chains + home
   }
   interface PreviewSceneSegment {
     segmentIndex: number;
     isPtp: boolean;                             // dashed semantics
     mm: readonly Vec3[];                        // polyline, traversal order
     tMs: readonly number[];                     // per-sample plan time, same length
   }
   interface PreviewSceneMoment {
     tMs: number;
     chainMm: readonly Vec3[];                   // model.chainPoints(row.q), joints.length + 2
     tcpMm: Vec3;                                // last chain point (per-frame FK)
     travelled: readonly number[];               // per plan range: polyline samples travelled
   }
   ```

2. **Move the existing disciplines, don't reinvent them.** Port from
   `motion-preview.ts` (leave the projected-pixel side in place):
   - `samplePlanRows` — one moment per row, cap `MOTION_PREVIEW_MAX_FRAMES`
     (300) by even index spacing (`Math.round(i*(n-1)/299)`).
   - `segmentPolylines` grouping (consecutive same-`segmentIndex` runs of
     `discretizeTrajectory` samples). **Also keep each sample's
     `pathLengthMm`** — the per-sample time mapping needs it (the current
     helper keeps only `mm`; extend, don't reuse blindly).
   - `ptpSegmentIndices` (point Segments with `motionType === "PTP"`).
   - Per-sample times: from `plan.ranges` (one range per Segment with a
     positive span — `collectSegmentPlans` in `src/motion/planner.ts`),
     linear in arc length:
     `t = startMs + (s − sStart)/(sEnd − sStart)·(endMs − startMs)` where
     `s` = sample `pathLengthMm`. The S-curve is nonlinear; this is the
     schedule cue the Spec mandates — pin the mapping in the golden tests.
   - `collectTraceRuns` for `traceRuns` (runs of consecutive sampled rows
     with the same PTP `row.segmentIndex`).
   - Travelled counts per moment per range: the existing
     `appendTravelled` decision tree — skip PTP ranges; complete if
     `tMs >= min(range.endMs, plan.durationMs) − TIME_SLACK_MS (1e-9)`;
     else if `tMs > range.startMs`, `nearestSample(polyline, tcpMm) + 1`
     (argmin squared 3D distance); else 0. Store the raw counts
     (including counts < 2 — the renderer still applies its own skip).
   - Chains/TCP: `model.chainPoints(row.q)` per sampled row; TCP = last
     point.
   - Bounds: mm min/max over all segment polylines, **all chains**, and
     the Home Point.

3. **Refactor `src/export/motion-preview.ts`**: `renderMotionPreviewFrames`
   calls `buildPreviewScene` and projects it exactly as today
   (`projectIsometric` + `domain` + `MARGIN_PX = 12` fit, same palette
   indices, same draw order: trajectory → travelled → trace → robot
   (width 2) → tcp dot (2) → home dot (3)). Optionally accept a
   prebuilt scene in the input (additive) — #64 will use that path; keep
   the default behavior identical. Keep `renderMotionPreviewGif`,
   `rasterizePreviewFrame`, and all `MOTION_PREVIEW_*` constants'
   names/behavior. Reword the module header/JSDoc where it claims the
   dialog paints these pixels — after #61 the seam is the scene (final
   contract wording lands with #65's ADR).

4. **Export from `src/export/index.ts`**: `buildPreviewScene` + scene
   types.

## Files

- New: `src/export/preview-scene.ts`, `src/export/preview-scene.test.ts`
- Changed: `src/export/motion-preview.ts` (consume the scene),
  `src/export/index.ts`
- Untouched: `src/export/pipeline.ts`, `src/ui/**`, `src/app/**`

## Test seams (prior art: `motion-preview.test.ts` crafted scenes)

Reuse the test-scene pattern: frozen MiKo-mini
(`createMiKoMiniModel(DEFAULT_MIKO_MINI_CONFIG)`, pose `q = [0,0,0]`),
`LINE_SCENE` (home `vec3(200,0,100)` + one Line to `vec3(300,0,100)`),
crafted plans via `{ rows, ranges, durationMs }` with `row(tMs, q, segmentIndex)`
helpers. For a PTP scene: `point({ target, feed, motionType: "PTP" })`.

Golden mm-geometry tests to pin (ADR 0006 discipline applied to geometry;
prior art `src/export/golden-geometry.test.ts`, `charts.test.ts`):

- Segment polylines in mm: first/last sample equal the drawn geometry
  endpoints; LIN solid flag, PTP `isPtp`; per-sample `tMs` arrays — pin
  the linear-arc-length mapping on a crafted range (e.g. range
  `[0,120] ms` over a 100 mm line → sample at s=50 mm has `tMs = 60`).
- Moments: count (rows when ≤ 300; exactly 300 on a 1000-row plan),
  `tMs` span `0 → durationMs`, even pacing (gaps within one
  `CONTROL_STEP_MS`).
- Chain shape per moment: `chainMm` equals `model.chainPoints(row.q)`
  elementwise for a frozen `q`; length = `model.joints.length + 2`.
- Travelled: empty at the start (counts 0), complete on the last moment
  (full polyline counts), mid-range cut at the pen's actual position
  (crafted FK poses on the line, like the existing mid-range test),
  none under a PTP range.
- Trace runs: present only when the Trajectory holds a PTP Move; runs
  match consecutive moment indices whose `segmentIndex` is the PTP one.
- Home Point mm equality; bounds contain trajectory extremes, the
  farthest chain point (e.g. base at `[0,0,0]` and TCP at the frozen
  pose), and home.
- Determinism: two `buildPreviewScene` calls produce `toEqual` documents.
- Cross-check: `renderMotionPreviewFrames` output is byte-identical to
  before (the unchanged existing tests ARE this check — run the whole
  motion-preview suite, do not touch it).

## Pitfalls

- Do **no** projection/raster/DOM work in `preview-scene.ts` — pure mm
  data only; no import of `charts.ts` needed there (that keeps the
  module trivially layer-safe).
- A PTP polyline can hold 1–2 samples (endpoint-only discretization,
  merged join); a merged-away Segment has no polyline and no range —
  the time mapping must skip both silently.
- `plan.durationMs` is grid-rounded and can sit one 20 ms step short of
  the last range's `endMs` — the `min(endMs, durationMs)` completion rule
  exists for exactly that; keep it verbatim.
- Keep `TIME_SLACK_MS` semantics identical (1e-9) so completion timing
  doesn't shift a pixel.
- Don't export helpers the tests don't need (CODING_STANDARDS: exports
  earn their consumers).

Gate: `npm run typecheck` && `npm test` all green, motion-preview tests
literally unchanged.
