---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Development Principles

Universal principles for all TheOneKit projects.

## SSOT — No Duplicates

NEVER create duplicate methods, functions, classes, packages, modules, or files that serve the same purpose. Search before creating; reuse and extend; one responsibility = one location; consolidate duplicates immediately. **No derived fields** — see `rules/code-conventions.md` → "No Derived Fields".

## Errors Over Silent Fallbacks

NEVER use silent fallbacks that hide errors. ALWAYS throw exceptions with clear error messages. The only acceptable fallback is explicitly documented, logged, and surfaced to the user.

## Automate Over Manual — Git Is Truth

For any repetitive or pattern-based task, implement in CI/CD scripts that commit results back to git. No hidden state — everything visible in the repo. If the same manual change is needed in multiple places → automate it.

## No-Override Rule

Files under `$HOME/.claude/` MUST have globally unique names across all kits and modules.

- No file from any kit/module may overwrite a file from another
- CI/CD auto-prefixes agent filenames: core=no prefix, kit-wide=`{kit-short}-`, module=`{kit-short}-{module}-`
- CI validates no collisions before release

## Test Pass Gate — Zero Failures Before Done

ALL unit tests MUST pass before reporting any task as "done".

- After ANY implementation: run the full test suite, not just compilation.
- Zero test failures required — skipped/ignored tests acceptable ONLY with documented justification.
- If tests fail: fix them as part of the current task. NEVER report "done" with failures pending.

## Pre-Delete Reference Check

Before deleting or renaming ANY file, function, class, or type:

1. `grep -r "TypeName"` across ALL source files (runtime + tests + editor)
2. Update every reference BEFORE or alongside the deletion
3. Run tests after deletion to confirm zero breakage

## Update Skills After Every Error

After encountering ANY error (compile, runtime, gotcha), ALWAYS update the relevant skill with a gotcha/warning entry BEFORE continuing — then invoke `/t1k:sync-back`. **This includes manual corrections you inject into a teammate brief or spawn prompt** — if you catch yourself re-explaining the same constraint, fix the canonical skill/agent/rule, not just the brief; patching the brief alone re-pays the correction tax every session. See `docs/manual-correction-implies-skill-gap.md`.
