# Cyclic joint solutions unwrap at the ik stage; plans cap at 15 minutes

## The freeze an operator hit

A 4-corner square of chained LIN Points (committed as
`src/project/fixtures/square-4-corners.json`) froze generation. The last
Move runs along x = −213 mm and crosses the negative-x axis, where
`atan2` switches its angle representation from −180° to +180°. The
planner received q1 knots that jump by a fake 360° between two samples
0.5 mm apart, interpolated that jump as a full extra base revolution,
and time scaling stretched the Segment until the fake revolution
respected the dynamic limits: 12 774.6 s for a Segment whose real motion
takes 21.7 s. The plan stayed contractually valid — every limit holds at
every row, and the glacial stretch defeats even the pipeline's
row-to-row continuity check — so nothing failed loudly: the plan grew to
641 628 rows, and the synchronous pipeline (verification, CSV export,
GIF and SVG chart rendering over all of them) froze the renderer.

## Why: the branch cut is a representation, not motion

Physically the base rotates −135° → −180° → +135°, about 90° of
continuous motion through the robot's back. The `±π` cut lives in the
*representation* of q1, not in the motion; nothing downstream of IK can
distinguish the two. The defect is therefore a pipeline-stage concern:
the ik stage owns the sample sequence and passes joint solutions to the
Planner as gospel.

## The fix: two defenses

1. **Unwrap at the ik stage.** After a sample's solution passes its
   limit checks, every joint whose limits span a full circle
   (`maxRad − minRad ≥ 2π − ε` — MiKo-mini's q1; q2 and q3 can never
   jump 2π between adjacent samples and are left untouched) continues
   from the previous sample's value through its nearest ±π
   representative. The Robot Model stays stateless (unwrapping is a
   sequence property), the Planner is unchanged, and the plan, the CSV
   exports, and the Motion Preview all consume continuous angles. The
   crossing Segment now plans in ~21.7 s; the whole square in ~80 s.
2. **A total-duration cap.** Defense in depth: an operator's own Feed
   choice and the dynamic limits may legitimately demand slow motion,
   but a plan past **15 minutes** signals a pathological trajectory
   rather than slow progress. The Planner fails with a named
   `PlanDurationExceeded` naming the worst-stretched Segment and its
   stretch multiple, per the Validation stages contract (GLOSSARY.md):
   a named, understandable failure beats a frozen UI.

## Consequences

- Exported joint angles for cyclic joints leave `−π; π` when the
  trajectory crosses the branch cut: they carry the accumulated angle
  (the convention real controllers consume). Visualization variants
  that re-wrap for display stay responsible for their own wrapping.
- Future position-limit verification must compare cyclic joints by
  their wrapped representative (an unwrapped value is physically
  on-limits while numerically outside the stored range).
- Generation stays synchronous in the renderer: a valid plan under the
  cap can still occupy the UI thread for seconds on rendering. Moving
  generation off the UI thread is deferred (a worker-based seam is the
  candidate design); the cap bounds the damage until then.
- Golden CSV fixtures are unaffected: the fixture Trajectory never
  crosses the branch cut.
