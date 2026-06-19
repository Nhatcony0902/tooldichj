---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Parallelize Batch Work — Fan Out, Don't Sequence

For any batch operation with **>30 independent items** OR **>5 minutes** estimated wall time, default to a parallel execution strategy.

## Rule

When you find yourself about to write a sequential loop over a batch (subagent processing 300 items one-by-one, `for url in list; do ...; done`, single-threaded HTTP loops), STOP and pick a parallel strategy from the strategy table in `docs/parallelize-batch-work.md`.

**Pre-flight (≥2 independent units):** before sequencing ANY multi-step op, count independent units (distinct repos/files/PRs/tasks). If count ≥ 2, state your decision in one line: "parallelizing N units" or "sequencing because [dependency]". Default bias = parallelize; sequencing requires a stated reason. **Working-tree safety:** parallel sub-agents on the SAME git repo SHARE the working tree — either sequence inside one sub-agent or use `git worktree add`. DIFFERENT repos are always safe.

## Strategy at a glance

- HTTP/network I/O → one Node/Python process with `Promise.all` worker pool (20 concurrent)
- File IO at scale → `xargs -P` or GNU `parallel` (8 / CPU count)
- AI judgment → N background sub-agents, each owns a chunk (4–8, cap 8)
- Mixed → Phase 1 parallel fetch (script), Phase 2 parallel reason (sub-agents)
- Independent shell commands → multiple Bash tool calls in one message

## Full details

Full reference (complete strategy table with rationale, step-by-step how-to-apply, anti-patterns, rule interactions, and the "could a colleague have shipped this faster" self-test): `docs/parallelize-batch-work.md`.

Smoke-test gate before scaling: `preview-first-batch.md`. Concurrency-degree decisions: `always-ask-on-unresolved.md`.
