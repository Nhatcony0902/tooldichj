---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Intra-Phase Sub-Agent Fan-Out (Depth-2)

When a teammate on a `TeamCreate`'d team owns a single phase, the teammate (running Opus 4.7 with a 1M-context window) often sits mostly idle waiting on its own sequential work. **Depth-2 fan-out is allowed by existing fork-depth rules and is underused.** This document describes the workflow.

## Depth ladder (hard limit — `rules/agent-security-boilerplate.md`)

| Depth | Who | What it may spawn |
|---|---|---|
| 0 | Parent / lead session | `TeamCreate` (teammates), `Agent` (plain sub-agents) |
| 1 | Teammate (spawned by parent) | `Agent` (plain sub-agents only — NOT `TeamCreate`) |
| 2 | Sub-agent (spawned by teammate) | NOTHING — MUST NOT call `Agent` or `TeamCreate` |
| 3 | (forbidden — fork bomb) | — |

`T1K_FORK_DEPTH >= 2` → skip Domain Agent Orchestration; report `domain-agents-skipped: depth-limit-reached`. Each sub-agent brief MUST explicitly forbid further spawning (see template below).

## When to use (opt-in)

Use intra-phase fan-out when **all** of the following hold:

- The phase has 2-3 logically disjoint sub-areas (impl A, impl B, tests).
- File-ownership can be carved into non-overlapping sets BEFORE fan-out.
- Interfaces between sub-areas are stable enough to be frozen in stub files first.
- The phase wall-clock is the bottleneck (not token budget) — fan-out costs 2-3x tokens.

## When NOT to use (opt-out)

Skip fan-out and keep a single teammate when:

- Phase is naturally sequential (e.g., realm progression with cascading gates).
- Phase is already team-split at the lead level (no value in fan-out below that).
- Token spend matters more than wall-clock (small features, cheap rerun on miss).
- Sub-areas cannot be carved cleanly — interface drift risk too high.

## 5-step teammate workflow

### Step 1 — Interface-freeze pass (~20–30K tokens)

The teammate (single-agent, no fan-out yet):

1. Reads the phase plan end-to-end.
2. Defines component/system interfaces — just type signatures, empty bodies.
3. Creates stub files with `// TODO(SA-A): ...` markers per logical sub-area.
4. Commits stubs to the worktree main. This unblocks parallel impl.

The interface freeze is the load-bearing step — without it, sub-agent B will mutate an interface sub-agent A depends on, and last-write-wins corruption will silently break the integration pass.

### Step 2 — Fan-out (single message, parallel `Agent` calls)

In ONE message, the teammate emits 2-3 `Agent` invocations with `run_in_background: true`. Each sub-agent receives:

- The file-ownership matrix (which sub-agent owns which files).
- The guardrail block (verbatim — see template below).
- The interface-freeze commit SHA (so sub-agents start from a consistent base).
- The phase plan excerpt for their sub-area.

Concurrency: 2 minimum (or fan-out is pointless), 3 maximum (4+ runs into context pressure on the integration pass).

### Step 3 — Integration pass

As sub-agents complete (notification-driven, do NOT poll), the teammate:

1. Pulls each sub-agent's commits in turn.
2. Runs the project's test suite after each integration.
3. Resolves any cross-boundary fixups locally (do NOT respawn the sub-agent for trivial fixes).
4. Commits the integration delta with a clear message: `integrate SA-A: <summary>`.

Commit aggressively — every logical chunk. The integration teammate's context can balloon; per `rules/agent-completion-discipline.md`, hit the 150K-token checkpoint and commit + push before continuing.

### Step 4 — Validation

Run the final gates per project rules:

- Console clean (no warnings in Unity / no errors in test output).
- All tests pass (zero failures — per `rules/development-principles.md` Test Pass Gate).
- Smoke per project-specific protocol (e.g., play-mode test, build sanity).

If validation fails AND the failure traces to one sub-agent's domain, the teammate can re-spawn just that sub-agent with a corrective brief. Do NOT re-spawn the whole fan-out for a single-domain failure.

### Step 5 — Report to team-lead

Single `SendMessage` to lead with:

- SHA list per sub-agent (impl commits).
- Integration commit SHA.
- Validation summary (tests passed / wall-clock / token spend if tracked).
- Any open issues for follow-up (do NOT silently leave deferred work).

## Sub-agent guardrail template (verbatim — copy into each sub-agent brief)

```
You are a sub-agent of teammate `{teammate-name}`, fork depth 2.

Hard constraints:
- DO NOT spawn further sub-agents. Depth-3 is forbidden per
  rules/agent-security-boilerplate.md. Do not call `Agent` or `TeamCreate`.
- Your file ownership: <explicit list of files>. DO NOT touch any other file.
- If you need cross-boundary changes, do NOT edit — return a summary requesting
  the change in your final report. The teammate will integrate it.
- At ~150K context tokens, STOP, commit pending work, return summary
  (per rules/agent-completion-discipline.md).
- Follow project code discipline (kit-specific: e.g., Burst/[BurstCompile] for
  Unity DOTS, code conventions per rules/code-conventions.md).
- Commit + push to project main per each logical chunk — small commits, not
  one mega-commit at the end.

Starting SHA: <interface-freeze commit>
Phase context: <phase plan excerpt for this sub-area>
Tests of record: <which test files cover your sub-area>

Return when done:
- List of commit SHAs you produced.
- Test pass/fail summary.
- Any cross-boundary changes you needed but did not make (so teammate can integrate).
```

## File-ownership matrix (example template)

The teammate fills this in BEFORE fan-out and includes it in each sub-agent brief:

| Sub-agent | Owns (write) | Reads (no write) |
|---|---|---|
| SA-A | `Systems/SpawnSystem.cs`, `Systems/WaveSystem.cs` | `Components/*.cs` (interface-frozen) |
| SA-B | `Systems/ProjectileSystem.cs`, `Systems/CollisionSystem.cs`, `Systems/DamageNumberSystem.cs` | `Components/*.cs` (interface-frozen) |
| SA-C | `Tests/CombatTests.cs`, `Tests/PlayMode/CombatSmoke.cs` | All sources from SA-A + SA-B |

Test sub-agents (SA-C in the example) intentionally start LAST or in parallel from a known-frozen interface — they should not need to mutate source files.

## Worked example — ChaosForge demo cook (2026-05-23, origin case)

DOTS-AI ChaosForge demo cook, the originating case for this pattern. Sequence:

1. Phase 1 used 5 plain background sub-agents (anti-pattern — already filed elsewhere).
2. Phase 2+ switched to `TeamCreate` with 1 teammate per phase (correct primitive).
3. User asked: *"For now, each teammate is running Opus 4.7 alone. I think we can spawn more sub-agents per teammate."*
4. Answer: yes, depth-2 fan-out within each phase is allowed and was underused.

Per-phase split applied retroactively:

| Phase | Coupling | Sub-agent split |
|---|---|---|
| Combat strip | Medium | SA-A spawning+wave system, SA-B projectiles+collision+damage-numbers, SA-C tests |
| Forge mechanics | Low (naturally parallel) | SA-A smelt+tests, SA-B temper+tests, SA-C reroll+tests |
| Substats+caps | Medium | SA-A substat+caps logic, SA-B UI/HUD wiring, SA-C tests |
| Boss arc | High (coupled) | SA-A boss spawn+arc systems, SA-B intro UI+arc encounter, SA-C tests |
| Realm progression | High (sequential) | SA-A progression+gates, SA-B tests |
| Visualizations | Already team-split | NO sub-agents (already 3-way parallel at team level) |
| Wiki sync | Medium | SA-A wiki pages, SA-B skills-sync+art brief |

Note the "Visualizations" row — already team-split at lead level, so no value in second-level fan-out. Lead-side fan-out and teammate-side fan-out are complementary, not duplicative.

## Risks (the 5 you must document in any project applying this)

1. **File-ownership collision** — last-write wins → silent bugs. Teammate enforces non-overlap via the file-ownership matrix in each spawn brief. NO sub-agent may write a file owned by another.

2. **Interface drift** — sub-agent B changes a stub interface that sub-agent A depends on → A breaks at integration. Mitigation: the Step-1 interface-freeze pass commits the stub interface; sub-agents read from the frozen interface and never mutate it.

3. **Depth-3 accidental spawn (fork bomb)** — sub-agent might attempt to spawn its own sub-agents to "parallelize further". The guardrail template explicitly forbids this. Reinforced by `rules/agent-security-boilerplate.md` (`T1K_FORK_DEPTH >= 2` skip).

4. **Context pressure on teammate** — integration pass aggregates 2-3 sub-agents' output and can balloon to >150K tokens. Per `rules/agent-completion-discipline.md`, teammate commits pending work at the 150K checkpoint before continuing investigation.

5. **Cost / token spend** — 2-3 sub-agents per phase = 2-3x token usage vs. single teammate. Document this trade-off so users can opt in only when wall-clock outweighs token cost (see "When NOT to use" above).

## Anti-patterns

- **Sub-agent spawns its own sub-agents** — fork bomb, forbidden by depth rule. The guardrail template explicitly forbids `Agent` and `TeamCreate` calls from sub-agents.
- **Fan-out without interface freeze** — guaranteed to corrupt cross-boundary state. Always commit interface stubs first.
- **Fan-out into 4+ sub-agents** — integration context ballooning becomes the bottleneck. Cap at 3.
- **Teammate spawns `TeamCreate` instead of `Agent`** — violates the "no recursive teams" constraint in `t1k-team` SKILL.md. Sub-agents are plain `Agent` calls only.
- **Fan-out on naturally sequential phases** — wastes tokens for zero wall-clock gain. Single teammate is correct for sequential work.
- **Sub-agent edits files outside its declared ownership** — emits a `[t1k:skill-bug]` marker per `rules/workflow-failure-auto-issue.md` ("Agent modifies files outside its declared scope"). The teammate's spawn brief MUST be explicit about ownership boundaries.

## Cross-references

- `rules/agent-security-boilerplate.md` — fork-depth rule (the hard constraint this workflow operates within).
- `rules/agent-completion-discipline.md` — 150K-token checkpoint + commit-before-summary (applies to teammate's integration pass).
- `rules/parallelize-batch-work.md` — broader parallelism rule (related but different scope: batch-of-N independent items vs. phase-of-3 disjoint sub-areas).
- `rules/workflow-failure-auto-issue.md` — what to emit when a sub-agent violates its ownership boundary.
- `references/team-operations.md` — operational details for the parent team-level workflow.

## Origin

Filed via issue #266 on `theonekit-core`. Origin case: DOTS-AI ChaosForge demo cook (2026-05-23). Pattern is allowed by existing fork-depth rules but was previously undocumented — teammates would rediscover it ad-hoc each session or (worse) sit idle.
