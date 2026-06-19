---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Replicate & Automate — Never Solve Once

Universal authoring principle for every TheOneKit kit, module, skill, agent, hook, and rule. Auto-loaded into every session. The operational arm of `development-principles.md` § "Automate Over Manual — Git Is Truth".

## Rule

When you perform a task that will recur — a registration step, a frontmatter stamp, a file relocation, a fix applied across N files, a manual edit you know you'll make again — **STOP and build the tool, template, or gate that automates the NEXT occurrence**, then use it for THIS one. Solving it once by hand is a regression in disguise: the next person (or the next you) repeats the manual work and re-introduces the drift.

The test: *"Will this exact shape of work happen again?"* If yes, the deliverable is the automation, not the one-off result.

| Recurring work | Build this, not a one-off |
|---|---|
| Hand-stamping frontmatter / registering a skill-agent-rule in `module.json` + activation | A scaffolder that stamps + auto-registers (`t1k {rule,skill,agent,module} new`) |
| Fixing the same lint/naming/tier violation by hand across files | A `--fix` mode on the validator that emits + applies the repair |
| Pasting the same `code-conventions` / routing block into each kit | A parameterized template + renderer; kit copies are generated, diffed, never edited |
| A manual pre-release checklist run from memory | A CI gate that enforces the checklist and fails the PR |
| The same `module.json` → rollup regen done by hand | The SSOT regen script wired into the scaffolder + a drift gate |

## How to apply

1. Notice the second occurrence (rule-of-three is too late for authoring drift — act on the second).
2. Identify the deterministic core (mechanical → CLI/gate/template per `ai-driven-design.md`) vs. the judgment core (semantic → skill/agent).
3. Build the automation for the deterministic part; have the skill drive it for the judgment part.
4. Use the new tool to do the current task — proves it works end-to-end.
5. Wire a gate so the manual path can't silently come back.

## Anti-patterns

"I'll just do it by hand this once" (the second time you've said that about this shape) · shipping a manual fix without the gate that prevents its recurrence · a scaffolder that creates the file but leaves registration manual · a template pasted per-kit instead of rendered.

## Related

- `development-principles.md` — § "Automate Over Manual — Git Is Truth" (parent principle), § "SSOT — No Duplicates"
- `ai-driven-design.md` — deterministic → tool, judgment → AI (which half to automate)
- `code-conventions.md` — § "Data-Driven Over Hardcoded" (registry-driven discovery, no static maps)
