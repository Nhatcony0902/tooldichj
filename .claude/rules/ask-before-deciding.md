---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Ask Before Deciding — Mandatory AskUserQuestion Usage

## Rule

**BEFORE presenting the user with any multi-option decision, you MUST invoke `AskUserQuestion`.** Prose "A or B?", bulleted choice lists, and prose checkbox alternatives all violate this rule — STOP and call `AskUserQuestion` instead. For the strict superset (yes/no, unresolved plan/report items, default values, destructive actions, skill-body decisions), see [`always-ask-on-unresolved.md`](always-ask-on-unresolved.md); when in conflict, that rule wins.

## If AskUserQuestion is deferred

`AskUserQuestion` is auto-deferred in long-context sessions (its NAME appears in the deferred-tools reminder; schema is NOT loaded). Direct call fails with `InputValidationError`. **Required first action:**

```
ToolSearch(query="select:AskUserQuestion", max_results=1)
```

`decision-tools-preload.cjs` emits a `[t1k:decision-tools]` reminder each session. Never use "tool is deferred" to justify prose questions in a skill body — load the schema first. No `settings.json` knob pins specific tools as eager (verified 2026-04-29).

### ⛔ Forbidden phrasings — these are rule violations

If you find yourself drafting any of the following, **STOP** and run `ToolSearch(query="select:AskUserQuestion", max_results=1)` instead:

- "AskUserQuestion isn't available as a deferred tool here. I'll ask in prose."
- "AskUserQuestion is unavailable, falling back to prose questions."
- "Since AskUserQuestion isn't loaded, here are the options: Q1… Q2… Q3…"
- Any prose Q1/Q2/Q3 list, bulleted "Pick one of:" block, or numbered checkbox-alternatives that would otherwise be a structured `AskUserQuestion` call.

Deferral is never a justification for a prose fallback — the schema is one `ToolSearch` call away. After the schema loads, invoke `AskUserQuestion` with batched options as originally intended. This applies to every skill body and every agent; do NOT duplicate this list into individual skill SKILL.md files (the rule is auto-loaded into every session).

## When NOT to use

Plan-approval flows use `ExitPlanMode`, not this tool. Factual yes/no questions and pure-acknowledgment replies stay as prose.

## Related

[`always-ask-on-unresolved.md`](always-ask-on-unresolved.md) (strict extension, canonical for the broad case) · `$HOME/.claude/CLAUDE.md` priority #2 (global source).
