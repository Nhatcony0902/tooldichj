---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# AI-Driven Design — Tools as Foundation

Universal architectural principle for every TheOneKit skill, agent, and hook script. Auto-loaded into every session.

## Rule

Default to AI-driven solutions. CLI/hooks/scripts emit **facts** (machine-parseable JSON + file excerpts); Claude (skills + agents) **reasons** over those facts, decides policy, and explains rationale.

Never put decision logic in pure-CLI code when AI can add semantic context.

## Exceptions

Pure-CLI logic IS correct for:

- **Deterministic invariants** — CI gates, doctor checks, schema validators that have no judgment component (e.g., "is this JSON valid?" is CLI; "is this skill description well-targeted?" is AI).
- **Performance-critical paths** — file watchers, bulk transforms, releases — where the answer is mechanical and millions of decisions can't tolerate per-call AI.
- **Side-effects with safety constraints** — destructive ops, secret handling — where AI advice must be gated behind explicit user approval before any CLI execution.

## How to apply

When designing a new skill, agent, or hook:

1. Identify the decision points. For each, ask: "Does this need judgment, or is it deterministic?"
2. Judgment → put it in skill body (Claude reasons over facts).
3. Deterministic → put it in a `.cjs` script under `.claude/scripts/` or hook.
4. Hybrid → script emits structured facts; skill body reads + reasons + acts.

## Why

CLAUDE.md priority #8. Putting policy logic in pure-CLI code makes it brittle (hard-to-update, no semantic context, no explanation to user). Letting AI reason over CLI-emitted facts gives flexibility + auditability + cheaper iteration.

## Related

- `CLAUDE.md` priority #8 — origin of this principle
- `rules/development-principles.md` — broader principles (SSOT, errors-over-fallbacks, automate-over-manual)
