---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# TheOneKit Orchestration Rules

Classify every user request and route to the matching T1K command. The authoritative role→agent and keyword→command routing lives in the `t1k-routing-*.json` fragments — read those to resolve.

## Decision Tree

Classify the request, then route: feature/implement → `/t1k:cook` · planning/architecture → `/t1k:plan` · bug/error/compile → `/t1k:fix` · run tests → `/t1k:test` · investigate/debug → `/t1k:debug` · code review → `/t1k:review` · documentation → `/t1k:docs` · git ops → `/t1k:git (cm|cp|pr|merge)` · skill/agent mgmt → `/t1k:issue`, `/t1k:sync-back` · triage issues/PRs → `/t1k:triage` · brainstorm/ideation → `/t1k:brainstorm` · technical question → `/t1k:ask` · explore codebase → `/t1k:scout` · session review → `/t1k:watzup` · registry validation → `/t1k:doctor` · usage guide → `/t1k:help` · module mgmt → `/t1k:modules` · parallel multi-agent → `/t1k:team` · stuck/blocked → `/t1k:problem-solve` · structured reasoning → `/t1k:think`.

## Priority Order

1. **T1K Commands** (registry-routed workflows)
2. **Skills** (auto-activated by keyword context)
3. **Standard Tools** (Read, Write, Edit, Bash — trivial tasks only)

## Task-Type → Agent Routing

Before spawning ANY background sub-agent, prefer the narrowest specialized agent. `general-purpose` is the LAST RESORT. Generic agents (`t1k-tester`, `t1k-code-reviewer`, `t1k-debugger`, `t1k-docs-manager`, `t1k-fullstack-developer`, `t1k-brainstormer`, `t1k-project-manager`) are wrong for kit-specific tasks — they lack kit context.

Core-universal rows:

| Task pattern | Canonical agent | NEVER use |
|---|---|---|
| Skill creation / SKILL.md updates / agent definition edits | `t1k-skills-manager` | `general-purpose` |
| Cross-kit work (release-action scripts, CLI, kit fragments, sync-back, issue filing) | `t1k-kit-developer` | `general-purpose` |

**Filing an issue / opening a PR via `gh`:** prefer the `/t1k:issue` skill (and `/t1k:sync-back` for fragments) over a raw `general-purpose` `gh` sub-agent — full routing rows (skill-bug → `t1k-skills-manager`, kit-code → `t1k-kit-developer`, general → `t1k-project-manager`): `docs/orchestration-rules.md`.

**Engine/designer kits supply their own routing rows** via their `t1k-routing-*.json` fragments + kit-local rule extensions. **Rule of thumb:** if the task names a kit-specific concept (DOTS, ECS, Unity, scenes, shaders, wiki, game design), route to that kit's canonical agent; reach for `general-purpose` only when genuinely engine-agnostic.

## Mandatory Skill Usage (NEVER bypass)

- `/t1k:sync-back` — sync .claude/ changes to kit repos. Background sub-agent only.
- `/t1k:issue` — report skill/agent bugs. Background sub-agent only.
- `/t1k:triage` — process issues/PRs. Never manually browse issues.
- `/t1k:git` — git operations. Never raw git commit/push without security checks.
