# CSV contracts pinned by golden tests

Two exporters exist and their byte-level formats are contracts:

- **Robot CSV** — `t,q1,q2,q3`; milliseconds (integer step, 20 ms) and
  radians; this exact file is fed to the real robot controller.
- **RViz CSV** — same time column with a sign-transformed joint vector
  used for visualization; kept because the transform encodes the mounting
  convention and losing it would silently corrupt future visual checks.

Both are pinned by golden tests with fixed fixtures: a test asserts the
exported bytes against a committed expected file (or an exact structural
snapshot), so any format drift is a deliberate, reviewable test change —
never an accident inside a feature PR. These formats are also listed in
the README's one-way-doors section for the review pass.

## Considered options

- **Structural assertions only** (columns exist, step is right) — weaker:
  formatting changes (padding, precision, header) would pass while
  breaking the robot's parser.
- **Drop the RViz exporter** — rejected: cheap, useful in commissioning,
  and its transform is undocumented tribal knowledge that must live
  somewhere versioned.

## Consequences

- Changing a format means updating the committed fixture in the same PR
  and stating the robot-side verification in the PR body.
- The robot CSV consumed on the real machine must come from a release
  build, not a dev checkpoint, until first commissioning proves the
  format.
