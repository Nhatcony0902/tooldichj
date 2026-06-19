---
name: t1k:library-decoupling
description: Keep a library core free of third-party (paid/asset/SDK/npm) dependencies via interface + provider seams in opt-in bridge packages. Engine-agnostic (Unity, Cocos, React Native, web, any kit). Use when adding/using any third-party API in library code, decoupling an existing hard dependency, or scaffolding an opt-in vendor package. Engine mechanics in references/.
keywords: [library decoupling, third-party, vendor seam, interface provider, opt-in package, NoOp bridge, graceful degrade, decouple dependency, asset-store decouple, npm decouple]
effort: medium
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Library Decoupling — Interface + Provider Seams (engine-agnostic)

Enforces `.claude/rules/library-third-party-decoupling.md`: a library **core never references a third-party dependency**; vendor integrations live behind a library-owned interface in an **opt-in bridge package**, discovered at runtime/build-time, degrading gracefully (warn+skip or NoOp) when absent. **Design the seam from the first line — never couple directly "for now."** This is the standard for ALL engines; per-stack mechanics live in `references/`.

## When this fires

- About to write a third-party import/reference anywhere inside a shipped library package.
- A core package/target would need a hard reference to a vendor library.
- Decoupling an existing hard dependency.
- Managed-only effects (juice, tween, haptics, analytics, audio middleware) need to flow from core logic.

## Decision tree

```
Need a third-party API in the library?
├─ Platform stdlib / engine-shipped / first-party? ──────── YES → hard ref is fine, done.
├─ Caller is a test (test-only target)? ─────────────────── YES → vendor ref in test-only target OK; keep core clean.
├─ Managed-only effect driven by core events/state? ─────── YES → library owns the event boundary + I*Bridge seam; vendor impl is consumer-side (Recipe B).
└─ Otherwise (tooling or runtime vendor feature) ─────────→ Recipe A: interface + opt-in vendor package.
```

## Recipe A — interface + opt-in vendor package

1. **Define the interface in core**, generic types only — NO vendor types in any signature. Enumerate the FULL call surface first (incl. pre/post lifecycle hooks), not just the happy path — a bare `DoThing()` that omits lifecycle calls won't build once the vendor code moves out.
2. **Orchestrator in core resolves the provider** via the engine-idiomatic discovery mechanism (type/service registry, DI container, dynamic import, static self-registration) over the library's OWN interface — never the vendor type. Make the resolver accept an **injectable override** for testability (default = the real discovery), so the "no provider" path is testable even when the host app ships a provider.
3. **Create the opt-in vendor package/module** — the ONLY place the vendor import appears. It depends on core; core never depends on it.
4. **Consumer wiring:** consumers who own the dependency add the opt-in package; others omit it → core builds clean, feature warns+skips / NoOps.

## Recipe B — managed-effect seam (core events → vendor effect)

1. Library owns the **event boundary + interface** (e.g. `IScreenShakeBridge { Shake(pos, intensity); }`) and the drain that converts core state/events into discrete effect calls. Put policy (thresholds, edge-detection, accessibility scaling) in the **library drain** so every consumer inherits it and impls stay dumb ("just play it").
2. Vendor impl is **consumer-side** (not in the library). A single registered impl is the natural double-consumer guard.

## Verification (run before claiming done)

```
# core must be vendor-free
grep -rn "<VendorImport>" <core-package-path>/    # expect 0
# vendor used in exactly one opt-in package
grep -rln "<VendorImport>" <library-root>/         # expect only the opt-in vendor pkg
```
Then: remove the vendor dependency + its opt-in package → project builds **zero errors**; trigger the feature → warn+skip / NoOp, surrounding tooling still works.

## Gotchas (engine-agnostic)

- **Graceful degrade ≠ silent fallback.** Warn-and-skip MUST log a clear, surfaced message; for hot paths prefer a NoOp null-object default over per-call warnings. Throw only when the user marks the feature mandatory.
- **Discovery is project-wide, not reference-scoped** on most engines — omitting the vendor package from a test target does NOT hide its provider from a global type/service registry. Use the **injectable-override resolver** to test the no-provider path; don't rely on target isolation.
- **Don't over-build the seam.** A priority/ordering field with one provider is YAGNI — add it only when ≥2 providers are real, or mark it reserved. Don't ship a speculative second impl "just in case."
- **Hunt ALL external callers of moved public types before moving them** (grep the whole repo, not just the owning package) — a sibling/consumer referencing the moved type is a silent build break, and a consumer that hard-refs the vendor is a decoupling hole your library-scoped grep won't catch.
- **A vendor move is a breaking change with NO compatibility alias** — an alias forwarding from core to the vendor package re-introduces the coupling you're removing. Hard-break + migration note + same-commit consumer fix instead.
- **Interface must carry the FULL call surface** — including lifecycle hooks — or the orchestrator won't build once the vendor code leaves core.

## Engine mechanics

- **Unity (DOTS/C#):** asmdef refs, `TypeCache` provider discovery, Burst/lockfile gotchas, MonoBehaviour bridges → the Unity kit's `t1k-library-decoupling` reference (`references/unity-dots.md`).
- Other engines: add `references/<engine>.md` (Cocos/TS DI + dynamic import; RN native-module optional deps; web bundler resolution) as they adopt the pattern.

## Related rules

`library-third-party-decoupling.md` (the mandate this skill executes) · library-quality mandate · `library-feature-discovery-protocol.md` · `development-principles.md`.
