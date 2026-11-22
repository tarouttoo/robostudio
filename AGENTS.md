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
- **Code style in adopting repos** — `.sandcastle/CODING_STANDARDS.md` is
  what the workflow agents apply; do not edit it lightly, prompts reference
  it verbatim.
- **Skill conventions** (triage labels, issue-tracker commands, domain-doc
  layout) — read `docs/agents/`; the triage-repro skill also lives under
  `.agents/skills/triage-repro/`.
- **Adopter setup and upstream deviations** — `README.md`.

## Constraints

- Files under `.sandcastle/agent-workflows/` and `.github/workflows/` are a
  verbatim port of upstream (modulo the documented deviations in
  `README.md`). Verify against upstream before restructuring.
- Before finishing: `npm run typecheck` and `npm test` must pass.

## Agent skills

### Issue tracker

GitHub Issues via the `gh` CLI; external PRs are triaged as requests too. See `docs/agents/issue-tracker.md`.

### Triage labels

Pipeline vocabulary: `agent:explore` → `agent:blocked` → `agent:implement` → `ready-for-human`; `wontfix` is applied by closing. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` + `docs/adr/` at the repo root. See `docs/agents/domain.md`.
