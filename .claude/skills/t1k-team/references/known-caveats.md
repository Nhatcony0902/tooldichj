---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Known caveats — Agent-Teams harness gaps

Operational gaps in the underlying Agent Teams harness that this skill cannot fix from inside the SKILL body alone. Each entry lists the symptom, what to do, and (where applicable) the GitHub issue tracking the upstream fix.

## 1. `isolation: "worktree"` is unreliable

**Symptom:** Spawning `Agent(..., isolation: "worktree")` is documented to give each teammate its own git worktree + auto-created branch, BUT in practice this flag silently no-ops for some teammates. In the `cook-triage-260524-0231` run, 5 of 7 teammates ended up sharing the main checkout on whatever branch happened to be current — no auto-created branch, no isolated worktree. There is no error from the harness; the flag just doesn't apply.

**Detection:** Right after spawning, ask each teammate to print `git rev-parse --abbrev-ref HEAD` and `git worktree list`. If they're on the lead's branch (not a fresh `agent-XX-...` branch), the flag was ignored.

**Workaround:** Treat `isolation: "worktree"` as best-effort. Immediately after spawn, the lead MUST `SendMessage` each teammate explicit branch-creation instructions:

```
Before any other work:
  cd "<absolute repo path>"
  git stash push -m "<teammate-id>-pre" || true
  git fetch origin
  git checkout main
  git pull --ff-only
  git checkout -b <feature-branch>
  git status   # confirm clean
```

Include the branch name in the spawn prompt rather than letting the teammate invent one — this also doubles as a recovery hint if the harness DID create an isolated worktree (the teammate just re-checks out the same branch in its worktree).

**Status:** Tracked upstream; until fixed, the explicit-checkout fallback is the contract.

## 2. JSON `{type: "shutdown_request"}` is often ignored

**Symptom:** `SendMessage(to: <teammate>, message: {type: "shutdown_request"})` is the documented graceful-shutdown channel. In practice teammates often go *idle* (no further activity, no `shutdown_response` returned) but do NOT exit their tmux pane. The lead is left holding 5+ idle zsh splits.

**Workaround:** Treat `shutdown_request` as advisory. After ~30s with no `shutdown_response`, fall back to `tmux kill-pane` directly. The team-operations.md cleanup recipe ("Successful Completion Cleanup" section) covers the LEAD_PANE-capture pattern that avoids killing the lead by accident.

**Status:** Tracked upstream; until fixed, the timeout + `kill-pane` fallback is the contract.

## 3. `tcd` alias is missing in the spawn subshell

**Symptom:** Agent Teams launches teammate sessions via a subshell that does NOT source the user's interactive `.zshrc`. Any aliases (e.g. `tcd` for "tmux-aware cd to a temp project dir") resolve to `command not found` and the teammate crashes at launch before `claude` even starts. In the `cook-triage-260524-0231` run, `w5` failed this way because the backend wrapper tried `tcd '<path>' && claude ...`.

**Detection:** Watch for `tcd: command not found` or similar in the teammate's first few stdout lines. The pane will exit immediately.

**Workaround:** When constructing the spawn command (or the subshell wrapper the harness uses), use POSIX `cd` instead of interactive aliases. If the harness wrapper hardcodes `tcd`, that's a harness bug — file an issue against the harness repo, not against t1k-team.

**Status:** Tracked upstream; the consumer-side mitigation is to never rely on shell aliases in any teammate-facing command string.

## Cross-references

- Cleanup procedure (worktrees, panes, sentinels): `team-operations.md` § Successful Completion Cleanup
- Abort flow (when the run itself is being abandoned): `team-operations.md` § Abort & Cleanup
- Done-means-shipped contract (lead must babysit each PR to merge): `../SKILL.md` § Definition of Done
