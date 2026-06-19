---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Contract-First Integration — Define the Shared Shape Before Parallel Fan-Out

Universal rule for every kit/engine. Auto-loaded. Full reference (boundary list, 5-item spec, motivating incident, anti-patterns, how-to): `docs/contract-first-integration.md`.

## Rule

Before spawning parallel/multi-agent implementation across a **shared boundary** (API ↔ client, producer ↔ consumer, two modules, any `Agent`/teammate/`Workflow` tasks whose outputs interlock), DEFINE the integration contract FIRST and embed it **verbatim** in every agent's brief — no agent codes its side until the contract is fixed.

The contract pins: **transport** (path+method / event / signature), **payload** (every field name, type, and **casing** — camel vs snake — plus nesting), **enums** (exact values), **envelope** (success AND error shape, and which status carries which), **null/optional** semantics. If the shape already lives in a shared `types.ts`/schema/proto, point every agent at that file (SSOT) instead of restating.

## Why

Parallel agents run in isolated contexts and cannot see each other's code. Without a pre-agreed contract each invents a plausible shape; the shapes disagree; both pass their own typecheck (each internally consistent); the mismatch surfaces only at runtime. Per-side typecheck cannot catch it — a post-fan-out integration check / adversarial review must. (Motivating incident: store-review 2026-06-11 — see docs.)

## Related

`parallelize-batch-work.md` · `ai-velocity-batch-compile.md` · `fork-context-brief.md` · `orchestration-rules.md` · `agent-name-is-identity.md`
