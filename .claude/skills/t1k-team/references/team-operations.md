---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Team Operations

## Tool Reference

### Agent Tool (spawn teammates)

```
Agent(
  subagent_type: "<registry-resolved-type>",
  description: "short task summary",
  prompt: "full instructions + T1K Context Block",
  model: "opus",                    # Required for Agent Teams teammates
  run_in_background: true,          # Non-blocking spawn
  isolation: "worktree"             # Git worktree isolation (cook devs)
)
```

**Note:** `Task` was renamed to `Agent` in v2.1.63. Both names work; prefer `Agent` for new code.

**Teammate budget ceiling (MANDATORY):** Teammates spawned via `Agent` hit a hard **~47-52 tool-use ceiling** and terminate mid-thought (no explicit error). Design teammate tasks for ≤40 tool uses each. Commit per task, not per batch, so partial progress survives a wall-hit. Full gotcha list in `t1k-cook/references/subagent-patterns.md` → "Gotchas & Budgeting" section.

### Team Management Tools

| Tool | Purpose | Params |
|------|---------|--------|
| `TeamCreate` | Create team + shared task list | `team_name`, `description` |
| `TeamDelete` | Remove team resources | *none* |
| `TaskCreate` | Create work item | `subject`, `description`, `priority`, `addBlockedBy`, `addBlocks` |
| `TaskUpdate` | Claim/complete task | `taskId`, `status`, `owner`, `metadata` |
| `TaskGet` | Full task details | `taskId` |
| `TaskList` | All tasks (minimal fields) | *none* |
| `SendMessage` | Inter-agent messaging | `type`, `to`/`recipient`, `message` |

### SendMessage Types

| Type | Purpose |
|------|---------|
| `message` | DM to one teammate (requires `recipient`) |
| `broadcast` | Send to ALL teammates (use sparingly) |
| `shutdown_request` | Ask teammate to gracefully exit |
| `shutdown_response` | Teammate approves/rejects shutdown (requires `request_id`) |
| `plan_approval_response` | Lead approves/rejects teammate plan (requires `request_id`) |

## --delegate Mode

When `--delegate` flag is passed:
- Lead ONLY: spawns teammates, manages tasks, sends messages, synthesizes reports
- Lead NEVER: edits files, runs tests, executes git commands directly
- For cook Step 6 MERGE: spawn a dedicated merge teammate instead of lead doing it

## T1K Differentiators (vs CK `/team`)

| Aspect | CK `/team` | T1K `/t1k:team` |
|--------|-----------|------------------|
| Role resolution | Hardcoded `subagent_type` | Registry-routed via `t1k-routing-*.json` |
| Skill injection | None | Module-scoped per `subagent-injection-protocol.md` |
| File ownership | Manual glob patterns | Auto-derived from `.t1k-manifest.json` |
| Worktree | Optional | Mandatory for cook/debug |
| Module boundaries | Not checked | Reviewed for violations |
| Triage | Not available | Parallel cross-repo processing |

## Display Modes

| Mode | How | When |
|------|-----|------|
| `auto` (default) | Split panes if in tmux, otherwise in-process | Default |
| `in-process` | All in one terminal. `Shift+Up/Down` navigate. `Ctrl+T` task list. | No tmux |
| `tmux/split` | Each teammate gets own pane. Requires tmux or iTerm2. | Recommended for cook/debug |

Override with `--teammate-mode in-process` or `--teammate-mode split`.
**Incompatible:** Windows Terminal, basic SSH, serial consoles.

## Monitoring & Event Lifecycle

**Event order per teammate:**
```
SubagentStart -> [work...] -> TaskCompleted -> SubagentStop -> TeammateIdle
```

**Primary:** Event-driven hooks — TaskCompleted and TeammateIdle events auto-notify the lead.
**Fallback:** TaskList poll every 60s if no events received.
**Stuck:** If teammate unresponsive >5 min, SendMessage directly. If still stuck, shutdown and replace.

## Cross-Session Memory

Teammates retain learnings in `~/.claude/agent-memory/<name>/` (persists after TeamDelete).

Add `memory: project` to teammate's agent definition frontmatter. First 200 lines of `MEMORY.md` auto-injected at start.

## Worktree Isolation (Cook Template)

`isolation: "worktree"` gives each dev:
- **Own git worktree** — isolated working directory, staging area, HEAD
- **Own branch** — auto-created, returned in agent result
- **No file conflicts** — devs can edit same files independently

After all devs complete, lead merges branches sequentially.

## Token Budget Estimates

| Template | Teammates | Estimated Tokens |
|----------|-----------|-----------------|
| Research (3) | 3 | ~150K-300K |
| Review (3) | 3 | ~100K-200K |
| Cook (auto) | 2-5 | ~400K-800K |
| Debug (3) | 3 | ~200K-400K |
| Triage | 2-4 | ~200K-400K |

## Error Recovery

1. **Check status:** `Shift+Up/Down` (in-process) or click pane (split). Or TaskList.
2. **Redirect:** SendMessage with corrective instructions to specific teammate
3. **Replace:** Shutdown failed teammate, spawn replacement for same task
4. **Reassign:** TaskUpdate stuck task to unblock dependents
5. **Abort:** SendMessage(type: "shutdown_request") to all, then TeamDelete

## Successful Completion Cleanup

Runs AFTER every teammate PR reaches its terminal state (per the SKILL.md "Definition of Done" contract) and BEFORE the lead composes the user-facing victory summary. Distinct from "Abort & Cleanup" below (which fires when the run itself is being abandoned).

```
1. Shutdown every teammate (graceful, with timeout fallback)
2. Kill any leftover tmux panes
3. Remove temp worktrees + prune
4. Delete temp sentinel files
5. Verify main checkout is clean
6. (Optional) Delete team config + task list if retrospective not needed
7. Compose final report to user
```

### 1. Graceful shutdown (per teammate)

```
SendMessage(to: <teammate>, message: {type: "shutdown_request"})
```

Wait for `shutdown_response` (`approve: true`). **Timeout: ~30s.** If no response — per known caveat #2, the `shutdown_request` channel is often ignored — fall through to Step 2 (`kill-pane`) for that teammate.

### 2. Kill any dead tmux panes

Capture LEAD_PANE FIRST — never assume the lead lives at pane_index 1 (the user may have split the window before opening Claude, putting the lead at index 2+):

```bash
LEAD_PANE=$(tmux display -p '#{pane_id}')

# Inspect: list panes that are not the lead
tmux list-panes -F '#{pane_id} #{pane_current_command}' \
  | grep -v "^${LEAD_PANE} "

# Kill them
tmux list-panes -F '#{pane_id}' \
  | grep -v "^${LEAD_PANE}$" \
  | xargs -r -n1 tmux kill-pane -t
```

### 3. Remove temp worktrees + prune

```bash
git worktree list | grep '/tmp/' | awk '{print $1}' | xargs -r -I{} git worktree remove --force {}
git worktree prune
```

### 4. Delete temp sentinel files

```bash
rm -f /tmp/t1k-team-preflight-*.marker
rm -f /tmp/t1k-teammate-markers-*.jsonl
```

### 5. Verify main checkout is clean

```bash
git checkout main
git pull --ff-only
git status --short        # must be empty
gh pr list --state merged --limit 50 --json headRefName --jq '.[].headRefName' \
  | xargs -r -I{} git branch -D {} 2>/dev/null || true
```

Use `gh pr list --state merged` for branch detection — `git merge-base --is-ancestor` lies on squash-merged branches (see `feedback_squash_merge_cleanup` memory note). Always use `git branch -D` (capital `-D`) for that reason.

### 6. (Optional) Delete team config + task list

Skip this step if you want to grep the team's history later for retrospective.

```bash
rm -rf ~/.claude/teams/<team-name>/   # gate:allow-rm-claude (subdirectory cleanup, not the tree)
rm -rf ~/.claude/tasks/<team-name>/   # gate:allow-rm-claude (subdirectory cleanup, not the tree)
```

### 7. Compose final report to user

One line per workstream: `"Wn: PR #N merged at <SHA>"`. Confirm `"all panes killed, all worktrees removed, on main, working tree clean"`. If any teammate refused shutdown_request or any cleanup step partially failed, surface that — don't silently leave orphans.

### Why this section is separate from "Abort & Cleanup"

Abort fires when the run is being abandoned mid-flight (failed PRs, user cancellation, runaway costs). Successful Completion Cleanup fires after every PR ships and the lead's contract is fulfilled. The two are operationally similar but have different decision contexts: abort skips Steps 5–7's main-verification and final-report mechanics because the work itself is being discarded, while completion cleanup REQUIRES them.

Verified failure mode (2026-05-24, `cook-triage-260524-0231`): lead declared victory after teammates reported PR-open, skipped the cleanup pass entirely, left 7 idle tmux panes + 4 worktrees + sentinel files on disk. User had to prompt "don't forget to clean up after finishing all" to trigger the pass.

## Abort & Cleanup

```
1. SendMessage(type: "shutdown_request") to each teammate
2. Wait for shutdown_response (or timeout 30s)
3. TeamDelete (no parameters)
4. tmux kill-pane for each teammate split (MANDATORY in split mode)
```

**Step 4 is non-optional in `split`/`tmux` display mode.** TeamDelete only releases team metadata — it does NOT close the tmux panes that teammates ran in. The panes remain as idle zsh splits cluttering the lead's window. The lead MUST explicitly close them:

```bash
# Capture the lead's pane ID FIRST — never assume the lead lives at pane_index 1.
# (If the user split the window before opening Claude, the lead can be at index 2+.)
LEAD_PANE=$(tmux display -p '#{pane_id}')

# Inspect: list teammate panes in the current window (everything except the lead)
tmux list-panes -F '#{pane_id} #{pane_current_command}' \
  | grep -v "^${LEAD_PANE} "

# Kill them
tmux list-panes -F '#{pane_id}' \
  | grep -v "^${LEAD_PANE}$" \
  | xargs -r -n1 tmux kill-pane -t
```

The `pane_id` capture is non-negotiable — earlier versions of this recipe used `awk '$2 != "1"'` (positional index) and would silently kill the lead if it happened to live at any non-1 position.

Real-world miss (2026-05-08, t1k-prefix-universal session): lead closed 12 teammates via TaskStop + TeamDelete but left 5 idle split panes open. User had to ask "why after close the teamate, you don't close the split for me also?" Treat pane cleanup as part of TeamDelete, not a follow-up the user has to chase.

**If unresponsive:** Close terminal or kill session. Then manually clean up:
- `rm -rf ~/.claude/teams/<team-name>/` — orphaned team state <!-- gate:allow-rm-claude (subdirectory cleanup, not the tree) -->
- `git worktree list` -> `git worktree remove <path>` — orphaned worktrees
- `tmux kill-pane` for any leftover teammate splits in the lead window

## Named-agent handles persist for the session's lifetime

Spawning an agent with the Agent tool's `name:` parameter (e.g. `name: "auditor-core"`) registers a **SendMessage handle** in the lead session. That handle is **NOT cleared** by any of:

- The agent's process exiting on completion
- `TaskStop` on the agent's task
- `TeamDelete` (handles are session-scoped, not team-scoped — they exist even when no TeamCreate was ever called)
- Killing the agent's tmux pane

The handles remain visible in the lead's Claude Code **status bar** (e.g. `@main @auditor-core @auditor-dual-tree …`) and addressable via `SendMessage({to: "auditor-core", …})` until the **lead session itself ends** (`/exit` or terminal close). There is no harness API to deregister a single finished handle.

**Practical implication for the lead:** "All teammates closed" is a four-part claim that requires verifying ALL of these independently:

| What | How to verify it's gone |
|---|---|
| Agent process | `ps aux \| grep claude` shows only the lead PID |
| tmux pane | `tmux list-panes` shows only the lead pane |
| Team metadata | `ls ~/.claude/teams/` is empty + `TeamDelete` returns "no team" |
| **Status-bar handle** | **Cannot be cleared mid-session — only `/exit` removes it** |

Do not say "all closed" unless all four are confirmed. The status-bar handle is the one most likely to be missed because it has no on-disk artifact and no tool to clear it.

Real-world miss (2026-05-08, t1k-prefix-universal session): lead reported "all teammates closed" after killing processes + panes + TeamDelete, but the user pointed at the status bar still showing 5 `@auditor-*` names. Lead had to explain those were stale handles from earlier `Agent({name: ...})` spawns, only clearable by ending the lead session.

**Workaround:** if status-bar cleanliness matters mid-session, prefer **anonymous** `Agent` spawns (omit the `name:` parameter) for short-lived background work. Reserve named handles for teammates you need to address by name via SendMessage. Once a named handle is created, it's permanent for the session.

## Gotcha — `TaskUpdate(description: ...)` re-fires the `task_assignment` notification

Editing a task's `description` (or `subject`, `activeForm`, or `metadata`) via `TaskUpdate` while the task already has an `owner` set re-fires the `task_assignment` notification to that owner. This is **silent and easy to miss** — there is no indication in the team-lead's TaskList output that the teammate received a duplicate prompt.

Failure mode for the teammate:
1. Teammate is mid-work on Phase X, has read the brief, opened files, started edits.
2. Team-lead notices a typo in the description and runs `TaskUpdate(taskId: X, description: "<corrected>")`.
3. Teammate receives a fresh `task_assignment` notification with the corrected description.
4. Teammate's prompt re-enters at the top of the brief — re-reads the (now slightly different) instructions, possibly re-runs setup steps, may overwrite their own in-progress state.

Reproduced 2026-05-23 in a multi-phase cook session — team-lead corrected a deliverable path mid-task; teammate restarted from the brief, redid work, lost 8 min of context.

**Mitigation patterns:**

- **Never `TaskUpdate(description: ...)` after `owner` is set.** Treat the description as immutable once a teammate is in flight. If you need to communicate a correction, send a `SendMessage` with a `correction:` prefix — the teammate can read it as supplemental context without restarting.
- **Use `metadata` for non-essential edits.** Per-team-lead notes ("delegated to phase7a-data at 02:31") go in `metadata`, not `description`.
- **If you MUST edit description**, first `SendMessage` the teammate to abort cleanly, wait for acknowledgment, then `TaskUpdate` + reassign.
- **For team-lead bookkeeping only** (e.g., adding a SHA after the teammate ships), accept that the teammate's prompt will re-fire — but they're done by then, so the only cost is a no-op acknowledgment turn.

## Gotcha — MCP-owner pattern for 6+ parallel teammates that need Unity MCP

The Unity MCP bridge is single-threaded per-Editor-instance. When ≥6 parallel teammates each issue MCP calls within the same minute, the bridge enters a degraded state: `set_active_instance` calls race, `refresh_unity` returns false "recovered" responses, `read_console` returns stale results for 25–45 min windows. Detailed failure modes + filesystem-level signals are documented in the Unity kit's `t1k-unity-base-mcp-skill` → "Multi-teammate MCP race" gotcha.

**Team-lead mitigation (apply when spawning ≥6 MCP-using teammates):**

1. **Designate ONE teammate as `MCP-owner`** in the spawn brief. Example: `"You (phase6a) are the MCP-owner for this wave. All sibling teammates will SendMessage you for any refresh_unity / read_console / run_tests call they need."`
2. **All other teammates work filesystem + Bash only** — `Write`, `Edit`, `git status`, `find`, `grep`, `cat`. No `mcp__UnityMCP__*` calls directly.
3. **Sibling teammates request MCP via SendMessage to the MCP-owner**, who batches calls every 30s and replies with results.
4. **Final dots-tester teammate runs sequentially** (not parallel with the wave) for Gate 3 (compile-clean) + Gate 4 (test-pass) verification.

**Alternative — sequential MCP waves:** if every teammate genuinely needs direct MCP, run them sequentially with a 60-second cooldown between starts (no two teammates open the bridge in the same minute). Wall-clock cost is higher but eliminates the race entirely.

**When to ignore this rule:** if the wave is ≤5 teammates OR none of them touch MCP (pure design / wiki / planning work), the bridge contention does not appear and the MCP-owner pattern is overhead.

Reproduced 2026-05-24 in a DOTS-AI ChaosForge cook (sleep-run, 8 concurrent teammates). Four teammates deferred Gate 3/4 verification because MCP returned timeouts for >25 min. Future cooks should bake the MCP-owner pattern into the wave-spawn template from the start.

## Limitations

- **One team per session** — cannot manage multiple teams simultaneously
- **No nested teams** — teammates cannot spawn their own teams
- **Fixed lead** — no lead promotion/transfer during session
- **Opus 4.6 only** — all teammates must run same model
- **TTY required** — Agent Teams disabled in VSCode extension
- **Session resume broken** — `/resume` does not restore in-progress teammates
- **Instruction-based ownership** — file ownership enforced by prompt, not filesystem locks
- **No CI/CD mode** — Agent Teams requires interactive terminal
