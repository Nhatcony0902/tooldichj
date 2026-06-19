---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Parallel Teammate — Race-Free Git Commit & Branch Primitive

## Rule

Parallel teammates share a single git working tree, a single index, AND a single `HEAD`. Two anti-patterns are BANNED:

1. **Two-step `git add` + `git commit`** — any teammate's `git add` affects the shared index; a concurrent `git commit` sweeps in files staged by another teammate (the first then commits an empty diff, losing work).
2. **`git checkout -b` (or `switch`/`checkout`) from any teammate but the lead** — moves shared `HEAD`, so a sibling's commits land on the wrong branch; recovery needs cherry-pick + `git branch -f`.

**Use the pathspec commit form, and lead-allocated branches/worktrees:**

```bash
# CORRECT — atomic, index-independent commit
git commit -m "<message>" -- path/to/file1 path/to/file2

# CORRECT — lead creates the branch BEFORE fan-out, then spawns; teammates only commit
git checkout -b feature-batch-x && git push -u origin feature-batch-x

# BANNED for teammates: git add . / -A, git commit -a, two-step add+commit,
#                       git checkout/switch [-b] <branch>, git branch -f
```

The pathspec form bypasses the index (only named paths are snapshotted) — but `git commit -- <newfile>` fails on an *untracked* file, so new files need `git add <explicit-paths>` first (still race-safe: an explicit-path add is not a sweep). Pre-allocated branches mean teammates never move `HEAD`. Divergent branches → lead pre-creates a `git worktree` per teammate.

## Full details

Race mechanics, complete banned-pattern list, per-teammate-worktree recipe, pre-commit verification, narrow exceptions, HEAD-recovery, and the spawn-brief enforcement contract: `docs/parallel-teammate-git-index-race.md`.

## Related

- `rules/parallelize-batch-work.md` · `rules/agent-completion-discipline.md` · `skills/t1k-team/SKILL.md` § "Spawn Brief — Mandatory Inclusions"
