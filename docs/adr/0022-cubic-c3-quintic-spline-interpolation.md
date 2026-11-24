# Joint-space interpolation is a C³ quintic spline, not PCHIP

## The noise an operator saw

On the operator's square (the committed `square-4-corners` Project File
minus the branch-cut corner), the joint-acceleration chart showed a
strange dense noise on q3 and the joint-jerk chart shook violently —
while the velocity chart and the Motion Preview stayed perfectly
smooth, and the jerk alternated up to **181 % of its limit between
adjacent control rows** (±14.5 rad/s³ against an 8 rad/s³ limit) at the
side midpoints, where the arm folds deepest and q3 passes an interior
extremum near its measured limit (ADR 0020).

## Why: PCHIP was only C¹

The charts plot the Planner's *analytic* chain-rule derivatives — not a
plotting artifact. PCHIP (Fritsch–Carlson monotone cubic Hermite) is
piecewise cubic with continuous value and first derivative: velocity
charts and previews are smooth. Its second derivative jumps at every
Discretization knot (0.5 mm spacing), and its third derivative is
piecewise constant — so the planned accelerations carried a dense
sawtooth and the planned jerks stepped at every knot. A robot consumes
exactly these signals: the noise was real, and the between-row jerk
excursions exported silently, because `verifyPlan` only checked the
20 ms rows. PCHIP was chosen (its header said so) for shape
preservation — no overshoot past the solved IK values. The measured
limits (ADR 0020) and the operator's near-limit trajectories made that
trade the wrong one: signal continuity now matters more than knot-level
monotonicity.

## The decision

`createSplinePlanner` interpolates q(s) per Segment with a **C³ quintic
spline** (`src/motion/spline.ts`): classic natural cubic-spline tangents
first, then a second tridiagonal solve for knot curvatures that makes
the third derivative continuous across knots. Value, velocity,
acceleration, and jerk are all continuous; a step in jerk is no longer
possible at any knot.

Measured on the operator's square (same file, same feeds): peak q3 jerk
dropped from 181 % of limit to **0.5 %**, adjacent-row acceleration
steps from a visible sawtooth to 0.03 % of limit, and the plan dropped
from 57.9 s to the Feed-nominal 56.1 s — PCHIP's noise had been forcing
extra time-scaling stretch all along.

## The price, and what guards it

The spline gives up shape preservation: q may slightly overshoot the
solved IK values between knots. Three guards make that safe:

- Knots stay dense (0.5 mm Discretization), bounding overshoot to a
  fraction of a degree of joint travel;
- `verifyPlan` now checks **position limits at every control row** and
  **dynamic limits at every probe** — the same probe set the scaling
  loop uses: control rows, Segment endpoints, and **every knot
  crossing** (their normalized times are geometric and computed once
  per Segment). A plan that exceeds any limit *anywhere* fails with a
  named `VerificationFailed` instead of exporting silently;
- Scaling probes exactly what verification checks, so the loop cannot
  converge on a plan the verifier rejects.

Cyclic joints (unwrapped by ADR 0021) are position-checked through
their wrapped representative.

## Consequences

- Both exported CSVs and every chart carry C³-smooth signals; golden
  fixtures were re-baselined per ADR 0006 (same row grid, same
  duration, angles shifted in the 6th decimal).
- `pchip.ts` is deleted; `src/motion` exports the spline as the
  interpolant. The Planner seam itself (ADR 0004) is unchanged; ADR
  0004's "PCHIP joint interpolation" description is superseded by this
  ADR.
- Very uneven knot spacing can make the curvature system non-dominant;
  with the Discretization's uniform 0.5 mm knots and 1 mm join merges
  this is not observed. If a future input class hits it, the failure
  surfaces as a `VerificationFailed`/`TimeScalingFailed` named error,
  never as silently wrong motion.
- The Motion Preview and the GIF render the same plan they always did —
  their smoothness was never in question; the charts now agree with
  them.
