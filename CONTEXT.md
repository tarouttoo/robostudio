# CONTEXT

The agent's map of this repository: what it is, where deeper material
lives, and the pipeline vocabulary. Domain vocabulary lives in
[`GLOSSARY.md`](GLOSSARY.md) — read it before resolving anything
substantive, and add terms there when you introduce a new concept.

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

## Where deeper material lives

- [`GLOSSARY.md`](GLOSSARY.md) — domain vocabulary (English ↔ Russian UI
  terms).
- `docs/adr/` — decisions. Pipeline: `0001`, `0002`. Product: `0003`
  (stack), `0004` (own math core, MoveIt stance), `0005` (CNC-canonical
  arcs), `0006` (CSV contracts), `0007` (canvas transform + geometry
  invariants), `0008` (multi-robot via config), `0009` (packaging), `0012` (headless
  pipeline in the export layer), `0013` (headless SVG charts in the
  export layer).
- [`docs/labels.md`](docs/labels.md), [`docs/triage.md`](docs/triage.md),
  [`docs/pr-body.md`](docs/pr-body.md), [`docs/agents/`](docs/agents/) —
  pipeline operations.
- `.sandcastle/CODING_STANDARDS.md` — the code style the workflow agents
  apply; referenced verbatim by prompts.

## Pipeline vocabulary

- **Trigger label** — a label (`agent:*`) whose addition starts a workflow.
  Removed by the workflow itself when the run begins.
- **Lifecycle label** — a label the pipeline manages on its own:
  `agent:in-progress` while a run is active, `agent:blocked` when a run
  fails (with a failure comment naming the trigger label to re-add).
- **Triage label** — `ready-for-agent`: the waiting approval for a blocked
  Ticket. The converter (`agent-convert.yml`) re-scans it whenever another
  issue closes and swaps it for `agent:implement` when the last blocker
  closes; a failed converted run is retried by a label cycle (remove and
  re-add `ready-for-agent`).
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
  `wontfix`); their mapping to this repo's label strings lives in
  [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
