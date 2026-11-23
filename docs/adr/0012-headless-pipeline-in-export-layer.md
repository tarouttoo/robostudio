# The headless pipeline lives in the export layer

The spec fixes seven layers: core, kinematics, motion, export, project,
app, ui. The headless pipeline — Segments + Robot Model + Planner in →
validation stage chain → exported Robot CSV and RViz CSV out — needs
core (Segments, Discretization), kinematics (Robot Model, IK), motion
(Planner, Motion Plan), and the exporters themselves, so it can only sit
at or above `export`. It lives in `export`, the layer whose job is
producing the named output files: the pipeline is the seam that runs
generation headlessly and hands over the bytes, and the UI (issue: run
generation) reaches it as an ordinary `export` import.

This widens `export`'s allowed dependencies from `core, motion` to
`core, kinematics, motion` (guarded by `src/layers.test.ts`). The
alternative — a new `pipeline` layer — was rejected: it would contradict
the spec's fixed layer list, add a layer whose only resident is one
orchestrating module, and drag both the README tree and the layer guard
through a bigger structural change than the seam needs. If a second
orchestrator ever appears, revisiting this becomes an ADR of its own.

## Exported-array validation and the reserved collision stage

The stage chain is `discretization → ik → motion-plan → collision →
export`, each stage validating its own output and failing with a
`PipelineError` that names the stage (`discretization`, `ik`,
`motion-plan`, `collision`, `export`) plus an operator-readable reason.
`collision` is a deliberate no-op: reserved, empty in v1 (GLOSSARY.md),
present so collision checking can be added without reshaping the chain.
The export stage parses both CSVs back and checks the exported arrays
against the Motion Plan before the bytes leave the pipeline; through the
public seam this check cannot fail while the exporters are correct — it
is defense-in-depth against an exporter defect, the same discipline as
the planner's internal `VerificationFailed`.

## Byte-format details the fixtures pin (ADR 0006 companions)

The golden fixtures commit the exact bytes; these details are part of
the contract:

- Header `t,q1,q2,q3`; `\n` line endings; a trailing newline after the
  last row.
- `t` is the row time as an integer in milliseconds (the plan's rows
  already sit on the 20 ms control step), printed without padding or
  decimals.
- Joint angles are radians in fixed six-decimal notation (`toFixed(6)`).
  A negative value that rounds to zero prints `0.000000`, never
  `-0.000000`.
- The RViz CSV is the sign transform `[q1, −q2, −q3]` of the Robot CSV
  rows: the visualization model counts the shoulder and elbow pitch
  from the opposite direction as the controller, while the base
  rotation is shared. This is the mounting convention ADR 0006 says
  must stay versioned — changing it is a deliberate fixture update plus
  an ADR.

## Consequences

- `src/export/index.ts` documents the widened imports; the layer test
  is the guard.
- The golden geometry test (ADR 0007) runs this pipeline end to end:
  square + inscribed circle in, FK-reconstructed shape out, tolerances
  next to the test.
- Stage names are stable identifiers (`PipelineStage`); the UI log
  (later ticket) renders them with Russian labels per GLOSSARY.md.
