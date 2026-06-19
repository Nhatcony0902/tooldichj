---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Subagent Type Routing — Pick the Right Agent, Not `general-purpose`

When `TeamCreate` + `Agent({team_name})` spawns a teammate, the `subagent_type` field determines which system prompt + tool palette the teammate gets. **Defaulting to `general-purpose` is almost always wrong** for kit-specific work — it forfeits domain-specialist context (Unity DOTS patterns, agent-completion discipline, kit-specific MCP tools, etc.) and forces the teammate to bootstrap that context from scratch.

## Rule

Before every `Agent` call, **consult the project's CLAUDE.md "Agents" / "Mandatory Routing" table** (or the equivalent kit-specific routing file). Pick the `subagent_type` matching the work's domain. `general-purpose` is the LAST RESORT — only when no specialized agent fits.

## How to find the right type

Every kit-installed project has a routing table somewhere in its top-level `CLAUDE.md`:

| Kit | Routing source | Common types |
|---|---|---|
| Unity / DOTS | `CLAUDE.md` § "DOTS Agents (Mandatory Routing)" | `dots-implementer`, `dots-environment`, `dots-reviewer`, `dots-tester`, `dots-debugger`, `dots-optimizer`, `dots-shader`, `dots-validator`, `unity-ui-developer`, `unity-developer`, `skills-manager`, `game-designer`, `game-producer` |
| Designer / GDD | `CLAUDE.md` (designer kit) § "Agents" | `game-designer`, `game-producer`, `designer-brainstormer`, `planner` |
| Cocos | Cocos kit routing | (kit-specific) |
| Backend / Nakama | Nakama kit routing | (kit-specific) |
| Cross-kit / meta | Always available | `planner`, `code-reviewer`, `tester`, `debugger`, `researcher`, `git-manager`, `general-purpose` |

If the project's CLAUDE.md doesn't have an explicit routing table, fall back to: (a) check `.claude/agents/` directory listing for available types, (b) ask the user which specialist fits.

## Decision shortcut (Unity / DOTS — most common)

| Task type | subagent_type | Why |
|---|---|---|
| Write `IComponentData`, `ISystem`, `IJobEntity`, baker, authoring | `dots-implementer` | DOTS runtime code specialist with Burst/Jobs/Mathematics context |
| Fix DOTS compile errors, namespace gaps, asmdef references | `dots-implementer` | Same context as the original write |
| Create scene, prefab, terrain, NavMesh, lighting, battlefield editor | `dots-environment` | Unity Editor scene/asset specialist + MCP tools |
| Generate placeholder sprites, textures, asset variants | `dots-environment` | Asset generation includes Unity MCP `manage_texture`/`manage_asset` |
| Build Canvas UI, HUD panel, drag-and-drop, modal | `unity-ui-developer` | uGUI + Canvas + IObjectPoolManager patterns |
| Write HLSL, Shader Graph, GPU instancing, billboards | `dots-shader` | URP/Shader Graph specialist |
| Profile DOTS bottlenecks, chunk utilization, draw calls | `dots-optimizer` | Profile-driven optimization |
| Runtime ECS debugging (missing entities, system not running) | `dots-debugger` | Entity inspection via Unity MCP |
| Validate Play-mode (spawn/move/fight/die/render gates) | `dots-validator` | 8-check protocol specialist |
| Review DOTS PR (Burst compat, parallel safety, archetype layout) | `dots-reviewer` | Adversarial DOTS reviewer |
| Run / add DOTS tests (DOTSTestBase fixture, SubScene baking) | `dots-tester` | Unity Test Runner + ECS test patterns |
| MonoBehaviour gameplay code (non-DOTS) | `unity-developer` | VContainer/SignalBus/UniTask patterns |
| Wiki page, design doc, game state doc | `game-designer` | Markdown + design pillars + CSV refs |
| Milestone gate, playtest coordination, balance review | `game-producer` | Production oversight |
| Create / update Claude Code skill | `skills-manager` | Skillmark conventions + registry |

## Anti-patterns

| Wrong | Right | Why |
|---|---|---|
| `general-purpose` for "I'll write some C# Unity code" | Pick from the table above | general-purpose has no Unity context loaded |
| `general-purpose` for "scene setup + prefab work" | `dots-environment` | dots-environment has Unity MCP scene/prefab tools and conventions |
| `general-purpose` for "fix this compile error" | Match the code's domain (dots-implementer for DOTS, unity-ui-developer for UI, etc.) | Specialist knows the conventions; general-purpose re-discovers them |
| `general-purpose` for "build a UI panel" | `unity-ui-developer` | unity-ui-developer knows Canvas/uGUI patterns |
| `unity-developer` for ISystem / IComponentData | `dots-implementer` | unity-developer is for MonoBehaviour gameplay; DOTS has its own discipline |
| `dots-implementer` for Canvas UI | `unity-ui-developer` | dots-implementer doesn't carry UI patterns |

## What to do when you slip up

If you spawned a teammate with the wrong `subagent_type` and it's already in flight:

1. **Don't kill + re-spawn** — losing the teammate's in-flight context costs more than the wrong-type tax.
2. **SendMessage them** with the kit-specific patterns they're missing (e.g., "you should know about Burst discipline, RequireMatchingQueriesForUpdate, etc."). They can absorb the context in-line.
3. **Note the slip in your checkpoint memory** so future spawns in the same session use the right type.
4. **Apply the [[manual-correction-implies-skill-gap]] meta-rule** — patch the skill/checkpoint so the recurrence doesn't happen.

## Worked example (real session, 2026-05-23)

ChaosForge cook spawned 6 teammates this wave:
- ❌ phase5a-substats-core: `general-purpose` (should have been `dots-implementer` — DOTS package code)
- ❌ phase5b-substats-ui: `general-purpose` (should have been `unity-ui-developer` — Canvas UI panel)
- ❌ phase4p5-loot-tables-scene: `general-purpose` (should have been `dots-environment` — prefab + scene-setup tool)
- ❌ phase4-fix: `general-purpose` (should have been `dots-implementer` — DOTS runtime compile fixes)
- ✅ phase8c-forge-items-viz: `dots-environment` (item sprite generation)
- ✅ phase8d-character-sprites-viz: `dots-environment` (character sprite generation)

The first 4 worked functionally but each spent extra tokens re-discovering Unity DOTS conventions (Burst attributes, asmdef references, scene-setup idempotency, MCP gotchas) that the specialist agents have baked in. The remaining 2 (with correct routing) showed measurably tighter pre-flight + scope discipline. User caught the gap and asked for systemic fix.

## Related

- Project `CLAUDE.md` — the canonical agent list for any specific kit
- `rules/manual-correction-implies-skill-gap.md` — meta-rule: when you patch a brief because the skill missed something, fix the skill
- `rules/orchestration-rules.md` — `/t1k:cook` routing covers the WORKFLOW dispatch; this file covers the SUBAGENT TYPE dispatch
- `skills/t1k-team/SKILL.md` — spawn-brief template should reference this file
