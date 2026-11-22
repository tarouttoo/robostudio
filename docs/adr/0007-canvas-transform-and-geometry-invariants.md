# Canvas transform is reactive; geometry invariants are regression-tested

The screen↔world mapping of the drawing canvas is derived from the live
canvas size on every frame — never from constants captured at startup.
The prototype's distortion bug (a drawn square became a rectangle and a
circle an oval, a few mm of anisotropic error) came from a hardcoded
canvas size: when the actual widget size differed (window resize, Windows
DPI scaling), clicks were unprojected with stale dimensions, so geometry
that looked right on screen was wrong in world coordinates.

Two layers of defense in this repo:

1. **Reactive transform** — the projection is a pure function of the
   current canvas viewport; resizing, scaling, and device pixel ratios
   cannot desynchronize it.
2. **Geometry invariants in CI** — an end-to-end golden test draws a
   square 100×100 mm with an inscribed circle r = 50 mm, runs the full
   pipeline, and reconstructs the geometry from the Robot CSV output via
   forward kinematics, requiring agreement with the ideal shape to tight
   tolerance. Supporting invariants pin the pipeline: monotonic time,
   20 ms row step, path continuity between segments, dynamic limits
   respected.

## Considered options

- **Debug the prototype instead** — rejected: the prototype has no tests
  and entangled GUI/pipeline code; finding the exact cause there costs
  more than making the bug's whole class impossible here.
- **Invariant tests only, without constraining the transform design** —
  rejected: the failure mode (stale constants) is architectural; the rule
  "pure function of live viewport" removes it by construction, the tests
  verify it.

## Consequences

- Any PR that breaks drawn-vs-exported geometry fails CI with a
  millimeter-level diff, not a customer report.
- Tolerance constants for the golden geometry test live in one place next
  to the test and may only be loosened with an ADR.
