---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Preview-First for Batch / Bulk Operations

**MANDATORY.** Before any batch / bulk / long-running operation, run a small smoke-test sample first, surface the result, and obtain explicit user confirmation (via `AskUserQuestion`) before scaling to the full set.

## When this rule fires

Either trigger, whichever comes first:

| Trigger | Threshold |
|---|---|
| Estimated wall-clock time | **> 2 minutes** |
| Item count in the batch | **> 10 items** |

If you cannot estimate, the trigger fires by default.

## How to apply

1. **State the estimate** before the first tool call: `"Plan: smoke N=5 (~30s), then full N=285 (~17h) on your go-ahead."` Unknown estimate → say so explicitly.
2. **Smoke on the smallest meaningful N** (5 items / `--limit 5` / 1-3 records / lowest-traffic env).
3. **Surface smoke output** — wall-clock per item, output values, anomalies.
4. **`AskUserQuestion`** to gate the full run, even on a clean smoke. Options: proceed / investigate / re-smoke / abort.
5. **Never silently scale.** A clean smoke ≠ auto-permission.

If the smoke wrote files in place, list them and the rollback command before proceeding.

## See also

- `docs/preview-first-batch.md` — full examples, the 2026-04-30 incident postmortem, rule interactions, self-test
- `~/.claude/rules/always-ask-on-unresolved.md` — the strict-ask mandate this depends on
- `~/.claude/rules/coding-guidelines.md` §4–§5 — broader before/after verification gates
