# robostudio

A CNC-style trajectory studio for the MiKo-mini 3-DOF manipulator: an
operator draws a trajectory on a working plane using CNC conventions —
lines and arcs (radius + direction, or center), feed in mm/min — and the
app turns the drawing into CSV files that drive the real robot, plus plots
of every stage of the planned motion.

TypeScript throughout: Electron + React + Vite. Builds target Windows and
Linux (portable zip). The math core is implemented in-house behind
`RobotModel` and `Planner` interfaces (see `docs/adr/`), so further robots
with different kinematics are added as configuration, not as new math.

## Status

v1 is under construction. The plan lives in GitHub issues as a Spec with
child Tickets; the agent pipeline below implements them into draft PRs.

## Development

```sh
npm ci
npm run dev       # Vite dev server + Electron window (React renderer)
npm run build     # renderer (vite) + main (esm) + preload (cjs) into dist/
npm test          # vitest: pipeline tests + product unit tests
npm run typecheck # tsc --noEmit for node/pipeline + renderer configs
npm run lint      # oxlint (the TS compiler is v7 native; tsc-based linters
                  # do not support it yet)
```

### Layer structure

Product code lives under `src/` in the layers fixed by ADR 0003 and
guarded by `src/layers.test.ts`:

```text
src/
├── core/        # math core shared by everything; zero runtime deps (ADR 0004)
├── kinematics/  # RobotModel implementations: chains, limits, FK/IK
├── motion/      # Planner implementations: discretization → Motion Plan
├── export/      # Headless pipeline (validation stages) + Exporters:
│                #   Robot CSV, RViz CSV (ADR 0006, 0012) + headless
│                #   SVG charts from the Motion Plan (ADR 0013)
├── project/     # versioned Project File schema + (de)serialization
├── app/         # Electron main process: window lifecycle, preload bridge
└── ui/          # React renderer (Russian UI text per GLOSSARY.md)
```

Dependencies point strictly downwards: `core` imports nothing; `ui`
never imports `app` — the sandboxed renderer reaches the main process
only through the preload bridge (ADR 0003).

The agent pipeline code lives under
`.sandcastle/` and `.github/workflows/` and is kept verbatim from the
template it came from (see [Agent pipeline](#agent-pipeline)); the
product CI workflow `ci.yml` is the one addition there.

## Builds and releases

On a `v*` tag, the release workflow builds with electron-builder and opens
a draft GitHub release:

- Windows: NSIS installer + portable zip
- Linux: portable zip

## Agent pipeline

This repo ships the label-driven agent pipeline from
[`agent-pipeline-template`](https://github.com/tarouttoo/agent-pipeline-template)
— a port of [mattpocock/sandcastle](https://github.com/mattpocock/sandcastle)
(commit `a53e227250fb51df0ad54155b85fecc1c090c937`) running the pi CLI as
the coding agent, not Claude Code. The pipeline files (`.github/workflows/`,
`.sandcastle/agent-workflows/`) are a verbatim copy of that template; its
README remains the reference for upstream deviations and pipeline internals.

| Label | Workflow | What happens |
|---|---|---|
| `agent:implement` (issue) | `agent-implement.yml` | Preflight gates (refuses PRD-shaped issues / issues with an open collaborator PR; a child-of-spec Ticket passes and its parent Spec is pulled in as context), then an agent implements on an isolated branch and opens a draft PR that closes the issue, then labels the PR `agent:review`. |
| `agent:implement` (PR) | `agent-implement-pr.yml` | Processes review feedback on an existing PR: replies to threads, addresses inline comments, pushes with a lease. |
| `agent:review` | `agent-review.yml` | Reviews the PR, self-fixes findings on the branch, posts a PR review, replies to threads, marks the PR ready, then requests a squash auto-merge on a clean review with green CI (ADR 0011). |
| `agent:update-branch` | `agent-update-branch.yml` | Resolves merge conflicts with `main` (always resolve, never abort) and pushes. |
| `agent:explore` | `agent-explore.yml` | Batch triage: one agent run plans effects for every open `agent:explore` issue; a separate apply job validates the plan and applies it. Supports `workflow_dispatch` dry-run. |
| `ready-for-agent` (issue) | `agent-convert.yml` | The ready-for-agent converter: a Ticket labelled `ready-for-agent` is evaluated on labelling and re-scanned whenever another issue closes; when the last blocker closes, the label is swapped for `agent:implement` (added with `AGENT_PAT` so the cascade fires), otherwise a comment names the open blockers. |

Every agent run posts a failure comment with a reason and the workflow-run
link, and relabels the subject `agent:blocked`. Retrying means re-adding the
trigger label named in that comment. For a converted Ticket — one that was
waiting on `ready-for-agent` — retry it by removing and re-adding
`ready-for-agent`.

### Required repository settings

1. **Allow GitHub Actions to create and approve pull requests** (repo →
   Settings → Actions → General → Workflow permissions). The implement
   workflow (`agent-implement.yml`) opens its draft PR with `GITHUB_TOKEN`,
   and with this setting off — the default for new repositories and
   organizations — GitHub rejects that PR creation. Enable it in the
   settings UI, or from the CLI (the `read` default is safe here: every
   workflow declares its own `permissions` block):

   ```sh
   gh api -X PUT repos/tarouttoo/robostudio/actions/permissions/workflow \
     -f default_workflow_permissions=read \
     -F can_approve_pull_request_reviews=true
   ```

   With the setting off, the failure is easy to misread: `gh pr create` in
   "Open draft PR" is piped through `tail`, so that step stays green and
   the run instead fails at "Request automated review" with
   `no pull requests found for branch`, leaving the issue `agent:blocked`
   with an opaque reason. Setting `AGENT_PAT` does not bypass this: the
   "Open draft PR" step always uses `GITHUB_TOKEN`.

2. **Create the labels** the workflows expect — the full reference
   (trigger, lifecycle, and verdict labels, what each one does, and the
   setup command) lives in [`docs/labels.md`](docs/labels.md).

### Required secrets (repo → Settings → Secrets and variables → Actions)

- `ZAI_API_KEY` — API key for the pi provider (required by every agent run).
- `AGENT_PAT` — a personal access token with `contents`, `issues` and
  `pull-requests` write (classic: `repo` scope; workflow-touching changes
  also need the `workflow` scope). Required in practice: label events fired
  by `GITHUB_TOKEN` never start other workflows, so without `AGENT_PAT` the
  automatic `implement → review` cascade silently degrades (the review
  label is added but never fires). The implement checkout also prefers
  `AGENT_PAT` for pushing.

The provider/model is set per workflow via `AGENT_PROVIDER` and
`AGENT_MODEL` env vars; nothing in code needs to change to tune them.
Currently `zai` / `glm-5.3-flash:max` — the `:max` suffix is pi's thinking
level, passed verbatim through the sandcastle print command to the pi CLI.

### One-way doors for the review pass

Anything that ships outward is treated as irreversible: the robot CSV and
RViz CSV formats (pinned by golden tests, `docs/adr/0006-csv-contracts-pinned-by-tests.md`),
the versioned project-file schema, and release publishing. The review pass
reads this section when auditing the Merge Danger call in the PR body.

## Deviations

This repo tracks `agent-pipeline-template` (itself a sandcastle port);
where it deliberately diverges:

1. **Agent model** — every workflow runs `zai` / `glm-5.3-flash:max` via the
   env vars; the `:max` suffix is pi's thinking level, passed verbatim
   through the sandcastle print command.
2. **The `ready-for-agent` converter** — kept from the template even though
   upstream sandcastle lacks it; it is what lets the skills' to-spec /
   to-tickets flow feed the pipeline without manual relabelling
   ([ADR 0010](docs/adr/0010-ready-for-agent-converter.md)).

## Attribution

Pipeline files ported from
[mattpocock/sandcastle](https://github.com/mattpocock/sandcastle)
@ `a53e227250fb51df0ad54155b85fecc1c090c937` — © Matt Pocock, MIT.
Template scaffolding — © tarouttoo, MIT. See `LICENSE`.
