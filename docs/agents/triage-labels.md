# Triage Labels

The skills speak in terms of five canonical triage roles. This file maps those roles to the actual label strings used in this repo's issue tracker.

| Label in mattpocock/skills | Label in our tracker        | Meaning                                  |
| -------------------------- | --------------------------- | ---------------------------------------- |
| `needs-triage`             | `agent:explore`             | Maintainer needs to evaluate this issue  |
| `needs-info`               | `agent:blocked`             | Waiting on reporter for more information |
| `ready-for-agent`          | `agent:implement`           | Fully specified, ready for an AFK agent  |
| `ready-for-human`          | `ready-for-human`           | Requires human implementation            |
| `wontfix`                  | — (close the issue instead) | Will not be actioned                     |

These strings are load-bearing: the GitHub Actions workflows in `.github/workflows/agent-*.yml` trigger on the `agent:*` labels, so don't rename them casually. The pipeline also uses non-triage state labels (`agent:review`, `agent:update-branch`, `agent:in-progress`), documented in `docs/labels.md` — don't confuse them with the triage roles above.

When a skill mentions a role (e.g. "apply the AFK-ready triage label"), use the corresponding label string from this table.

When triaging or implementing requests for new agent CLI support (e.g. gemini-cli, cursor), see `docs/agents/adding-an-agent-provider.md` — it lists the CLI/output capabilities a new agent must satisfy and the files to touch.
