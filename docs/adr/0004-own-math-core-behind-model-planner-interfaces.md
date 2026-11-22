# Own math core behind RobotModel and Planner interfaces

The trajectory math (discretizer, PCHIP joint interpolation, S-curve path
profile, analytic MiKo-mini IK, numeric damped-least-squares IK for
generic chains) is implemented in-house in pure TypeScript, behind two
interfaces: **RobotModel** (chain description + limits + FK/IK) and
**Planner** (path → time-parameterized joint motion). Command semantics
(PTP / LIN / CIRC with radius+direction or center) follow the Pilz
industrial motion planner conventions from ROS 2's MoveIt.

MoveIt 2 itself is not embedded: it is a C++ framework on the ROS 2
runtime — hundreds of native dependencies, Linux-first, not embeddable in
an Electron app that must install by double-click on Windows and Arch.
Its role in this project is conceptual (command semantics, planner-as-
plugin shape) and as future work: an out-of-process ROS planning service
behind the same Planner interface, and a thesis-level comparison.

## Considered options

- **Embed MoveIt** — rejected: runtime impractical for the target
  machines; would tie a desktop product to a ROS installation.
- **ROS bridge service from v1** — rejected: infrastructure-heavy, and v1
  has one 3-DOF robot whose closed-form IK is exact and instantaneous;
  rejected until a robot actually needs it.
- **No interfaces, direct calls** — rejected: the thesis requires several
  robots with different configurations; without the seams every new robot
  would edit the pipeline.

## Consequences

- The math core has zero runtime dependencies and is fully unit-tested.
- A second robot is a chain description (URDF-like JSON) plus solver
  selection in config; the numeric IK makes arbitrary chains workable.
- Swapping the profile for a time-optimal parameterization (TOTG-style) or
  bridging to a MoveIt service later touches implementations, not callers.
