---
name: t1k:plan
description: "Create phased implementation plans with research and task breakdown. Use for 'plan this feature', 'how should we architect X', 'break this into phases before coding'."
keywords: [plan, architecture, phases, breakdown, design, roadmap, approach]
argument-hint: "[task] OR archive|red-team|validate [--auto|--fast|--hard|--deep|--parallel|--two|--tdd|--team] [--team-devs N|--team-reviewers N|--team-researchers N|--team-debuggers N]"
effort: high
tools: [Read, Grep, Glob, Bash, Write, Edit, MultiEdit, Task, Agent, WebFetch, WebSearch, TodoWrite, AskUserQuestion]
version: 2.20.0
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-base
protected: true
---

# TheOneKit Plan — Implementation Planning

Create phased implementation plans. Routes to registered `t1k-planner` agent via routing protocol.

## Pre-flight Step 0 — Fuzzy plan/path arg resolution (MANDATORY)

If the user's arg is not an exact existing path (e.g. resume an existing plan by partial name like `chaosforge-demo`, or reference `phase-3`, or empty / "active plan" for resume), run the Fuzzy Plan / Path Resolution Protocol at `skills/t1k-cook/references/fuzzy-plan-resolution.md` BEFORE bail.

Skill MUST NOT emit "no plan matching" until the protocol has been applied and its Step 6 reached.

## Tool guard — `AskUserQuestion` availability

`AskUserQuestion` is **always available**, but in long-context sessions it may be deferred (name appears in the deferred-tools system-reminder; schema is NOT loaded).

Decision tree before drafting any multi-option question:

1. **Tool schema visible in the loaded tool list?** → call `AskUserQuestion` directly. No `ToolSearch` needed.
2. **Only the NAME appears in the deferred-tools reminder?** → run `ToolSearch(query="select:AskUserQuestion", max_results=1)`, THEN call the tool.
3. **Neither?** → this is a session-config error. STOP and report it to the user. Do NOT proceed with prose questions.

### Forbidden output — anti-hallucination clause (MANDATORY)

The plan output MUST NEVER contain phrases like:

- "AskUserQuestion is unavailable in this thread"
- "the tool is unavailable, so defaults are listed inline"
- "I would normally batch into AskUserQuestion, but..."
- "the tool was not loaded, defaulting to prose"

These phrases are a **hallucination + violation**. The tool is available — if its schema isn't in your inventory, that is a signal to run `ToolSearch`, not to fall back to prose. If you catch yourself drafting any of these phrases, STOP, emit a `[t1k:skill-bug]` marker for this skill, and restart the question-asking step.

### Failure mode this guard prevents

Assistant remembers the rule, drafts the question correctly in its head, then because the tool schema isn't in the loaded inventory, rationalises "unavailable in this thread → I'll write prose." Drafting prose bullets first is a violation — see `rules/always-ask-on-unresolved.md` "Forbidden prose" table. Especially relevant in plan endgame: "Open questions before I write the plan" lists are the canonical violation pattern.

## When to Use
- Planning new features
- Architecting system designs
- Breaking down complex requirements
- Creating roadmaps with testing/review gates

## Workflow Modes

| Flag | Research | Red Team | Validation | Cook Handoff |
|------|----------|----------|------------|--------------|
| `--auto` | Auto-detect | Follows mode | Follows mode | `/t1k:cook` |
| `--fast` | Skip | Skip | Skip | `/t1k:cook --auto` |
| `--hard` | 2 researchers | Yes | Optional | — |
| `--deep` | 3 researchers | Yes | Mandatory | — |
| `--parallel` | 2 researchers | Yes | Optional | `/t1k:cook --parallel` |
| `--tdd` | Composable with any mode | — | — | Annotates phase cards with 3.T/3.I/3.V sub-steps |
| `--team` | Composable with any mode | — | — | Emits explicit teammate roster per phase; cook handoff → `/t1k:team cook` |

Mode comparison, `--deep` vs `--hard`, and `--team` details: `references/workflow-modes.md`. Team-shape output contract (sections, defaults, model-per-teammate per issue #268): `references/team-shape-template.md`.

### Guards

- `--hard + --deep`: REFUSE. `--deep` is a strict superset of `--hard`; use one or the other.
- `--fast + --deep`: REFUSE. Fast mode skips rigor; `--deep` mandates it. They are incompatible.
- `--tdd + --parallel`: REFUSE. TDD requires strict T→I→V ordering; parallel execution cannot preserve it.
- `--fast + --hard`: ALLOWED but discouraged — document the reason in the plan.
- `--team` sub-flags (`--team-devs`, `--team-reviewers`, `--team-researchers`, `--team-debuggers`): IGNORED unless `--team` is also present. Warn the user if any sub-flag is set without `--team`.

## Subcommands
| Subcommand | Purpose |
|---|---|
| `/t1k:plan archive` | Archive plans + journal |
| `/t1k:plan red-team` | Adversarial plan review |
| `/t1k:plan validate` | Critical questions interview |

## Context Reminder

After plan creation, output the cook handoff line:

- **Default:** `/t1k:cook {plan-path}` (single-agent execution).
- **When `--team` was set:** `/t1k:team cook {plan-path}` (multi-teammate execution honoring the team-shape sections). NEVER suggest `/t1k:cook` for a `--team` plan — single-agent execution ignores the team-shape and silently downgrades the parallelism the plan was built around.

## Open Questions Gate (MANDATORY)

If the t1k-planner needs to confirm 2-4 design decisions before finalizing the plan
(e.g., "scope target A or B?", "use module X or Y?", "tier thresholds?"), the
t1k-planner MUST invoke `AskUserQuestion` (batch up to 4 per call). NEVER list open
questions as numbered prose with checkbox-style alternatives, default tables, or
"override before /t1k:cook" tables — these are all violations regardless of the
disclaimer wrapping them. This applies at every step where decisions remain —
not just the final cook handoff.

**Self-check before writing the plan file:** scan your draft for any section
matching `D[0-9]+ | Decision | Default | Alternatives` or `## Open Design
Decisions` headers. If found, your plan was written by the failure mode — delete
the section, invoke `AskUserQuestion` for those items, and rewrite the section
as resolved decisions (no "default" / "alternative" columns).

See `rules/ask-before-deciding.md` → "Failure mode — post-design open questions"
for the exact pattern to avoid.

## Agent Routing
Follow protocol: `skills/t1k-cook/references/routing-protocol.md`
This command uses role: `t1k-planner`

### Multi-round plan-review fan-out (named-agent routing)

When `--deep`, `--hard`, `/t1k:plan validate`, or `/t1k:plan red-team` triggers multi-round review, each round MUST spawn an explicitly-named specialist agent. `general-purpose` is NEVER acceptable here — it erases the quality/cost intent of the round.

| Round | Focus | Canonical agent | Default model |
|-------|-------|-----------------|---------------|
| 1 — Rigor | Completeness, edge-case coverage, assumption audit | `t1k-planner` | `opus` |
| 2 — Technical | Implementation feasibility, tech-debt risk, skill-body tightness | `t1k-code-reviewer` | `sonnet` |
| 3 — Facts | Reference accuracy, link validity, claim verification | `t1k-researcher` | `sonnet` |
| 4 — Adversarial | Attack vectors, anti-patterns, pessimistic stress-test | `t1k-planner` (red-team brief) | `opus` |

**Spawn contract:** each round agent receives the prior round's output + the original plan as Fork Context Brief (`skills/t1k-resolve-context/references/fcb-protocol.md`). The assembling agent (final round or integration step) synthesizes conflicts; it does not re-run the rounds.

## Skill Inventory Injection (if `installedModules` present in metadata.json)

Before spawning t1k-planner agent:
1. Read `.claude/metadata.json` → `installedModules` (v3) or `modules` (v2 fallback)
2. Read ALL `t1k-activation-*.json` → collect skill names grouped by module
3. Inject into t1k-planner prompt as inventory (names + modules, NOT full activation):
   "Available skills by module:
    - {module} v{version} (kit: {kit}): {skill1}, {skill2}...
    You can READ skill files if needed. DO NOT activate skills — planning only."

## Team-Shape Planning (`--team` flag)

When the user passes `--team`, the planner MUST emit two team-shape sections in the generated plan:

1. **Upfront `## Team Layout`** in `plan.md` — cross-phase roster summary table (phase → teammates → roles → worktrees → parallel cap).
2. **Per-phase `### Team Shape`** in each `phase-N.md` — concrete spawn-ready roster: agent type, **explicit `model:` field**, module scope, ownership globs, worktree flag, spawn order, and skills each teammate should activate first.

The planner MUST also emit a tail `## Plan-Fit Assessment (--team)` section consumed by the lead at `/t1k:team cook` time.

Full output contract (sections, defaults, model-per-teammate rationale, sub-flag interaction, composability with `--deep`/`--hard`/`--tdd`, worked example): `references/team-shape-template.md`.

**Why `--team` is a plan deliverable, not a runtime decision:** the Claude Code harness hard-strips the `Agent` tool at fork depth ≥ 1. Teammates spawned by `/t1k:team` (depth 1) cannot spawn further sub-agents — they can only invoke the `Skill` tool. So the cast must be fixed before the lead calls `TeamCreate`. Spec: `skills/t1k-team/references/fork-context-bail.md`.

**Model per teammate (issue #268):** each roster entry MUST carry an explicit `model:` value (default `sonnet`). Without it, the lead inherits the parent's model — and if the parent is Opus, every "default" teammate silently runs at ~5x cost. The `--team` output contract enforces named models.

## Multi-Agent Planning Pipeline (if 2+ modules matched)

Auto-detect: count distinct modules with keyword matches.
- 0-1 modules → single t1k-planner (standard)
- 2+ modules → multi-agent pipeline:

**Phase A** — Domain Design (if designer kit installed): spawn designer agent
**Phase B** — Domain Planning (PARALLEL): one t1k-planner per matched module
**Phase C** — Integration (sequential): generic t1k-planner assembles domain plans

## Execution Trace (if features.executionTrace enabled)
After task completes, output compact planning trace:
- Modules matched, pipeline mode (single/multi)
- Skills inventory provided (count across modules)
- Fallbacks, warnings

## Risk Assessment (Mandatory Output)

Every plan phase must include a risk table and effort estimate:

```markdown
### Risk Assessment
| Risk | Likelihood (1-5) | Impact (1-5) | Score | Mitigation |
|------|-----------------|--------------|-------|------------|
| {risk} | {L} | {I} | {L*I} | {action} |

### Timeline
| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1: {name} | S (1d) / M (3d) / L (1wk) | {blocker or dep} |
| Total | {sum} | Critical path: {phase list} |
```

**Effort scale:** S = ~1 day, M = ~3 days, L = ~1 week. Use judgment, not false precision.
**Risk score >= 15** = high risk, mandate mitigation before phase starts.

## Architecture References

For self-assembling kit architecture (Pillars 1–4: SSOT spec files, schema versioning + auto-migrate, declarative CI gates, lifecycle hub) and the canonical phasing model that produced the safety-addendum plan, see `plans/reports/260422-1248-self-assembling-kit-architecture.md`. Plan authors working on TheOneKit infrastructure should align new phases with the §3 Seven Pillars and §11 Consumer Impact & Rollout sequence.

## Sub-Agent Fork Hygiene

**Sub-agent forking:** see `skills/t1k-architecture/references/fork-hygiene.md`.
