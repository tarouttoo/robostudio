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
- **Line (Отрезок)** — a Segment defined by start and end. The Line
  drawing tool has retired (ADR `0016`): Lines remain in the model, in
  existing Project Files, and in exports, but new drawing places
  chained Points and Arcs.
- **Arc (Дуга)** — a Segment defined by Working Plane + start + end +
  direction + radius **R** or center. Direction is **CW (по часовой)**
  or **CCW (против часовой)**. There is no three-point Arc; the center
  is never inferred from a middle click (ADR `0005`). The «Дуга» tool
  joins the chain: an Arc always starts where the previous Segment
  ended (the first at the Home Point), so the radius definition takes
  one click — the Arc's end, with the radius from the numeric field —
  and the center definition two: center, then end.
- **Point (Точка)** — a Segment that moves the pen to a target without
  drawing geometry, as a Move from the previous Segment's end (the
  first from the Home Point). Each Point carries its own Motion Type —
  LIN by default for new Points, PTP in Project Files written before
  the Motion Type existed. The «Точка» tool places the chain: one
  click per Point (ADR `0016`, ADR `0017`).
- **Motion Type (Тип перемещения)** — how a Move travels: **LIN
  (по прямой)** or **PTP (в точку)**. Each Point Segment carries its
  own Motion Type, editable per Move in the segment list the way Feed
  is; the toggle next to the drawing tools sets the type of the next
  Move (ADR `0017`).
- **LIN Move (LIN-перемещение)** — a Move that follows the drawn
  straight line from its start to the target: per-sample
  Discretization, IK and Reachability along the path, drawn solid —
  exactly the path-following behavior the drawn geometry has (ADR
  `0017`).
- **PTP Move (PTP-перемещение)** — a Move that guarantees only arrival
  at the target: the joints interpolate directly between the endpoint
  solutions, the canvas draws the Move dashed, and Reachability is
  checked at the target only (ADR `0016`, ADR `0017`).
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
- **Generation (Генерация)** — one run of the drawn Trajectory through
  the pipeline (the Validation stages in order). The last *successful*
  Generation owns the Charts shown in «Графики» and unlocks the CSV
  export; editing the drawing afterwards locks export until the
  operator runs a new Generation.
- **Exporter (Экспортёр)** — a named output writer.
- **Chart (График)** — one rendered plot of the Motion Plan: joint
  angles/velocities/accelerations/jerks over time (Углы/Скорости/
  Ускорения/Рывки шарниров по времени), the reconstructed cartesian
  path (Восстановленный декартов путь), end-effector velocity and
  acceleration (Скорость/Ускорение рабочего органа по времени), or
  the 3D path view (Запланированный путь в 3D). Charts render
  headless as SVG in the export layer (ADR `0013`); path charts are
  equal-aspect (ADR `0007`); the app shows every chart of the last
  generation in the «Графики» view.
- **Motion Preview (Предпросмотр движения)** — the animated GIF the
  pipeline renders from the last successful Generation's Motion Plan:
  isometric frames (the charts' projection, ADR 0013) showing the
  robot's base and links moving along the Trajectory, the travelled
  part highlighted, the Home Point, and under PTP the actual TCP trace
  from per-frame forward kinematics. At most 300 frames, paced over
  the plan's real duration; written as `robot_motion.gif` next to the
  CSVs (ADR 0018).
- **Robot CSV** — the Exporter output the real robot consumes:
  `t,q1,q2,q3`, milliseconds and radians, 20 ms row step. Format is a
  contract pinned by tests (ADR `0006`).
- **RViz CSV** — the sign-transformed Robot CSV variant used for
  visualization; its transform encodes the mounting convention.
- **Project File (Файл проекта)** — versioned JSON (`schemaVersion`)
  storing Working Plane, Home Point, Segments, and view settings; the
  canonical save/load format.

## Software factory

Factory vocabulary (English only; used in workflows, docs and issues —
see `docs/agents/`):

- **Spec (Спека)** — an issue describing a coherent feature or change,
  decomposed into child Tickets with blocking edges.
- **Ticket (Тикет)** — a child issue of a Spec, small enough for one
  implement Run; carries blocking edges to other Tickets.
- **Task (Задача)** — a unit of factory work performed as a Run: explore,
  implement, review, rebase, prototype. Designing new Tasks is how the
  factory grows.
- **Run (Прогон)** — one execution of a Task on a Runner.
- **Runner (Раннер)** — the disposable machine a Run executes on; any state
  it creates ends up in the Git Host (commits, branches, PRs) or the
  Ticket Tracker (comments, labels).
- **Orchestrator (Оркестратор)** — keeps track of Runners, triggers them on
  events and schedules, and handles Run errors.
- **Ticket Tracker (Трекер задач)** — where Tasks are requested and
  tracked; the channel for agent–human communication: labels, comments,
  verdicts.
- **Git Host (Git-хост)** — where branches, pull requests and reviews live.
- **Observability Platform (Платформа наблюдаемости)** — shows the whole
  factory at once: costs and success rates of Runs.
- **Auto-Rebase (Авторебейз)** — the Task that keeps open agent PRs
  mergeable with their base; fires when a PR merges (plus a backup
  schedule) and starts only in an Agent-quiet state.
- **Agent-quiet (Без активных агентов)** — the state when no agent Runs are
  in progress; a precondition for Auto-Rebase.
- **Improvement (Улучшение)** — a recommendation Ticket the factory
  generates about the codebase itself, only on explicit human request; a
  human reviews Improvements before they enter the pipeline.
- **Frontier (Фронтир)** — the Tickets of a Spec whose blocking edges are
  all resolved; the next wave of implement Runs.
- **Integration Branch (Интеграционная ветка)** — the branch of one Spec
  where completed Ticket branches are merged; the Spec reaches the Git
  Host's main line as a single merge from it.
- **Merger (Мерджер)** — the Run that merges completed Ticket branches into
  the Integration Branch and closes their Tickets.
- **Release (Релиз)** — an app distribution cut by pushing a `v*` tag: the release
  workflow builds the packaging targets (ADR `0009`) into a **draft** GitHub
  release, and a human publishes it (a one-way door). The tag is the single
  source of truth for the version; `package.json` is not read.
- **Retro (Ретро)** — a human-invoked retrospective over factory runs
  (Actions run URLs in, factory-improvement PR out); harvests the review's
  "Rules this review wanted and could not find" into checks or standards.
  See `docs/agents/retro.md` (ADR `0014`). Never runs per ticket.
- **Evidence (Доказательства)** — the artifacts a run attaches to prove its
  claims: command output for code claims, before/after screenshots
  (`/tmp/evidence/`, uploaded as workflow artifacts) for UI claims.
  Audited by the reviewer.
