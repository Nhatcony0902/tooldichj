---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Branch Discipline — Always Return to Main After Feature Work

<!-- updated 260523 -->

## Rule

After finishing work on a feature/bug/refactor branch (committed, pushed, PR merged), you MUST:

1. **Switch back to the primary branch** — `main` for normal repos; the worktree's intended branch for worktrees.
2. **Pull the latest** — `git fetch && git pull --ff-only` so your local matches origin.
3. **Delete the merged branch locally** — `git branch -D <branch>` (use `-D` not `-d` because squash-merge produces a new SHA so git's ancestry check sees the branch as "not merged").
4. **Verify clean state** — `git status --short` should be empty.
5. **Confirm in the report** — explicitly state "back on main, working tree clean."

**Worktree exception:** if the branch has a `+` prefix in `git branch`, it is in active use in a worktree — DO NOT delete it. Report as "in worktree, left untouched."

Full worked example, multi-kit loop, and "when NOT to delete" cases: `docs/branch-discipline.md`.

## Why

Stale local branches cause the next `git pull --ff-only` to fail (local has commits main doesn't), masking that work was already merged.
