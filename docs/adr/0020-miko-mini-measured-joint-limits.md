# The MiKo-mini carries the prototype's measured joint limits

The default MiKo-mini Robot Model restores the asymmetric, measured
q2/q3 joint limits the physical prototype is configured with, replacing
the symmetric `[−π, π]` placeholders ADR 0015 shipped with:

- **q1** (base rotation): `[−π, π]` — unchanged.
- **q2** (shoulder, measured from horizontal): `[π/2 − 1.341, π/2]` rad.
- **q3** (elbow, shoulder-up branch, negative): `[−(π/2 + 1.171), −(π/2 − 0.594)]` rad.

## Why: the unreachable zone near the robot is a joint-limit fact

With `[−π, π]` limits, every point whose wrist is geometrically
solvable classified `ok` — including points near the base axis, where
the shoulder-up solution folds the arm *backwards through the base
column*. The drawing canvas showed no unreachable area near the robot,
and nothing rejected such points until the pipeline's ik stage — which,
with `±π`, did not reject them either. The real robot cannot take those
poses: the prototype's controller limits the shoulder to `q2 ∈
[0, 1.341]` rad from vertical and the elbow to `q3 ∈ [π/2 − 0.594,
π/2 + 1.171]` rad from vertical (the roboboba prototype's
`trajectory_drawer_gui.py` constants, which this rewrite inherited and
then flattened in ADR 0015).

Restoring the measured limits makes the inner zone fall out of the
inverse kinematics itself, with zero new geometry code: the existing
Reachability map on the canvas, the live drawing checks, and the
pipeline's ik validation stage all classify the near-robot region as
`angle-limit` ("IK exists, but the angles are out of range" — exactly
the roboboba semantics), and generation refuses to run through it.

## The angle conventions differ, so the numbers are converted

robostudio measures q2 and q3 from *horizontal* (`r = L1·cos(q2) +
L2·cos(q2+q3) + tool`); the roboboba prototype measures them from
*vertical* (`px ∝ L2·sin(q2) + …`). The same physical stops convert as
`q2_ros = π/2 − q2_rob` and `q3_ros = −q3_rob` (the shoulder-up branch
keeps q3 ≤ 0), giving the ranges above. The converted constants are
never rounded, like every measured constant (ADR 0015).

## Consequences

- The workspace is a true annulus per plane: inside the inner
  `angle-limit` band (roughly radial < 200 mm at working height) the
  shoulder-up fold needs q2 past the measured maximum; beyond the outer
  `angle-limit` band (wrist distance from the shoulder past
  `|ψ(q3_min)|`-bounded reach) the measured q3 minimum binds *before*
  the geometric triangle-inequality edge, so at shoulder height the
  workspace edge sits at r ≈ 335 mm, not the geometric 372.6 mm. Every
  exit from the reachable region crosses an `angle-limit` band first;
  pure `unreachable` classification starts only past the geometric
  bound.
- The golden CSV fixtures were re-baselined (ADR 0006 discipline): the
  fixture Trajectory sat at z = 60 mm, inside what is now the inner
  limit zone, so the fixture moved to a fully reachable scene (line +
  quarter arc near the Home Point's height), and the golden-geometry
  square with its inscribed circle moved to the shoulder-height plane
  where the annulus fits a 100×100 mm shape with margin. Bytes were
  regenerated from the pipeline and reviewed as a deliberate diff.
- Test scenes that used the old near-base free space moved into the
  measured envelope; tests whose *subject* is the folded-back pose
  (q2 past `+π`) keep their targets — those are still `angle-limit`,
  now against the measured maximum. The generic-chain solver keeps one
  explicit `±π`-limited config to prove the numeric descent can find
  mirror solutions the shipped limits deliberately exclude.
- The default Home Point `[213, 0, 305]` stays: its shoulder solution
  (q2 ≈ 1.5653 rad) sits just inside the measured maximum `π/2`, as the
  prototype's near-vertical rest pose does.
- ADR 0015's "Joint limits: [−π, π]" line is superseded by this ADR;
  its geometry, tool offset, dynamic limits, and never-round rule all
  stand.
