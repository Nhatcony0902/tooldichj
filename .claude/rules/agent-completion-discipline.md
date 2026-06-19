---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Agent Completion Discipline — Commit Before Summary

**Resolves:** unity#74 (tail-of-thought stop — agent exits without committing pending work at >150K tokens)

## Rule

**COMMIT BEFORE YOU SUMMARIZE.** Any agent that has made edits, written files, or completed implementation work MUST commit + push those changes BEFORE composing any narrative summary, wrap-up, or report.

Order (mandatory): dispatch pending `Write`s → `git add` + `commit` + `push` → THEN summarize.

**Budget checkpoint (MANDATORY for sub-agents) — RELATIVE to the agent's budget, NEVER a flat token number.** Fire at whichever ceiling comes first:

- **% of the agent's model context window** — ~75% of a ≤200K window (≈150K); **~55% of a 1M window (≈550K)** (tighten the % as the window grows). A flat "150K" is wrong on a large window (fires at ~15%) — derive from the agent's `model:`; **check the `model:` when authoring/updating it.**
- **~80% of `maxTurns`** — tool-heavy work (multi-PR merges, refactors) hits the turn cap before any token cap (theonekit-core#528: `maxTurns: 45` reached at ~200K tokens). Size `maxTurns` to the task.

On reaching either: (1) `git status` → commit any changes NOW; (2) dispatch pending Writes; (3) only then resume or summarize.

## Anti-pattern

"Let me check one more thing before committing…" near a budget ceiling is the symptom — interrupt it; commit first, investigate after.

## Why

unity#74: 7/8 sub-agent stops reached 168–212K tokens mid-investigation and exited `completed` without committing (needed finisher agents). theonekit-core#528: a *flat* threshold mis-fires — ~15% on a 1M opus, and ignores `maxTurns`.
