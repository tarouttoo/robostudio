# CONTEXT

The agent's map of this repository: what it is, the vocabulary used in
prompts and code, and where deeper material lives. Read the relevant section
before resolving anything substantive; add terms here when you introduce a
new concept.

## What this repo is

robostudio: a desktop app (TypeScript, Electron + React + Vite) where an
operator draws a robot trajectory on a working plane using CNC conventions
— lines and arcs (radius + direction, or center), feed in mm/min — and the
app turns the drawing into CSV files that drive the MiKo-mini 3-DOF
manipulator, plus plots of the planned motion. Windows and Linux builds.

It is a from-scratch rewrite of an earlier Python prototype (`roboboba`);
the old code is reference material only, never a source to copy. Geometry
correctness is guarded by invariant and golden tests
(`docs/adr/0007-canvas-transform-and-geometry-invariants.md`) because the
prototype shipped a subtle distortion bug (drawn squares became
rectangles).

The repo also runs a label-driven agent pipeline (pi CLI on GitHub
Actions, ported from mattpocock/sandcastle) that implements
`agent:implement` issues into draft PRs; see "Pipeline vocabulary" below.

## Domain glossary

English term (Russian UI term) — definition. UI text uses the Russian term;
code and docs use the English term. Use exactly these words; no synonyms.

- **Trajectory (Траектория)** — the ordered set of Segments the operator
  drew; the thing the whole app exists to produce.
- **Segment (Участок)** — one geometric element of a Trajectory. Kinds:
  **Line (Отрезок)**, **Arc (Дуга)**, **Point (Точка)**. Each Segment
  carries its own Feed.
- **Arc (Дуга)** — stored canonically: Working Plane + start + end +
  direction (**CW (по часовой)** / **CCW (против часовой)**) + radius **R**
  or center. There is no three-point Arc tool; the center is never guessed
  from a middle click (ADR: `docs/adr/0005-cnc-canonical-arcs.md`).
- **Working Plane (Рабочая плоскость)** — the plane the operator draws on:
  XY, XZ, or YZ, with the third coordinate fixed. CNC G17/G18/G19
  conventions.
- **Feed (Подача)** — Segment traverse speed. mm/min in the UI (CNC
  convention), mm/s internally. Does not affect the exported joint angles.
- **Home Point (Исходная точка)** — the 3D point where the drawn Trajectory
  starts; the pen position before the first Segment.
- **Robot Model (Модель робота)** — a named description of a manipulator
  (kinematic chain + joint and dynamic limits) that provides forward and
  inverse kinematics. The v1 model is **MiKo-mini**; other robots are added
  as configuration plus solver selection, not as new math
  (`docs/adr/0008-config-driven-multi-robot.md`).
- **Reachability (Достижимость)** — whether a 3D point (or Segment) lies in
  the Robot Model's workspace and admits joint angles within limits.
  Checked live while drawing and again as a pipeline validation stage.
- **Discretization (Дискретизация)** — sampling a Trajectory into a dense
  point path (fixed step) with cumulative path length; the input to
  kinematics.
- **Motion Plan (План движения)** — time-parameterized joint motion
  derived from the discretized path: joint positions, velocities,
  accelerations, jerks over time, respecting the Robot Model's limits.
- **Motion Profile (Профиль движения)** — the smooth speed schedule along
  the path (S-curve ramp) that the Motion Plan follows.
- **Validation stages (Стадии проверки)** — every pipeline stage validates
  its output and fails with a named, understandable error: discretized
  path → IK results → motion plan → exported arrays. Collision checking is
  a reserved stage, deliberately empty in v1.
- **Exporter (Экспортёр)** — a named output writer. v1 exports:
  **Robot CSV** — `t,q1,q2,q3`, milliseconds and radians, 20 ms row step,
  the file the real robot consumes; **RViz CSV** — the sign-transformed
  variant used for visualization. Formats are pinned by tests
  (`docs/adr/0006-csv-contracts-pinned-by-tests.md`).
- **Project File (Файл проекта)** — versioned JSON (`schemaVersion`)
  storing Working Plane, Home Point, Segments, and view settings; the
  canonical save/load format.

## Pipeline vocabulary

- **Trigger label** — a label (`agent:*`) whose addition starts a workflow.
  Removed by the workflow itself when the run begins.
- **Lifecycle label** — a label the pipeline manages on its own:
  `agent:in-progress` while a run is active, `agent:blocked` when a run
  fails (with a failure comment naming the trigger label to re-add).
- **Subject** — the issue or PR a run is about. Concurrency groups are
  keyed per subject so parallel label events queue instead of racing.
- **Draft PR** — the pull request the implement workflow opens against
  `main`, body starting with `Closes #N` for the triggering issue, drafted
  by the implement agent per the `pr` skill and audited (never edited) by
  the review pass.
- **Spec** — a parent issue whose sub-issues are the Tickets that implement
  it. The implement preflight refuses a Spec labelled directly; when one of
  its Tickets runs, the Spec is pulled in as the `PARENT_CONTEXT` prompt
  arg.
- **Ticket** — an issue the implement workflow can act on: no sub-issues of
  its own (one change per issue). May be standalone or a child of a Spec.
- **Batch triage** — the explore workflow: one run collects every open
  `agent:explore` issue, the agent plans per-issue effects, and a separate
  apply job validates and applies the plan (issue bodies are untrusted
  input and never enter the shell).
- **Canonical triage roles** — the five roles the skills speak in
  (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
  `wontfix`); they map onto the `agent:*` labels in
  [`docs/agents/triage.md`](docs/agents/triage.md).

## Where deeper material lives

- `docs/adr/` — decisions. Pipeline: `0001`, `0002`. Product: `0003`
  (stack), `0004` (own math core, MoveIt stance), `0005` (CNC-canonical
  arcs), `0006` (CSV contracts), `0007` (canvas transform + geometry
  invariants), `0008` (multi-robot via config), `0009` (packaging).
- [`docs/labels.md`](docs/labels.md), [`docs/triage.md`](docs/triage.md),
  [`docs/pr-body.md`](docs/pr-body.md), [`docs/agents/`](docs/agents/) —
  pipeline operations.
- `.sandcastle/CODING_STANDARDS.md` — the code style the workflow agents
  apply; referenced verbatim by prompts.
