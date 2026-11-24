# Drawing places chained Points with PTP Moves

The operator's primary drawing tool is «Точка» (Point): every click
adds a Point Segment whose PTP Move starts where the previous Segment
ended (the first at the Home Point), and the canvas draws each Move
dashed — committed and in the pending draft preview alike. The Line
and the old jump-Point drawing tools retire: a chained PTP Move
already covers the jump the old Point tool performed. Command
semantics follow the Pilz/MoveIt conventions the project adopted
(ADR 0004): the chained Point is PTP, the Arc stays CIRC.

## PTP semantics

A PTP Move guarantees only arrival at the target: the joints
interpolate directly between the endpoint solutions, so the TCP's path
in space is whatever the joint interpolation traces — not the drawn
chord. The pipeline honors this at every stage:

- **Discretization** samples a PTP Move at its endpoint poses only —
  no intermediate path points, so there is nothing per-sample to check
  or solve along the way.
- **Reachability** is enforced at the Move targets only, live (the
  pending preview and per-Segment flags) and in the pipeline's ik
  stage alike. No per-sample path checks for PTP.
- **Planning** interpolates joints between the endpoint solutions
  (PCHIP over two knots — a straight joint line) under the S-curve
  profile, stretched until the Robot Model's velocity, acceleration,
  and jerk limits hold.

The Robot CSV and RViz CSV contracts (ADR 0006) are untouched: the
exporters consume plan rows whatever geometry produced them, and the
golden fixtures (Line + Arc) pass byte-identically.

## Consequences

- Line and Arc Segments stay in the model: existing Project Files
  load, the golden fixtures keep exercising Line and Arc geometry, and
  exports are unaffected. Only the drawing tools retire.
- Undo still works per Segment: one Move per «Отменить». Draft-cancel
  applies to Arc drafts; a Point commits per click, so it holds no
  draft to cancel.
- The reconstructed cartesian chart of a PTP Move shows the joint
  interpolation's trace, not the drawn chord — the honest picture of
  what the robot will do.
- The chained Move's start is the Trajectory's chain, not a stored
  field: editing the Home Point or undoing a Segment re-derives where
  every Move starts, so the drawing never drifts out of chain order.
