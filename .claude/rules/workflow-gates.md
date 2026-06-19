---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Workflow Gates — HARD-GATE Contract

Universal rule for `t1k:cook`, `t1k:fix`, and any skill that uses HARD-GATE enforcement blocks.

## What a HARD-GATE is

A HARD-GATE is a mandatory stopping point in a workflow. Passing it requires satisfying ALL listed conditions — none may be skipped without an explicit user override. Skill bodies embed `<HARD-GATE>` XML tags as machine-readable markers; this rule defines their normative contract.

## Universal HARD-GATE contract

1. **No bypass without a named user override.** Each HARD-GATE must state the allowed override (flag, explicit user instruction, or "no override"). Silence = not bypassable.
2. **Evidence required, not assertion.** Stating "this is fine" without artifacts does not satisfy a gate. The gate passes when the concrete deliverable (artifact, test run, scout summary, root-cause sentence) exists.
3. **Gate failures stop the workflow.** When a gate fails, the skill MUST use `AskUserQuestion` to surface what failed and offer concrete options — never silently patch around it.
4. **3+ failed attempts → escalate.** After 3 unsuccessful attempts at any gated step, STOP and question the architecture with the user. Do not attempt a 4th fix without a different approach.

## Gate types used by cook + fix

| Tag | Gates | Default override |
|---|---|---|
| `<HARD-GATE>` | Plan/diagnose must exist before coding/fixing | `--fast` (cook) / `--quick` (fix) |
| `<HARD-GATE-SCOUT-FIRST>` | Codebase scan before questions or hypotheses | None |
| `<HARD-GATE-EXACT-REQUIREMENTS>` | 5 concrete requirement answers before plan | Skip when input IS a plan.md path |
| `<HARD-GATE-EXACT-ROOT-CAUSE>` | 6-slot root-cause before fix proposal | None |
| `<HARD-GATE-NO-SIDE-EFFECTS>` | 5-proof verification before finalize | `--no-test` downgrades item 2 to warning |

Full gate content per skill: `skills/t1k-cook/SKILL.md`, `skills/t1k-fix/SKILL.md`.

## How to apply

Skill bodies that contain `<HARD-GATE>` blocks cite this rule file in their preamble. They do NOT re-state the universal contract here — only their skill-specific gate content. The universal contract is this file.

## Related

- `rules/agent-anti-rationalization.md` — evidence-first discipline enforced inside gates
- `rules/always-ask-on-unresolved.md` — gate failure → `AskUserQuestion` (not silent bypass)
- `rules/coding-guidelines.md` §4 — "Goal-Driven Execution"
