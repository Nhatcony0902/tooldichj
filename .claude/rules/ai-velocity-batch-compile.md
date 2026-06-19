---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# AI-Velocity — Batch-Implement, Verify Once, Triage Errors in Parallel

## Rule

For any large or multi-file task (refactor, big update, multi-system change, library extraction), DO NOT use the human-paced **edit → verify → wait → fix → edit** loop one change at a time. Instead:

1. **Blind-implement the whole batch** — write/edit ALL files the task needs up front, without verifying between edits. The AI holds the full change set in context and reasons across files faster than any compile/build/typecheck/test cycle runs.
2. **Verify ONCE** at the end — a single compile/build/typecheck/lint/test pass.
3. **Collect ALL errors at once** — read the full error + failure set in one pass; do not stop at the first error.
4. **Fix the entire error set in parallel** (parallel sub-agents / worktrees / batched edits), then verify a second time.

Two verification cycles for a 20-file refactor — not twenty.

## Why

The AI edits at machine speed; the verification round-trip (compile, bundle, typecheck, test suite, domain reload) runs at human-wait speed and is the dominant cost. Per-edit verify-gating throws away the AI's speed advantage and multiplies flake opportunities. The human instinct to "verify after each change to localize the error" is mis-calibrated for AI — a human verifies often because they hold little context; the AI holds the whole change set and triages a batch of errors more cheaply than serializing verifications.

## How to apply

- **Before a large task** — enumerate ALL files to touch; edit them all blind, THEN verify.
- **Parallelize independent file groups** via sub-agents/worktrees (see `parallelize-batch-work.md` + `parallel-teammate-git-index-race.md`).
- **After the single verify** — collect the full error set + full failure set, then fix in one more batch.
- **Reserve incremental verification** for genuinely exploratory work where the API is unknown and a single probe de-risks the rest.
- **Engine-specific gotchas** (domain-reload polling, stale lockfiles, MCP-timeout ≠ disconnect) live in the owning kit's rule.

## Related

- `rules/ai-driven-design.md` — tools emit facts; AI reasons. Same philosophy, applied to the verify loop.
- `rules/parallelize-batch-work.md` — fan out independent work instead of sequencing.
- `rules/coding-guidelines.md` §5 — verify before claiming done; this rule says verify *once at the end*, not *never*.
- `docs/ai-velocity-batch-compile.md` — anti-patterns, mindset notes, engine examples, history.
