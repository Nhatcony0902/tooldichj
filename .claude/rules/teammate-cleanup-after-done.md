---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Teammate Cleanup — Shutdown After Done

## Rule

Teammates spawned via `TeamCreate` + `Agent({team_name})` MUST be cleaned up after they finish. Trigger on `TaskUpdate(status: "completed")` flip — NOT on SendMessage receipt. Unlike `Agent({run_in_background: true})` sub-agents (which self-terminate), teammates persist until explicitly shut down.

Full sequence (5-step shutdown, spawn-brief addendum, anti-patterns, history): `docs/teammate-cleanup-after-done.md`.

## Verify at TWO levels — process AND tmux pane

`shutdown_request` is often acknowledged but not honored, and force-killing a teammate's process leaves its tmux pane open at an idle shell — so `pgrep` alone can report 0 agents while dead panes remain (**process-dead ≠ pane-closed**). Cleanup must kill the agent processes AND `tmux kill-pane` each leftover pane (keep the lead's own pane; leave other projects' tmux sessions), verifying with `tmux list-panes` — not `pgrep` alone — before `TeamDelete`.

## Why

Idle teammates hold mailbox connections + consume context budget; on long sessions with 8+ teammates this compounds. Established 2026-05-23 during DOTS-AI ChaosForge demo cook session.

## Related

- `rules/agent-completion-discipline.md`
- `skills/t1k-team/SKILL.md`
