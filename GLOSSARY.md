# GLOSSARY

The domain vocabulary of robostudio. UI text uses the Russian term; code
and docs use the English term. Use exactly these words; no synonyms in
either language. Implementation details live in `docs/adr/` and code, not
here.

- **Trajectory (Траектория)** — the ordered set of Segments the operator
  drew; the thing the whole app exists to produce.
- **Segment (Участок)** — one geometric element of a Trajectory. Kinds:
  **Line (Отрезок)**, **Arc (Дуга)**, **Point (Точка)**. Each Segment
  carries its own Feed.
- **Line (Отрезок)** — a Segment defined by start and end.
- **Arc (Дуга)** — a Segment defined by Working Plane + start + end +
  direction + radius **R** or center. Direction is **CW (по часовой)** or
  **CCW (против часовой)**. There is no three-point Arc; the center is
  never inferred from a middle click (ADR `0005`).
- **Point (Точка)** — a Segment that moves the pen to a target without
  drawing geometry (start a new sub-path).
- **Working Plane (Рабочая плоскость)** — the plane the operator draws on:
  **XY**, **XZ**, or **YZ**, with the third coordinate fixed. CNC
  G17/G18/G19 conventions.
- **Feed (Подача)** — Segment traverse speed. mm/min in the UI (CNC
  convention), mm/s internally. Does not affect exported joint angles.
- **Home Point (Исходная точка)** — the 3D point where the drawn Trajectory
  starts; the pen position before the first Segment.
- **Robot Model (Модель робота)** — a named description of a manipulator
  (kinematic chain + joint and dynamic limits) providing forward and
  inverse kinematics. Robots are added as configuration, not as new math
  (ADR `0008`).
- **MiKo-mini** — the v1 Robot Model: 3-DOF manipulator (base rotation +
  two planar links), the only robot fully working in v1.
- **Reachability (Достижимость)** — whether a 3D point or Segment lies in
  the Robot Model's workspace and admits joint angles within limits.
  Checked live while drawing and again as a pipeline validation stage.
- **Discretization (Дискретизация)** — sampling a Trajectory into a dense
  point path with cumulative path length; the input to kinematics.
- **Motion Plan (План движения)** — time-parameterized joint motion
  derived from the discretized path: joint positions, velocities,
  accelerations, jerks over time, within the Robot Model's limits.
- **Motion Profile (Профиль движения)** — the smooth speed schedule along
  the path that the Motion Plan follows.
- **Validation stages (Стадии проверки)** — every pipeline stage validates
  its output and fails with a named, understandable error: discretized
  path → IK results → Motion Plan → exported arrays. **Collision
  checking (Проверка коллизий)** is a reserved stage, deliberately empty
  in v1.
- **Exporter (Экспортёр)** — a named output writer.
- **Robot CSV** — the Exporter output the real robot consumes:
  `t,q1,q2,q3`, milliseconds and radians, 20 ms row step. Format is a
  contract pinned by tests (ADR `0006`).
- **RViz CSV** — the sign-transformed Robot CSV variant used for
  visualization; its transform encodes the mounting convention.
- **Project File (Файл проекта)** — versioned JSON (`schemaVersion`)
  storing Working Plane, Home Point, Segments, and view settings; the
  canonical save/load format.
