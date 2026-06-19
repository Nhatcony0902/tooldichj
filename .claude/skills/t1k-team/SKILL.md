---
name: t1k:team
description: "Spawn parallel agent teams for large features. Use for multi-agent research, implementation, review, or debugging across independent workstreams requiring 3+ agents."
keywords: [parallel, multi-agent, orchestrate, teammates, concurrent, delegate]
argument-hint: "<template> <context> [--devs|--researchers|--reviewers|--debuggers N] [--delegate]"
effort: high
tools: [Read, Write, Edit, Glob, Grep, Bash, Agent, TeamCreate, TaskCreate, TaskUpdate, TaskList, SendMessage, AskUserQuestion, ToolSearch, Skill]
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# TheOneKit Team — Registry-Aware Agent Teams

Orchestrate parallel Claude Code Agent Teams with T1K infrastructure: registry-routed agents, module-scoped skill injection, manifest-derived file ownership, mandatory worktree isolation.

**Requires:** `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` in settings.json env.
**Requires:** CLI terminal — Agent Teams tools are disabled in VSCode extension.
**Model:** All teammates run Opus 4.6 (Agent Teams constraint).

**Before spawning:** read `## Gotchas` (below) for known harness-level gaps — isolation flag unreliability, shutdown_request often ignored, spawn-subshell alias quirks, fork-depth-2 fan-out limits, teammate-marker collection gap.

## Pre-flight Step 0 — Fuzzy plan/path arg resolution (MANDATORY)

If the user provides a fuzzy plan/path/phase arg (e.g. `chaosforge-demo`, `plans/chaosforge-demo`, `phase-3`), an empty arg, or natural-language ref like "active plan" / "current plan" / "this plan", run the Fuzzy Plan / Path Resolution Protocol at `skills/t1k-cook/references/fuzzy-plan-resolution.md` BEFORE bail. Skill MUST NOT emit "no path matching" / "exact path required" until that protocol has been applied and Step 6 reached.

## Agent Routing

Follow protocol: `skills/t1k-cook/references/routing-protocol.md`
Templates resolve roles dynamically: `t1k-researcher`, `implementer`, `reviewer`, `t1k-debugger`, `t1k-tester`, `t1k-planner`

## Templates

| Template | Purpose | Risk | Reference |
|----------|---------|------|-----------|
| `research` | N researchers, module-scoped angles | Low (read-only) | `references/research-template.md` |
| `review` | N reviewers, registry-routed, module boundary checks | Low (read-only) | `references/review-template.md` |
| `cook` | N implementers, worktree-isolated, manifest ownership | Medium (writes code) | `references/cook-template.md` |
| `debug` | N debuggers, adversarial hypotheses, worktree-isolated | Medium (may add debug code) | `references/debug-template.md` |
| `triage` | Parallel issue/PR processing across kit repos | Low (read + GitHub API) | `references/triage-template.md` |

## Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--researchers N` | 3 | Number of researchers |
| `--reviewers N` | 3 | Number of reviewers |
| `--devs N` | auto | Number of devs (auto = one per module) |
| `--debuggers N` | 3 | Number of debuggers |
| `--delegate` | off | Lead only coordinates, never touches code |
| `--no-plan-approval` | off | Skip plan approval gate (cook template) |
| `--resume <team-name>` | off | Spawn-only recovery mode — read existing team/tasks from disk and spawn missing teammates. No `TeamCreate`, no `TaskCreate`. See `references/resume-template.md`. |

## Pre-flight Protocol (MANDATORY)

**Strict gate sequence — DO NOT invert.** Steps 0+1+2 (introspection) MUST pass before Steps 3-7 (resolution) and template execution (TeamCreate / TaskCreate / Agent). Inverting this order is the root cause of #259 — TeamCreate ran inside a forked sub-context before the Agent gate fired, leaving orphan files on disk.

0.0. **Resolve fuzzy plan/path arg BEFORE the gate sequence.** If the user's arg is not an exact existing path (e.g. `chaosforge-demo`, `plans/chaosforge-demo`, `phase-3`, empty / "active plan"), run the Fuzzy Plan / Path Resolution Protocol at `skills/t1k-cook/references/fuzzy-plan-resolution.md` BEFORE Step 0 (deferred-tool schema load) and BEFORE any bail. Skill MUST NOT emit "no plan matching" / "no team-slug found" / "exact path required" until that protocol has been applied and its Step 6 reached.

0. **Load deferred tool schemas FIRST.** In long-context sessions (1M Opus), `Agent` and `TeamCreate` are commonly auto-deferred — listed in the `<system-reminder>` deferred-tools enumeration but with schemas not yet loaded. Direct calls fail with `InputValidationError`. Always run before any availability check:

   ```
   ToolSearch(query="select:Agent,TeamCreate", max_results=2)
   ```

   ToolSearch returns 0 matches for tools that aren't deferred (either eagerly available OR genuinely absent). Use the deferred-tools listing as the discriminator in Step 1.

1. **HARD GATE — `Agent` callability.** Until this gate returns PASS, **DO NOT call `TeamCreate`, `TaskCreate`, or any other side-effect tool.**

   - **PASS** = `Agent` is in active scope (eagerly available OR loaded via Step 0's `ToolSearch`). Proceed to Step 2.
   - **FAIL** = `Agent` is absent from BOTH active scope AND the deferred-tools listing. The skill is running in a forked sub-context (invoked via `Skill` from inside a sub-agent, or from another `context: fork` skill). Run the bail procedure in `references/fork-context-bail.md` (orphan probe + bail message + recovery hint), then STOP.

   See `references/fork-context-bail.md` for the full bail procedure, the orphan-detection probe, and the verbatim bail message. Issues addressed: #163, #208, #199, #146, **#259**.

2. **HARD GATE — `TeamCreate` callability.** After Step 1 returns PASS, confirm `TeamCreate` is callable. If it is genuinely absent (NOT in the deferred-tools listing, NOT in active scope after Step 0), **AUTO-ENABLE the env var in settings.json, then STOP IMMEDIATELY and ask the user to restart their session** — do NOT silently fall back to plain `Agent` spawning, do NOT proceed with the template.

   **Auto-enable is MANDATORY — fork context (when invoked via `Skill` from a sub-agent) does NOT excuse you.** When this skill IS forked (sub-agent invocation), `Agent`/`TeamCreate` may be absent from scope, BUT `Read`/`Write`/`Edit`/`Bash` are still available. You can — and MUST — write settings.json yourself. Do NOT delegate the write to the lead via prose — that produces the well-documented regression where users see "TeamCreate isn't available" output without any settings.json change. Related: #209.

   **Auto-enable procedure** (full detail: `references/auto-enable-agent-teams.md`):

   a. **Detect target settings.json.** Apply these rules IN ORDER (first match wins):

      1. If user message contains "global", "user-scope", "everywhere", or "all projects" → user-scope `$HOME/.claude/settings.json`.
      2. **Kit-source-repo auto-promotion** — if `<cwd>/.claude/skills/t1k-team/` exists as a directory (i.e., we are INSIDE a kit source repo that ships this very skill), promote to user-scope `$HOME/.claude/settings.json`. Writing to the kit's own `.claude/settings.json` would ship the env var to ~50 consumers via the release pipeline. Detection command: `test -d "$PWD/.claude/skills/t1k-team" && echo kit-source-repo`.
      3. Otherwise → project-scope `<cwd>/.claude/settings.json`.

   b. **Read existing settings.json** (if any) via `Read` tool. If the file already has `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` set to `"1"`, skip the write and display the "already-enabled" message — the user just needs to restart.

   c. **Merge or create** — if settings.json exists with other content, `Edit` to add/merge the env entry, preserving all other keys. If it doesn't exist, create the parent `$HOME/.claude/` directory if missing and `Write` a minimal `{ "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" } }`.

   d. **Display restart instruction** — exact format:

      > **Agent Teams enabled in `<path>`.**
      >
      > Restart your Claude Code session now to load the env var (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Env vars in settings.json only take effect at session start.
      >
      > **CLI:** exit (Ctrl+D or `/exit`), then relaunch `claude`. **VSCode extension:** Agent Teams remains disabled — switch to CLI terminal.
      >
      > After restart, re-run `/t1k:team <template> <context>` and the skill will detect `TeamCreate` is available and proceed.

   e. **STOP IMMEDIATELY** — do NOT attempt to spawn the team in this session. Env vars do not hot-reload; any attempt to call `TeamCreate` before restart will fail.

   Why this matters: `TeamCreate`/`TeamDelete`/the team-mode `SendMessage` variants are only registered as tools when the env var is set at session start. When unset they are absent from the tool list entirely — there is no error to catch. Without this explicit availability check, the AI satisfies "spawn parallel teammates" with whatever tools it has (regular `Agent`), and the user gets degraded "team-shaped output" without worktree isolation, manifest-derived file ownership, or the shared task list. Auto-enabling at first invocation kills the friction of "edit settings.json by hand → restart → retry the command you originally wanted."

   Once verified available (TeamCreate schema loads), call `TeamCreate(team_name: ...)` per the matching template. If `TeamCreate` errors AFTER passing the availability check, surface the error and STOP.
3. **Resolve roles** — follow `skills/t1k-cook/references/routing-protocol.md`
4. **Detect modules** — follow `skills/t1k-modules/references/module-detection-protocol.md`
5. **Derive file ownership** — `references/manifest-ownership-resolution.md`
6. **Build skill injection** — follow `skills/t1k-cook/references/subagent-injection-protocol.md`
7. **Cost warning** — inform user of teammate count and estimated token cost

Every teammate spawn prompt MUST include the T1K Context Block: `references/t1k-context-block.md`

## Decision Discipline (MANDATORY)

When this skill (or any sub-protocol it spawns) needs the user to make a multi-option choice — including yes/no, A-or-B, or any "pick one of these" prompt — you MUST call `AskUserQuestion`. Prose option lists are forbidden, including from skill output that arrives via `<local-command-stdout>`.

**If `AskUserQuestion` appears in the deferred-tools list:** load it FIRST via `ToolSearch(query="select:AskUserQuestion", max_results=1)` before constructing the question. The schema is auto-deferred in 1M-context Opus sessions; the SessionStart hook `decision-tools-preload.cjs` emits a `[t1k:decision-tools]` reminder every session as a backup signal.

**Forbidden prose patterns** in this skill's output AND in any teammate's output:

- "Pick one (reply with the number): 1. … 2. … 3. …"
- "Want me to do A or B?"
- "Should I proceed?"
- Any bulleted/numbered choice list followed by a question mark
- "I cannot use AskUserQuestion right now, so please reply with…" — there is no such fallback; load the schema instead

**When THIS skill body needs a user decision (not just the calling lead):** call `AskUserQuestion` directly from the skill body — do NOT emit a prose option list and rely on the lead to convert it. The lead-side conversion is a fallback for legacy skill output, not the contract. If the schema is deferred, run `ToolSearch(query="select:AskUserQuestion", max_results=1)` first, then call the tool from inside this skill.

**Plan-Fit Assessment Gate (cook template):** before spawning N implementer teammates, the lead MUST present the proposed plan-to-team fit (which modules each dev owns, file-conflict risk, estimated tokens) via `AskUserQuestion` with at least these options: `proceed`, `re-shape teams`, `reduce scope`, `abort`.

**Why this matters:** prose option lists bypass the structured-answer contract — the user must re-type the choice and the skill cannot reliably parse the reply. Full failure-mode catalog + concrete miss examples: `references/decision-discipline-failures.md`.

Cross-reference: `~/.claude/rules/always-ask-on-unresolved.md` § "Failure mode — skills that emit prose option lists", `~/.claude/rules/ask-before-deciding.md`.

## Execution Protocol

**Pre-flight first.** Phase A (Steps 0+1+2) and Phase B (Steps 3-7) are MANDATORY before any side-effect tool call. Once Phase A returns PASS and Phase B completes, IMMEDIATELY execute the matching template sequence. Do NOT ask for confirmation between Phase B and Phase C. Report after each major step.

**`--resume <team-name>` short-circuit.** If the user passes `--resume <team-name>`, route to `references/resume-template.md` after Phase A passes. Resume mode skips Phase B's plan/module resolution (the team and tasks are already on disk) and runs only the `Agent` spawn calls against the pre-populated state.

Details on all operational protocols: `references/team-operations.md`

## Spawn Brief — Mandatory Inclusions

Every teammate spawn prompt MUST include the following discipline reminders. These are owned by other rules; the skill body's job is to ensure orchestrators include them by default — not to duplicate the rule bodies.

| Discipline | One-line for the brief | Owning rule |
|---|---|---|
| 150K context checkpoint (SELF-MONITORED) | "At ~150K context tokens, STOP investigation. Run `git status`. Commit + push any pending edits BEFORE composing your summary or reading more files. **No system reminder fires at 150K** — you must self-monitor. Start finalizing at ~120K; be done committing by ~150K. Multi-commit per logical chunk is preferred over one big final commit." | `~/.claude/rules/agent-completion-discipline.md` + gotcha below |
| Race-free commit (parallel-safe) | "Use `git commit -m '<msg>' -- <file1> [<file2>...]` (pathspec form). NEVER `git add .` / `git add -A` / `git commit -a` / two-step `git add` + `git commit`. Concurrent teammates share the git index; sweeping commits steal other teammates' staged work." | `rules/parallel-teammate-git-index-race.md` |
| Contract-first integration | "When your output meets another teammate's at a shared boundary (API ↔ client, producer ↔ consumer, two modules), the lead-supplied integration contract is authoritative — code against it EXACTLY: exact path/method, payload field names + types + casing, enums, success/error envelope, null semantics. Do not invent or paraphrase the shape. Flag any contract gap to the lead BEFORE implementing your side." | `rules/contract-first-integration.md` |
| Test coverage per Gate 4 | "Every new/modified system MUST have a test in the package's `Tests/EditMode/`. Compile + run tests before reporting done. Zero failures required." | project `CLAUDE.md` § Completion Gates (Gate 4) |
| Burst discipline | "Add `[BurstCompile]` to struct `ISystem` and `OnUpdate`/`OnCreate`/`OnDestroy`. No managed types in `IComponentData`. No `System.Linq` in runtime. No `[BurstCompile]` on static utility classes (BC1064)." | skill `t1k-unity-dots-core-jobs-burst` |
| Parallel-agent worktree variant (Unity submodule) | "When 3+ parallel agents target **divergent branches** on the same git submodule, lead MUST pre-create one worktree per agent (`git worktree add -B <branch> <path> <base>`) BEFORE spawning. Agents commit inside their path; HEAD races are impossible. **Unity caveat:** agents that need `run_tests` MUST stay in the main worktree — the Editor only sees main-worktree content." | `docs/parallel-teammate-git-index-race.md` § "Parallel-agent worktree pattern (Unity DOTS submodule)" |

The teammate brief should reference these rules by name rather than restating the full rule body — keeps briefs short and lets future rule updates flow through automatically. See `references/team-operations.md` for the full T1K Context Block which already includes a slot for these.

## When to Use Teams vs Subagents

| Scenario | Subagents | Agent Teams |
|----------|-----------|-------------|
| Focused single task | **Yes** | Overkill |
| Sequential chain | **Yes** | No |
| 3+ independent parallel workstreams | Maybe | **Yes** |
| Competing debug hypotheses | No | **Yes** |
| Cross-module implementation | Maybe | **Yes** |
| Token budget is tight | **Yes** | No |

## Intra-phase sub-agent fan-out (optional, depth-2)

A teammate owning a single phase can spawn 2-3 background `Agent` sub-agents to parallelize impl + tests within that phase. Requires an interface-freeze pass first to prevent file collisions. See `references/intra-phase-fanout.md` for the 5-step workflow + guardrail template + opt-in/opt-out guidance.

**Constraint:** depth-2 max (per `rules/agent-security-boilerplate.md` — `T1K_FORK_DEPTH` cap). Sub-agents MUST NOT spawn their own sub-agents, and they use plain `Agent` (NOT `TeamCreate` — the "no recursive teams" constraint below still applies).

## Resume Mode — `/t1k:team --resume <team-name>`

Spawn-only recovery for orphan team state. Reads `~/.claude/teams/<name>/config.json` + `~/.claude/tasks/<name>/*.json`, then spawns `Agent` calls for ownerless tasks. No `TeamCreate`, no `TaskCreate`. Pre-flight Step 1 still applies (resume must run from main session).

Full procedure + subject-line → `subagent_type` resolution: `references/resume-template.md`.

## Gotchas

Known harness-level gaps. Read these before spawning. Full detection + workaround + upstream-issue refs for the consumer-side mitigations: `references/known-caveats.md`.

- **Sub-agent fan-out is unavailable at fork depth 2** — only the `Explore` agent type is reachable from a teammate context. When a teammate tries `Agent(subagent_type: "dots-implementer", run_in_background: true)` it fails with `"Agent type 'X' not found. Available agents: Explore"`. `general-purpose` and registry-routed types are NOT in scope at depth 2. Do NOT generate spawn briefs that promise SA-A/SA-B/SA-C partitioning — teammates must single-thread their scope at depth 1, and if their token budget runs out they should hand off to a follow-up teammate spawned by the lead (depth 1), not fan out themselves. See https://github.com/The1Studio/theonekit-core/issues/266.
- **Teammate-emitted markers are NOT auto-collected** — `lesson-collector.cjs` Stop hook parses the team-lead's transcript only. `[t1k:lesson …]` / `[t1k:skill-bug …]` / `[t1k:mcp-gap …]` markers inside `<teammate-message>` blocks are silently dropped, so the auto-issue / auto-sync-back pipeline never fires for team-based workflows. Until that's fixed (https://github.com/The1Studio/theonekit-core/issues/272), team-lead MUST manually invoke `/t1k:issue` (background sub-agent) for each unique marker observed in teammate output.
- **`isolation: "worktree"` is unreliable** — silently no-ops for some teammates; manually `SendMessage` each one explicit `git checkout -b <branch>` instructions right after spawn. See `references/known-caveats.md` § 1.
- **`SendMessage(type: "shutdown_request")` is often ignored** — teammates go idle but don't exit; fall back to `tmux kill-pane` after a ~30s wait. See `references/known-caveats.md` § 2.
- **Spawn subshell does NOT source `.zshrc`** — interactive aliases (e.g. `tcd`) crash teammate launch; always use POSIX `cd` in any teammate-facing command string. See `references/known-caveats.md` § 3.
- **No automatic teammate context capping / checkpoint** — the harness does NOT emit any system reminder, warning, or notification when a teammate approaches its context limit. Teammates are responsible for self-monitoring their own token budget. The 150K rule above is a HARD CEILING that the teammate must observe via self-discipline (multi-commit cadence, "stop at 120K and start finalizing", explicit `git status` checks before context-growing reads). This is the #1 root cause of tail-of-thought stops with uncommitted work — seen 10× in the 2026-05-25 ChaosForge cook session. Lead MUST include the SELF-MONITORED checkpoint row from the Spawn Brief table verbatim in every spawn brief; an explicit `SendMessage` reinforcement after spawn (e.g. "no checkpoint hook — self-manage; commit per logical chunk; at ~120K start finalizing; at ~150K MUST be done committing") is recommended for any session expected to run >100K tokens per teammate.

## Definition of Done (lead contract)

A `/t1k:team` run is **NOT done** when teammates report `TaskUpdate(status: completed)` or when their PRs are opened. The lead MUST drive every teammate PR to the terminal state below before the team's overall work is "done":

| Teammate output | Terminal state |
|---|---|
| PR opened (any teammate) | PR `MERGED` in GitHub (`gh pr view <n> --json mergedAt,state` confirms) |
| PR opened but blocked | Documented `merge-blocked: <reason>` in final report; PR left open with comment |
| No PR (research/review only) | Findings written to `plans/reports/...` and committed |

**Lead's babysit loop** (after each teammate reports "PR opened: <url>"):

1. Use `gh pr merge <n> --auto --squash --delete-branch` (per `~/.claude/skills/t1k-triage/SKILL.md` Step 5a.5 — admin-bypass is escalation only).
2. Poll `gh pr view <n> --json mergedAt --jq .mergedAt` every 30s until non-null.
3. On CI failure, `SendMessage` the original teammate to fix — do NOT spawn a fresh agent.
4. Cleanup procedure (next section) ONLY fires once every PR is MERGED or explicitly `merge-blocked`.

**Anti-pattern:** declaring "all teammates shipped" based on `TaskUpdate(status: completed)` notifications. Those mean "I finished my part." The team's part isn't done until the PR is merged + main pulled + branch deleted.

## Cleanup (lead contract — runs BEFORE final user summary)

After every PR reaches its terminal state (per Definition of Done above), the lead MUST execute the cleanup pass before composing the user-facing victory summary. Full checklist (graceful-shutdown loop, tmux pane kill, worktree prune, sentinel-file removal, branch cleanup, main verification): `references/team-operations.md` § "Successful Completion Cleanup".

The cleanup pass is non-optional even when individual PRs were `merge-blocked` or deferred — orphan state (idle tmux panes, temp worktrees, sentinel files, stale local branches) accumulates fast in multi-agent runs and confuses the next session's git ops.

## Constraints

- Teammates inherit the lead's permission settings at spawn time.
- No recursive spawning: teammates MUST NOT spawn their own Agent Teams.
- **Invoke from the main session only.** When this skill is invoked via the `Skill` tool from a sub-agent (or any other forked sub-context), the `Agent` tool is stripped from scope and teammates cannot be spawned. Pre-flight Step 1 (HARD GATE — Agent callability) bails cleanly in that case with a recovery hint pointing at `--resume`. See issues #163 (original fork-detection), #208 (deferred-tool false-positive fix in v1.91.0), and **#259** (orphan-prevention + recovery mode shipped in this version).
