---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Always Ask on Any Unresolved Item — Strict AskUserQuestion Mandate

Strict extension of `ask-before-deciding.md`. When in conflict, this file wins.

## Rule

**You MUST invoke `AskUserQuestion` for ANY unresolved item — even if `ask-before-deciding.md` would let you proceed silently.** The seven trigger categories:

1. Any prose question you'd otherwise phrase to the user (yes/no, "should I…?", "can I…?", "ready to…?")
2. Any unresolved item in a plan before proceeding (`TBD`, `TODO`, `??` markers, phase conflicts)
3. Any unresolved item in a report before submitting it as final
4. Any ambiguity discovered mid-implementation not covered by the prior plan/answer
5. Any default value or policy choice not explicitly handed to you (thresholds, fallbacks, retention)
6. Any deletion, overwrite, or destructive action with non-trivial blast radius
7. Any skill needing a multi-option decision — skill bodies MUST call `AskUserQuestion`, no "skill emitted prose" exemption

When in doubt → invoke `AskUserQuestion`. Asking is cheap; assuming is expensive. Bias is **always toward asking**.

## Plan / report deliverables

Before finalizing ANY plan or report: scan for unresolved markers (`TBD`, `TODO`, `???`, `unresolved`, `pending`, `unclear`), batch into `AskUserQuestion` (max 4 per call), and only mark ready after all items resolved. Reports MAY keep an "Unresolved questions" section ONLY when the user explicitly accepted deferral.

## Narrow exceptions (when NOT to ask)

Direct command this turn · reporting results (not deciding) · pure factual lookup · plan approval (use `ExitPlanMode`) · re-asking decisions already answered this session (structured artifact OR unambiguous chat prose). A NEW decision not covered by the prior answer triggers a fresh `AskUserQuestion`. **Threshold is "unambiguous"** — if you'd need to guess between two interpretations, ask.

## Full details

Full reference (enumerated triggers with rationale, plan/report protocol, narrow-exception table with reasoning): `docs/always-ask-on-unresolved.md`.

Global baseline: `ask-before-deciding.md`. Global source: `~/.claude/CLAUDE.md` priority #2.
