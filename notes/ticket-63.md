# Ticket #63 — Hand-rolled Orbit Camera as pure functions

Goal: `src/ui/orbit-camera.ts` — the interactive camera math only, no UI
wiring, no rendering. The repo's camera tradition (ADR 0007): immutable
state record + pure functions of explicit inputs, headless-tested like
`src/ui/canvas/transform.ts` + `transform.test.ts`.

## Approach

Module `src/ui/orbit-camera.ts` (ui layer; may import `export` — the
layers test allows ui → export). Suggested shape:

```ts
interface OrbitCamera {
  readonly target: Vec3;      // mm, orbit center (scene bounds center by default)
  readonly yaw: number;       // rad, around world Z
  readonly pitch: number;     // rad, clamped away from the poles
  readonly distanceMm: number; // dolly distance, clamped
}
defaultOrbitCamera(bounds: MmBounds, viewport: Viewport): OrbitCamera
orbitCamera(camera, dxPx, dyPx): OrbitCamera          // drag delta → yaw/pitch
zoomCamera(camera, deltaY): OrbitCamera               // wheel → dolly, clamped
projectOrbit(camera, p: Vec3): [xPx, yPx]             // mm → CSS px, y down
depthOrbit(camera, p: Vec3): number                   // view-space depth (sort key)
```

Key decisions:

1. **Default view = the charts' isometric convention** so «Вписать»
   reproduces the GIF's fixed camera. `projectIsometric`
   (`src/export/charts.ts`) computes `right = (x−y)·cos30`,
   `up = z + (x+y)·sin30` — i.e. the camera sits at azimuth −45°
   (looking along +x+y) with elevation arcsin(0.5) = 30°. Derive yaw/
   pitch constants from that formula (or project through
   `projectIsometric`-equivalent math) and pin them in tests: for a
   point on the x axis vs the y axis, projected right/up relations must
   match the isometric convention. You may import `domain` from
   `../export/charts` for degenerate-extent padding — reusing it keeps
   one convention for every isometric view.
2. **Fit = equal aspect** (ADR 0007 anti-distortion): project the bounds'
   8 corners with the camera, take the projected extents, one uniform
   mm→px scale = `min(viewportW/extentX, viewportH/extentY)` (limiting
   axis fills, other centers); degenerate extents pad instead of
   collapsing (never NaN/Infinity — a single-point scene and a flat
   scene must stay finite). `Viewport` shape can mirror
   `src/ui/canvas/transform.ts`'s `{ widthPx, heightPx }` (device pixel
   ratio affects backing store only; the CSS-px mapping is what the
   camera owns — follow the transform.ts reasoning).
3. **Orbit**: `yaw += dxPx · factor`, `pitch += dyPx · factor`
   (deterministic constants, e.g. radians per pixel), pitch clamped to
   e.g. ±(π/2 − ε) so the camera cannot flip through the poles; no
   inertia, no clamping yaw (free spin around Z).
4. **Zoom**: wheel deltaY → dolly `distanceMm · k^…` (deterministic
   multiplicative step), clamped to `[minDistance, maxDistance]`
   (constants like transform.ts's `MIN/MAX_PX_PER_MM`; keep them sane
   relative to typical mm scenes).
5. **Projection**: camera position from yaw/pitch/distance around
   `target`; a right/up/forward basis (world Z up); standard perspective
   or orthographic projection is your choice — **orthographic matches the
   isometric default exactly** (the GIF camera is orthographic; a reset
   that flips to perspective would violate story 8's "known view").
   Pin: mm→px scale uniform; y grows down; `depthOrbit` larger = farther
   (or nearer — pick, document, and sort consistently in #64).

## Tests (`src/ui/orbit-camera.test.ts`, prior art `transform.test.ts`)

- Default fit: crafted bounds (e.g. 100×80×40 mm) into a crafted
  viewport map inside it; the projected extents fill exactly one axis
  and center on the other; bounds center lands at viewport center
  within rounding; one uniform scale (equal-mm legs → equal-px legs).
- Orbit: yaw increases monotonically with positive dx; pitch clamps at
  both bounds (repeated large dy stops changing); for fixed angles,
  depth order of two crafted points is stable across the orbit record's
  other fields.
- Zoom: monotonic dolly in/out for signed deltaY; clamps hold at both
  ends (repeat calls stop changing `distanceMm`).
- Reset: `defaultOrbitCamera(bounds, viewport)` equals the record after
  orbit+zoom applied then reset (deep equality — `toEqual`).
- Degenerate bounds: single point, flat scene (one zero extent) → all
  projections/depths finite (`Number.isFinite` over a sweep of calls).
- Determinism: two identical call sequences produce `toEqual` records
  and projections.

## Files

- New: `src/ui/orbit-camera.ts`, `src/ui/orbit-camera.test.ts`
- Untouched: everything else — **no wiring** (#64 consumes this).

## Pitfalls

- Keep everything pure: no DOM, no `performance.now`, no state outside
  the passed record (the dialog will hold the record in React state).
- Watch the y-axis sign conventions (world Z up, screen y down) — write
  one projection formula and test the flip explicitly.
- Don't import `src/ui/canvas/transform.ts`'s working-plane camera — it
  is 2D Working-Plane math; reuse only its *pattern* (and maybe the
  `Viewport` record shape).
- ui must not import `node:`/`electron` (layers test) — pure TS only.

Gate: `npm run typecheck` && `npm test`.
