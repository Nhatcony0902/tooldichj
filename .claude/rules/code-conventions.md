---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Code Conventions (Universal)

Applies to ALL languages and frameworks. Kit-specific rules extend this in `code-conventions-{kit}.md`.

## Generic conventions (summary)

SOLID; self-documenting names (`is/has/can/should` booleans, verb functions); one responsibility per file, ≤200 lines, guard clauses over nesting, composition over inheritance, immutability by default; no magic numbers / empty catch / merged-`TODO`; stdlib→external→internal import order; test public behavior with independent, descriptively-named tests. **Full enumerated lists: `docs/code-conventions.md`.**

## Data-Driven Over Hardcoded

- **NEVER hardcode mappings** (command→skill / role / agent, keyword→module) in hooks or scripts. Always read from registry files at runtime so new skills/agents/modules auto-discover with no code change.
- **Test:** deleting a static map should break nothing because the data comes from files. If it breaks → you're hardcoding.

## No Duplicated Logic

- Before writing a utility, search shared modules (`telemetry-utils.cjs`, `lib/`); if a pattern appears in 2+ files, extract immediately — not "later".
- Each `.claude/` path resolution must use `resolveClaudeDir()` — no inline `path.join(cwd, '.claude')`.
- `null` / `undefined` guards where data flows between systems.

## No Derived Fields — SSOT for Data

- **NEVER store a value computable from other columns.** If `C = f(A, B)` and `A`/`B` are stored, compute `C` at the query/use site.
- **Exception — materialized for performance only:** IF profiling proves a real bottleneck AND source columns rarely change AND it's kept in sync via trigger/constraint/CI AND the formula is documented inline.

## Living Document

If unsure about a convention not covered here, ask the user and update this file.
