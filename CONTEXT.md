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
  export layer), `0016` (chained Points, PTP Moves; drawing tools), `0018` (Motion
  Preview GIF exporter).
- [`docs/labels.md`](docs/labels.md), [`docs/triage.md`](docs/triage.md),
  [`docs/pr-body.md`](docs/pr-body.md), [`docs/agents/`](docs/agents/) —
  pipeline operations.
- `docs/adr/0015-prototype-measured-miko-mini-geometry.md` — the measured
  MiKo-mini constants (links, tool offset, limits, default Home Point).
- `.sandcastle/CODING_STANDARDS.md` — the judgment rules the review pass
  applies; grown via Retro harvests (ADR 0019).

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
- **v2 routing** — `agent-implement.yml` routes by issue shape (ADR 0019):
  a Spec with tickets → the exploration-notes runner; a `spec`-marked
  issue without tickets → the to-tickets runner; a child-of-spec Ticket →
  the v2 implement runner (branch only, no PR); a standalone issue → the
  classic PR chain.
- **To-tickets runner** — the AFK decomposition: the agent plans the
  Tickets, the script applies the plan (native sub-issue + `blocked_by`
  edges, verified), labels every Ticket `ready-for-agent` with
  `AGENT_PAT`, posts a list comment on the Spec, and re-adds
  `agent:implement` so the next run explores.
- **Exploration notes** — markdown notes on `agent/spec-<n>-notes` plus a
  marker comment on the Spec; every implement runner for that Spec's
  Tickets reads them as shared context (optional, never a prerequisite).
- **Merger** — `agent-merge.yml` + `merge-spec/merge-spec.ts`: merges each
  completed wave into `agent/spec-<n>-integration`, closes the Tickets
  deterministically (close events drive the next wave), and opens one
  draft PR Spec → main labelled `agent:review` when the Spec is complete.
  All merger runs serialize repo-wide; retries are
  `gh workflow run agent-merge.yml -f spec=<n>`.
- **Auto-Rebase janitor** — `agent-rebase-janitor.yml`: after any merge
  (and nightly), sweeps conflicting `agent/issue-*` PRs and labels them
  `agent:update-branch` with `AGENT_PAT`; gated on Agent-quiet.
- **Improve button** — `agent-improve.yml` (`gh workflow run`, optional
  `focus` input): files ≤ 5 `improvement` issues via the vendored skill,
  always waiting for human review.
- **Canonical triage roles** — the five roles the skills speak in
  (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`,
  `wontfix`); their mapping to this repo's label strings lives in
  [`docs/agents/triage-labels.md`](docs/agents/triage-labels.md).
