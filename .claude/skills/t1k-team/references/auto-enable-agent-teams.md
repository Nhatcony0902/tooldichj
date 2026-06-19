---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# Auto-Enable Agent Teams — Procedure

When `/t1k:team` is invoked but `TeamCreate` is not in the deferred-tool list, the skill MUST auto-enable the env var in settings.json instead of just warning the user. After enabling, STOP and ask the user to restart. Env vars in settings.json only take effect at session start — there is no hot-reload path.

## Step-by-step

### 1. Detect target settings.json scope

Default = **project-scope** (`<cwd>/.claude/settings.json`):

- Less invasive — only affects this project
- Easier to revert
- Aligns with `rules/prefer-local-over-global-edits.md`

Promote to **user-scope** (`$HOME/.claude/settings.json`) ONLY if the invoking user message explicitly contains one of these trigger words:

- "global"
- "user-scope"
- "everywhere"
- "all projects"
- "$HOME/.claude"
- "~/.claude"
- "personal"

If none of those appear, use project-scope.

### 2. Read existing settings.json

```
Read tool → target path
```

Three states:

| State | Detect by | Action |
|---|---|---|
| File doesn't exist | Read returns "file not found" error | Go to Step 3 (create) |
| File exists, env var already set to `"1"` | `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1"` | Skip write; display "already enabled" message; STOP |
| File exists, env var missing or value differs | otherwise | Go to Step 4 (merge) |

### 3. Create new settings.json (only if file doesn't exist)

First check if `<target-dir>/.claude/` directory exists. If not, the parent `.claude/` directory must be created. Since the Write tool requires absolute paths, use:

```
Bash: mkdir -p <target-dir>/.claude
```

Then `Write` to the target settings.json:

```json
{
  "env": {
    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"
  }
}
```

DO NOT add other settings, hooks, or env vars — keep the file minimal so the user can extend it later without merge conflicts.

### 4. Merge into existing settings.json

Use the `Edit` tool with these cases:

**Case A — `env` block exists, missing the key:**

```
Edit:
  old_string: '"env": {'
  new_string: '"env": {\n    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1",'
```

**Case B — `env` block exists, key has different value:**

```
Edit:
  old_string: '"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "<old-value>"'
  new_string: '"CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"'
```

**Case C — No `env` block exists, but other top-level keys exist:**

Identify a stable anchor (typically the first top-level key) and Edit to inject the env block before/after it:

```
Edit:
  old_string: '{\n  "<existing-first-key>"'
  new_string: '{\n  "env": {\n    "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1"\n  },\n  "<existing-first-key>"'
```

If JSON structure is ambiguous (multi-line nested, comments, trailing commas), DO NOT guess the edit shape. Surface to user:

> Cannot safely merge env entry into existing `settings.json` — file has non-canonical formatting. Please add manually:
>
> ```json
> "env": { "CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS": "1" }
> ```
>
> Then restart your Claude Code session.

### 5. Verify the write

After Write or Edit, `Read` the file again and confirm `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1"` is present. If verification fails, surface the failure — do NOT proceed with the restart message.

### 6. Display restart instruction (REQUIRED — exact format)

```
**Agent Teams enabled in `<path>`.**

Restart your Claude Code session now to load the env var (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). Env vars in settings.json only take effect at session start.

**CLI:** exit (Ctrl+D or `/exit`), then relaunch `claude`.
**VSCode extension:** Agent Teams remains disabled — switch to CLI terminal.

After restart, re-run `/t1k:team <original-args>` and the skill will detect `TeamCreate` is available and proceed with your original request.
```

### 7. STOP IMMEDIATELY

Do NOT call `TeamCreate` in the current session — the env var is not loaded until restart. Any attempt will fail.

## Failure modes

| Failure | Action |
|---|---|
| Cannot read existing settings.json (permission denied) | Surface error + manual instructions; do NOT retry |
| Cannot write/edit settings.json (permission denied) | Surface error + manual instructions |
| Multi-line nested JSON makes Edit unsafe | Display manual-edit instructions instead (Step 4 fallback) |
| User is in a sub-agent context (no Edit/Write tool in scope) | Surface that the skill must be re-invoked from the main session |
| `<cwd>` is inside a git submodule | Surface `rules/submodule-warning.md` and refuse the project-scope write; recommend user-scope or relaunch from parent root |

## Already-enabled message (Step 2 short-circuit)

When `env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS === "1"` is already in settings.json but `TeamCreate` is not available in this session, the user has the env var set but ran Claude Code without restarting after the change.

Display:

> **Agent Teams env var already set in `<path>`, but the running session predates the change.**
>
> Restart your Claude Code session now to load the env var. CLI: exit + relaunch. After restart, re-run `/t1k:team <args>`.

STOP. Do NOT re-write the file.

## Anti-patterns

- **Don't write to BOTH project and user scope** "to be safe" — pick one based on Step 1's trigger word detection. Writing both creates merge conflicts later.
- **Don't combine the write with other settings.json changes** (hooks, permissions) in the same Edit/Write — that's outside the auto-enable scope.
- **Don't ask the user "should I enable it?"** — they invoked `/t1k:team`, that IS the consent. The auto-enable is the implementation of "yes."
- **Don't add comments to settings.json** explaining the env var — JSON doesn't support standard comments and some parsers reject `// ...`.

## Related

- `SKILL.md` § "Pre-flight Protocol" Step 1 — entry point
- `rules/prefer-local-over-global-edits.md` — project-scope-default rationale
- `rules/submodule-warning.md` — submodule edge case
- `~/.claude/CLAUDE.md` priority #5 — settings path scope (global vs project)
- `skills/t1k-context/...` — settings.json edits that affect context behavior (separate concern)
