---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---

# In-Session Skill-Validity Self-Check

Universal rule for every TheOneKit session. Auto-loaded. Closes the discipline leak in the skill-bug pipeline: staleness found *while using* a skill was routinely missed because emitting a marker depended on the assistant remembering to.

## Rule

When you activate a kit-owned skill (`t1k-…` / `t1k:…`) during a session, the `skill-validity-reminder.cjs` PostToolUse hook injects a one-time-per-session self-check. On seeing it, **assess the skill's guidance against what you actually observe while applying it** and, if it is stale/wrong/unhelpful, emit a `[t1k:skill-bug …]` marker BEFORE moving on:

```
[t1k:skill-bug kit="<owning-kit>" skill="<skill>" bug="<one-line>" evidence="<path-or-repro>"]
```

That marker feeds the existing pipeline (`lesson-collector.cjs` Stop hook → `lesson-queue-processor.cjs` → background `/t1k:sync-back` or `/t1k:issue`) — see [`telemetry.md`](telemetry.md). Per the dual-action rule, also spawn the fix in the same turn when the staleness blocks current work.

### What counts as a validity failure (emit a marker)

- Deprecated or renamed API / option / flag (code following the skill would error)
- Outdated version pin or "latest"/"new" claim that no longer holds
- Removed command or changed CLI syntax
- Dead link, or a factual number that contradicts current docs
- Advice that contradicts what you directly observe in the codebase/task

### What does NOT warrant a marker

- The skill is correct and helpful — do nothing (the check is silent by default).
- Evergreen guidance (design principles, copywriting frameworks) with no version surface.
- A one-off preference difference that is not actually wrong.

## Scope & cost

- **Passive** by design: zero extra API calls. The hook only fires on the `Skill` tool, only for `t1k`-prefixed skills, and only **once per skill per session** (deduped via `.claude/telemetry/skill-validity-seen-<sessionKey>.json`). Repeated use of the same skill is not re-nagged.
- Non-kit / built-in skills are skipped.
- The hook is non-blocking and fail-open — a hook exception never disrupts skill usage.

## Kill switch

Remove the `Skill`-matcher PostToolUse entry (`hook-runner.cjs skill-validity-reminder`) from `.claude/settings.json` to disable the reminder. The downstream marker pipeline is governed separately by `features.autoLessonSync`.

## Related

- [`telemetry.md`](telemetry.md) — the marker → sync-back/issue pipeline this rule feeds.
- [`workflow-failure-auto-issue.md`](workflow-failure-auto-issue.md) — marker formats + dual-action.
- [`development-principles.md`](development-principles.md) § "Update Skills After Every Error" — the broader discipline this automates.
- `hooks/skill-validity-reminder.cjs` — the hook implementing this rule.
- `hooks/kit-owned-file-modified.cjs` — sibling hook (nudges sync-back on *edits*; this one nudges validity-check on *use*).
