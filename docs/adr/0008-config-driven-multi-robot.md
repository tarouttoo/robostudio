# Multi-robot via configuration, not forks

The thesis roadmap calls for several manipulators with different
kinematics. The app supports them through configuration: a **RobotModel**
is assembled from a chain description (URDF-like JSON: joint axes, link
transforms, joint and dynamic limits) plus a solver selection. A generic
numeric inverse-kinematics solver (damped least squares) works on any
chain; the analytic closed-form MiKo-mini solver ships as the first
registered model because it is exact and faster than iteration.

The rest of the app — drawing, discretization, planning, validation,
export — is robot-agnostic: it talks only to the RobotModel interface.
Adding robot #2 is a config file and, at most, an analytic solver as an
optional optimization; no pipeline changes.

## Considered options

- **Hardcode MiKo-mini like the prototype** — rejected: directly contradicts
  the thesis requirement and would scatter robot assumptions through the
  pipeline.
- **Monorepo with a workspace per robot** — rejected for now: ceremony
  without payoff at one-to-few robots; the interface already isolates them.
  Revisit if a robot needs native dependencies.

## Consequences

- Chain-description schema becomes part of the project-file/config surface
  and is validated on load.
- The numeric solver's convergence behavior (tolerance, iteration cap,
  failure reporting) is part of the RobotModel contract and is tested per
  model.
