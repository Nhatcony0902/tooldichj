---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Library Third-Party Decoupling — Interface + Provider From Day One

**Status:** kit-wide, engine-agnostic, always-loaded, decision-authority rule. Applies to EVERY TheOneKit engine (Unity/DOTS, Cocos, React Native, web, Nakama, any future kit). The operational arm of the library-quality mandate for third-party (non-first-party, non-platform-stdlib) dependencies. Future sessions act on this WITHOUT re-asking the user.

> **Homing:** the principle below is **core** (theonekit-core). Engine-specific *mechanics* (how a "package", "reference", "provider discovery" map to each stack) live in the per-engine table + each engine kit's reference doc. Do not fork the principle per kit — extend the table.

## Rule

No **core library package** may hard-reference a third-party asset/library (anything not shipped by the platform stdlib or first-party/The1Studio). A consumer MUST be able to remove the third-party dependency and still **build and run** the library.

Two non-negotiables, on every engine:

1. **Design the seam FIRST, never couple directly.** The moment you reach for a third-party API (a paid Unity asset, an npm package, a native module, a SaaS SDK), STOP and define a **library-owned interface** the core depends on. The third-party call lives behind a **provider** implementing that interface. This applies from the first line — do NOT write the direct call "for now" intending to extract later. Extract-later is tech debt in disguise.

2. **Third-party providers live in opt-in bridge packages.** Core defines `ISomethingProvider` (dependency-free, generic types only). The concrete `VendorProvider : ISomethingProvider` lives in a separate opt-in package/module that references the third-party dependency. Consumers add it ONLY if they own/want the dependency. Installing the bridge package IS the statement "I have this dependency."

## The canonical pattern (engine-neutral)

```
core-library-package            (third-party-FREE)
  ISomethingProvider            ← library-owned interface, generic types only
  SomethingOrchestrator         ← resolves a provider; graceful-degrades if none

opt-in-vendor-package           (references the third-party dependency)
  VendorProvider : ISomethingProvider   ← the ONLY place the vendor import/reference appears

// Consumer without the dependency → don't install the vendor package → core builds clean.
```

**Provider discovery without a core→vendor reference** (pick the engine-idiomatic mechanism): a type/service registry, a DI container, dynamic import/reflection over the library's OWN interface, or static self-registration by the vendor package on load. The core never names the vendor type.

**Graceful degradation (two sanctioned contracts):**
- **Warn + skip** (tooling / one-shot ops): no provider → log a clear warning, skip the op, keep the surrounding feature working. Hard-error only when the user explicitly marks a feature "mandatory."
- **NoOp null-object** (per-frame / hot-path runtime seams): register a do-nothing default impl so callers never null-check.

Either way: never throw by default, never hard-block, never silently swallow without a logged/surfaced signal at registration time.

## Per-engine mechanics map (extend, don't fork)

| Concern | Unity (DOTS/C#) | Cocos / TS | React Native / TS | Web / TS | Generic |
|---|---|---|---|---|---|
| "Core package" | asmdef / UPM package | npm package / module | npm package | npm package / module | module |
| Vendor reference | asmdef `references` + `using` | `import` + package.json dep | `import` + dep | `import` + dep | import / link |
| Opt-in vendor pkg | separate UPM pkg added to `manifest.json` | optional npm dep / separate pkg | optional/peer dep | optional/peer dep | separate module |
| Provider discovery | `TypeCache` (Editor) / static reg / DI | DI container / registry / dynamic `import()` | DI / registry | DI / dynamic `import()` | service locator / registry |
| Degrade default | warn+skip or NoOp impl | NoOp impl / warn | NoOp / warn | NoOp / warn | null-object / warn |
| Build gotcha | regen lockfile + clear Burst/asmdef cache | lockfile + `tsconfig` paths | metro resolver | bundler resolve config | lockfile |

Engine kits add a reference doc for the details (Unity: `references/unity-dots.md` in the `t1k-library-decoupling` skill).

## Decision authority

| Decision | Default action under this rule |
|---|---|
| About to call a third-party API in core | Block. Define the interface + provider seam first. |
| Third-party import/reference appears in a core package | Block. Move it to an opt-in vendor package. |
| Provider absent at run/build time | Warn + skip (or NoOp); keep the feature degraded-but-alive. Never throw by default. |
| Conditional-compile defines for an asset with no package identity | Reject — prefer the package-split seam over `#if VENDOR`/define soup. |
| Interface signature leaks a vendor type | Block. Interface uses only platform/first-party types; provider casts internally. |
| Managed-only effect (juice, tween, haptics, analytics) from core logic | Library owns the event boundary + `I*Bridge` seam; the vendor impl is consumer-side. |

## Objective tests (a core package passes iff ALL hold)

1. Grep core for the vendor import/namespace → **0 hits**.
2. Removing the vendor dependency + its opt-in package → the project builds with **zero errors**.
3. The feature degrades gracefully (warn+skip or NoOp), not crash, when the provider is absent.
4. The interface's public signatures contain **no vendor types**.
5. The vendor import appears in **exactly one** place: the opt-in vendor package (or consumer-side bridge).

## Honesty clause — track exceptions, don't pretend

This rule is the **target state**. A codebase will usually have pre-existing core hard-deps that violate it. Declare them in a **Known Non-Conformant backlog** (per project) rather than letting the rule read as fiction. A new coupling is a **violation** (block it). A tracked exception is **debt being paid down** — do not cite it as precedent, do not add more. Removing a backlog row requires the seam to actually ship.

## Anti-patterns

- "Call the vendor API directly for now, extract later." — later never comes.
- Hard reference to a vendor inside a core package.
- A core conditional-compile guard standing in for a proper package split.
- An interface method that takes/returns a vendor type.
- Throwing / hard-blocking when the provider is absent.
- Putting the vendor provider in the core package "to keep it together."

## Narrow exceptions

- **Platform stdlib / engine-shipped** deps (Unity `com.unity.*`, Node stdlib, RN core) and **first-party/The1Studio** packages are not "third-party" — hard references are fine.
- **Tooling/build-only one-offs genuinely never shipped to consumers** may call a vendor directly — but anything inside a shipped library package is bound.
- **Tests** may reference a vendor via a test-only target gated from the runtime/core build.

## Related

- library-quality mandate — Great Lib, Zero Tech Debt; this rule is its third-party arm.
- `development-principles.md` § "Errors Over Silent Fallbacks" — warn+skip / NoOp are the *documented, logged, surfaced* fallbacks this allows; not silent swallows.
- Skill: `t1k-library-decoupling` — the engine-agnostic how-to (interface, opt-in package scaffold, provider discovery, degrade); `references/unity-dots.md` for Unity mechanics.

## History

Established 2026-06-04 (Amplify Impostors + Feel decoupling). User directives: *"make our lib totally free of those 3rd-party deps"*, *"work with interface and provider from the start"*, and *"this should be the general, standard rule/skill for all engines."* Generalized from Unity-specific to engine-agnostic on the third directive.
