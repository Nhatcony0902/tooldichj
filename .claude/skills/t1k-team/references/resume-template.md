---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Resume Template — `/t1k:team --resume <team-name>`

Spawn-only recovery against pre-populated team + task state. No `TeamCreate`, no `TaskCreate`.

## When to use

- Phase A bail emitted "Orphan detected" — see `fork-context-bail.md`.
- A team directory `~/.claude/teams/<name>/` exists with `members` containing only `team-lead` (no spawned teammates).
- A previous broken session created the team but never reached the Agent spawn step.

## Pre-flight

Same as SKILL.md Pre-flight Steps 0+1 (Agent must be callable). Resume bails the same way in fork-context — it does NOT create new orphans.

`TeamCreate` availability is NOT required for resume (we don't call it). Skip SKILL.md Step 2.

## Execution

1. **Read team config:**
   ```
   Read(~/.claude/teams/<team-name>/config.json)
   ```
   If file doesn't exist, error: `Team '<name>' not found at ~/.claude/teams/<name>/`. STOP.

2. **List task files:**
   ```bash
   ls -1 ~/.claude/tasks/<team-name>/*.json 2>/dev/null
   ```
   Sort by task ID (numeric). Read each.

3. **Identify ownerless tasks** — task JSON has no `owner` field, OR `owner` is empty string/null.

4. **For each ownerless task — resolve `subagent_type` from the `subject` field:**

   Subject format conventions:
   - `Stream X — <action> (<agent-type>)` → `subagent_type: <agent-type>` (e.g., `(dots-tester)` → `dots-tester`)
   - `Implement: <module> — ...` (cook tasks) → resolve via `skills/t1k-cook/references/routing-protocol.md` for the module's implementer role
   - `Research: <angle>` → `t1k-researcher`
   - `Review: <focus>` → `reviewer` (registry-resolved)
   - `Debug: ...` → `t1k-debugger`
   - `Test: ...` → `t1k-tester`
   - `Triage: <repo>` → `reviewer`

   If subject doesn't match any pattern AND task description doesn't name the agent, ask user via `AskUserQuestion` with options derived from task subject. Do NOT guess.

5. **Spawn:** for each ownerless task with resolved `subagent_type`:
   ```
   Agent(
     team_name: "<team-name>",
     subagent_type: "<resolved>",
     name: "<derived-from-subject>",
     description: "<task subject>",
     prompt: "<task description verbatim> + {T1K Context Block from references/t1k-context-block.md}",
     model: "opus",
     run_in_background: true,
     isolation: "worktree"   # only if task originated from cook template (file ownership in description)
   )
   ```

6. **Report** — one line per task:
   ```
   task #<id> → spawned <agent-name> (<subagent_type>)
   ```
   Plus summary: `Resume: <N> teammates spawned against team '<team-name>'.`

## Constraints

- Resume mode does NOT create the team (already exists). Calling `TeamCreate` for an existing team is a runtime error.
- Resume mode does NOT create new tasks. The task list on disk is the source of truth.
- Resume mode does NOT modify the description, blockedBy, or other task fields. Only writes `owner` after a successful `Agent` spawn (via `TaskUpdate(taskId, status: "in_progress", owner: <spawned-agent-id>)` — the harness usually sets this automatically when `Agent(team_name=...)` succeeds).
- Resume mode MUST run from the **main session**. Same Phase A Step 1 gate applies.
- If `--delegate` was the mode of the original invocation, resume preserves that — lead does not edit files; spawn a dedicated merge teammate for any post-completion merge.

## Anti-patterns

- Spawning teammates for tasks that already have an `owner` set — that creates a duplicate teammate competing for the same task. Skip owned tasks; only spawn for ownerless.
- Calling `TeamCreate` "to be safe" before spawning — fails because team exists.
- Inferring agent type from the description body instead of the subject — subjects are the canonical signal; descriptions are free-form.
- Resuming a team whose `leadSessionId` matches an active session — that lead is already managing the team. Check `pgrep -af claude` and live tmux panes referencing the team before assuming it's truly orphan.

## See also

- `fork-context-bail.md` — the bail procedure that emits "Orphan detected" hints
- `team-operations.md` — full Agent tool reference + lifecycle events
- `t1k-context-block.md` — context block to inject into every prompt
