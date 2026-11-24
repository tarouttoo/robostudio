# Per-Move Motion Type: LIN by default, PTP preserved

The chained Point (ADR 0016) gains a per-Move Motion Type: every Point
Segment carries `LIN` or `PTP`. A LIN Move follows the drawn straight
line from the chain end to its target — per-sample Discretization, IK
and Reachability along the path, drawn solid, exactly the
path-following behavior Lines and Arcs already have. A PTP Move keeps
the ADR 0016 semantics unchanged: endpoint poses only, target-only
Reachability, drawn dashed, joints interpolated directly. The editor's
Motion Type toggle (next to the drawing tools, LIN the default) selects
the type of the next committed Move; the segment list edits each
committed Move's Motion Type the way it edits its Feed. Command
semantics stay in the Pilz/MoveIt family (ADR 0004): LIN is the
linear command, the Arc stays CIRC.

## Decisions

- **The Motion Type lives on the Point Segment**, not in a separate
  plan setting: a mixed LIN/PTP chain is one drawing, one pipeline run,
  one export — per-Segment data is what the model already does with
  Feed, and the Project File stores it the same way.
- **The default for new Moves is LIN** (per ticket #42): the editor's
  toggle starts on LIN. The toggle applies to Moves committed from now
  on; committed Moves are edited individually.
- **LIN Moves ride the existing pipeline unchanged.** Discretization
  samples the drawn straight line at `maxStepMm` spacing (merged joins
  contribute nothing, like drawn geometry); the planner and exporters
  consume samples and never learn the Motion Type. PTP Moves are the
  only special case, exactly as in ADR 0016.
- **Reachability by Motion Type.** `checkSegmentReachability` takes the
  Move's start (the chain end) and checks a LIN Move along the drawn
  line, a PTP Move at its target only. Live flags, the pending-draft
  preview, and the pipeline's ik stage (which checks the samples the
  Discretization emitted) agree.
- **Project File backward compatibility without a version bump**: files
  written before the Motion Type existed are still schema version 1. A
  Point without a `motionType` field parses as **PTP** — the only
  semantics those files could have been drawn with (ADR 0016) — so a
  saved jump is never silently turned into a drawn line. An unknown
  value is a named `InvalidProjectFile` error; the core constructor
  rejects non-MotionType values with `InvalidMotionType`.
- **Drawing encodes the semantics**: LIN solid, PTP dashed, committed
  and pending alike — the operator sees which Moves follow lines and
  which only arrive.

## Consequences

- The golden fixtures (Line + Arc + one PTP pen-up transit, ADR 0006)
  stay byte-identical: PTP is unchanged.
- A LIN Move's Reachability can fail mid-path where the same target as
  PTP passes — the ik stage names the Segment and the failing sample,
  and the live canvas flags the drawn line before committing.
- The planner sees only samples: a LIN Move is planned like drawn
  geometry (per-sample knots), a PTP Move like a two-knot straight
  joint line. No planner changes were needed.
- Old Project Files keep their exact behavior; new saves store the
  Motion Type explicitly.
