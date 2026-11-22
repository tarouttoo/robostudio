# Auto-merge after a clean review (the last human click, automated)

After `agent:review` succeeded the PR sat ready and untouched: the review
posted as a regular review (the payload has no verdict field, so nothing ever
"approved" formally) and the merge happened only when the maintainer clicked
merge. ADR 0010 removed the human from the label loop; the merge click was the
one manual step left in the happy path (ticket → `agent:implement` → draft PR
→ `agent:review` → *human*). This ADR removes it.

## Design

- **Clean review = zero inline comments.** The extracted review payload
  (`review_payload.json`, contract in
  `.sandcastle/agent-workflows/review/extraction.md`) has no verdict field, so
  "clean" is defined structurally: `inlineComments` is empty. The review step
  already fails the run on errors, so anything that reaches this step posted
  findings successfully.
- **Clean → request squash auto-merge.** A new step after "Mark PR ready"
  runs `gh pr merge --squash --auto --delete-branch`. The repo's
  `allow_auto_merge` setting is the feature's activation switch and kill
  switch, same reasoning as the tenderagent gate's hold conditions.
- **The request rides AGENT_PAT, falling back to GITHUB_TOKEN** (same pattern
  as implement's label step). Two reasons: a GITHUB_TOKEN-authored PR refuses
  an auto-merge request from its own GITHUB_TOKEN, and the PAT keeps the
  eventual merge attributed to the maintainer rather than
  `github-actions[bot]`. If both tokens fail the step fails into the standard
  blocked path — a merge request that silently didn't happen would be worse.
- **Findings hold loudly.** Non-empty `inlineComments` posts one comment with
  the count and the retry loop (`agent:implement-pr`, then re-add
  `agent:review`) and exits 0: a held PR is a legitimate outcome, not a
  workflow failure.

## What is deliberately not done

- **No CI gate in the workflow.** Without branch protection an auto-merge
  request merges as soon as the PR is mergeable — red CI included. The proper
  CI gate is branch protection requiring `ci.yml` checks, which would make
  auto-merge wait for green; it is recommended but not enabled here, because
  `windows-latest` CI is red on main (the converter's path-separator test bug
  from ADR 0010's port) and protection would hold every PR until that is
  fixed. Enable protection together with that fix.
- **No tenderagent-style merge gate.** Upstream's deterministic gate
  (review verdict, door cross-check, denylist, changed-line ceiling, blocker
  check) needs the richer verdict payload and the REVIEW_PAT review identity;
  robostudio runs the simpler template review. This is the minimal automation
  for the simpler pipeline; porting the gate stays an option if the repo
  grows riskier changes (its denylist would cover `.github/`,
  `.sandcastle/`, lockfiles).

## Deviations

Upstream sandcastle's template review workflow stops at "mark ready" and has
no merge step; tenderagent's merge gate is the richer sibling. This step is a
documented deviation of the simpler template variant.
