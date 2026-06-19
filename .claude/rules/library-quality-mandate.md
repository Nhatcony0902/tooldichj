---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Library Quality Mandate — Great Lib, Zero Tech Debt

## Rule

When a project's primary deliverable is a **reusable library / shared package / submodule** (consumed by other projects, not a single shipping app), it is on a **zero-tech-debt budget**. Every extraction, refactor, naming, and packaging decision MUST optimize for **maximum reuse** across current and future consumers AND **new-consumer velocity** at once. When these conflict with "ship faster by deferring cleanup," the mandate wins — ship the right answer or don't ship.

A change passes the mandate iff it is **domain-neutral** (no consumer-specific token in shared code), **data-driven** (every tunable is config or a named constant, never an inline magic literal), **tested** (new surface ships with coverage), **charter-conformant** (names describe the generic role, never one concrete instance), and **documented** in the same commit.

## Why

The library is the deliverable. Every consumer, extraction, and refactor serves "is this good enough that other projects ship products on it?" If quality drifts toward "good enough for our current consumers only," the project has failed its mission. Deferred debt compounds across every downstream consumer.

## How to apply

1. **Decision authority** — in a library-first project, agents make debt-removal calls (extract-now vs defer, rename-before-merge, relocate-leaked-token) autonomously without re-prompting; fall back to `always-ask-on-unresolved.md` only for calls outside these patterns.
2. **Every commit touching shared code** — run the pass-test above; fail → fix before merge. Extraction tracks default to "ship now"; defer only if a downstream dependency is genuinely unbuilt.
3. **Engine-specific charter** (package layout, namespace roots, asset key conventions) lives in the owning kit's rule + the project's `CLAUDE.md` — core supplies the principle; kits + projects supply concrete tokens. Full decision table + naming charter: `docs/library-quality-mandate.md`.

## Related

- `rules/development-principles.md` — SSOT, no silent fallbacks, no derived fields; the mandate strengthens these.
- `rules/code-conventions.md` — generic naming, no magic numbers; the mandate is the library-specific elaboration.
- `rules/coding-guidelines.md` — surgical changes, simplicity-first; the mandate authorizes large *correct* refactors (not change-aversion).
- `docs/library-quality-mandate.md` — objective tests, naming-charter patterns, adoption note, history.
