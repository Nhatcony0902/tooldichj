---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Fork-Context Bail Procedure

Procedure for SKILL.md Pre-flight Step 1 (HARD GATE — `Agent` callability) when the gate returns FAIL.

> **2026-05-24 update:** `context: fork` was REMOVED from `t1k-team`'s frontmatter (and 11 other core spawning skills). Slash-command invocation from main session now runs with `Agent` always available, so this bail no longer fires on that path. Remaining trigger: `Skill`-tool invocation from a sub-agent (the harness strips `Agent` from sub-agents to prevent recursive spawning).

## When this fires

`Agent` is absent from BOTH active scope AND the deferred-tools listing — Step 0's `ToolSearch` returned `"No matching deferred tools found"` for `Agent` AND `Agent` isn't otherwise callable.

This means the skill is running in a forked sub-context (invoked via `Skill` from inside a sub-agent). The harness has stripped `Agent` to prevent recursive spawning — no skill-level workaround exists.

## Bail steps

1. **Orphan-detection probe** — run BEFORE emitting the bail message:

   ```bash
   { ls -1t ~/.claude/teams/ 2>/dev/null | head -5; echo '---tasks---'; ls -1t ~/.claude/tasks/ 2>/dev/null | head -5; }
   ```

   Cross-reference against the team-slug you would have used for THIS invocation (e.g., `<feature-slug>` for `cook`). If a matching team exists with `members` containing only `team-lead`, it is an orphan from a prior broken run and qualifies for the recovery hint.

2. **Emit the bail message** (substitute `<args>`; OMIT the orphan-recovery paragraph if no match):

   > **`t1k-team` cannot spawn teammates from this fork-context.**
   >
   > The `Agent` tool is not in scope and is not in the deferred-tools listing — this skill was invoked from a forked sub-context (via the `Skill` tool inside a sub-agent, or from another `context: fork` skill).
   >
   > **No teammates were spawned in this run.** Re-invoke `/t1k:team <args>` from the **main session** (the top-level Claude Code prompt, not via `Skill` from a sub-agent).
   >
   > _(Orphan-recovery paragraph — include ONLY if the probe found a matching team.)_
   >
   > **Orphan detected:** team `<team-name>` exists at `~/.claude/teams/<team-name>/config.json` with N tasks at `~/.claude/tasks/<team-name>/`. From the main session, run `/t1k:team --resume <team-name>` to spawn teammates against the pre-populated state — resume mode reads existing task descriptions and emits only the `Agent` spawn calls (no `TeamCreate`, no `TaskCreate`).

3. **STOP IMMEDIATELY.** Do NOT call any other tool after the bail message. The skill is done for this invocation. Do NOT proceed to Step 2 (TeamCreate auto-enable) and do NOT proceed to template execution.

## Forbidden

- Serial-as-lead fallback — silently breaks parallelism + worktree isolation + manifest ownership.
- Calling `TeamCreate`/`TaskCreate` "just to set up state" — that creates the orphan files that caused #259.
- Emitting the bail message AFTER side-effect tool calls (the bail must precede any side effects from this invocation).

## History

| Issue | Symptom | Fix |
|---|---|---|
| #163 | t1k-team silently downgraded to serial when invoked via Skill from sub-agent | Pre-flight Step 1 fork detection added |
| #208 | Step 1 false-positive — flagged main-session as fork-context | Step 0 `ToolSearch` discriminator (v1.91.0) |
| #199 | `AskUserQuestion` deferred-detection false-negative | Decision-tools preload + reminder |
| #146 | `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` pre-flight gate | Step 2 auto-enable procedure |
| **#259** | Orphan team + tasks created BEFORE Step 1 fired, misleading "cannot spawn" status | This file (bail procedure) + `references/resume-template.md` (recovery) + defense-in-depth in templates |
