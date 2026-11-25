# AGENTS.md

robostudio is a CNC-style trajectory studio for the MiKo-mini manipulator
(TypeScript, Electron + React + Vite), written from scratch as a rewrite of
the earlier Python `roboboba` prototype. The repo also hosts a label-driven
agent pipeline (pi CLI on GitHub Actions), ported from mattpocock/sandcastle
via agent-pipeline-template: agents run here via the `agent:*` labels, and
humans and coding agents edit both the product code and the pipeline code.

## Navigation

- **Naming or domain questions** — read `GLOSSARY.md` (domain glossary) first.
  UI text is Russian, code and docs are English; the glossary maps the two
  and forbids synonyms.
- **Changing pipeline behaviour** — check `docs/adr/` for prior decisions;
  add an ADR when making a non-obvious, hard-to-reverse choice.
- **Code style** — `.sandcastle/CODING_STANDARDS.md` holds the judgment
  rules the review pass applies; grow it only through Retro harvests
  (ADR 0019), never by casual edits.
- **Skill conventions** (triage labels, issue-tracker commands, domain-doc
  layout) — read `docs/agents/`; the triage-repro skill also lives under
  `.agents/skills/triage-repro/`.
- **Pipeline history and how it diverged from its origins** — `README.md`.

## Constraints

- Non-trivial changes ride the pipeline: publish a Spec issue first, break
  it into child Tickets, and let the `agent:*` label flow implement and
  review them. Direct one-shot edits in the working tree are the exception
  — agree it with the operator before starting. Every change request is
  assessed for this each time, not assumed.
- The operator pushes every change to GitHub immediately and works from two
  computers, so `origin/main` can move between (or during) sessions and any
  handoff's picture of the remote may be stale. Always `git fetch` and rebase
  onto `origin/main` before starting work; don't trust remembered commit
  hashes — re-read the log.
- Pipeline files (`.sandcastle/agent-workflows/`, `.github/workflows/`)
  are ours to change: the verbatim-port constraint was removed by ADR 0019,
  and the course / upstream sandcastle are references, not authorities.
  Document substantial behavior changes in `docs/adr/`.
- Before finishing: `npm run typecheck` and `npm test` must pass.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI; external PRs are triaged as requests too. See `docs/agents/issue-tracker.md`.

### Triage labels

Pipeline vocabulary: `agent:explore` → `agent:blocked` → `agent:implement` → `ready-for-human`; `wontfix` is applied by closing. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
