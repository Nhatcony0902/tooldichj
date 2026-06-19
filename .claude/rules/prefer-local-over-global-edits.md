---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Prefer Local Over Global — Edit Project `.claude/`, Not `$HOME/.claude/`

## Rule

When asked to update, edit, fix, or extend a **rule, skill, agent, hook, or any registry fragment**, default to the **project-local copy** under `./.claude/` — NOT the global copy under `$HOME/.claude/`.

Override only when the user explicitly uses trigger words: "global", "user-level", "user-scope", "$HOME/.claude", "~/.claude", "for me only", "just on my machine", "personal".

If none of those appear, the default is local.

## How to apply

1. Default target = `./.claude/<area>/<file>`.
2. If only the global copy exists, `AskUserQuestion`: copy-local-and-edit (default), edit-global-only, or open the owning kit repo.
3. In kit source repos: edit project-local; CI propagates.
4. In consumer repos: edit project-local; recommend `/t1k:sync-back` to upstream.
5. Never silently edit `$HOME/.claude/` when a project-local exists or could exist.
6. **Readback direction (sync-back):** `t1k-sync-back` walks `./.claude/` FIRST and `$HOME/.claude/` SECOND. Project-local is canonical on both the write (edit) AND read (sync-back) sides.

## Gotcha — Updates CAN clobber divergent local edits (#367)

`t1k modules update` extracts the release ZIP without diffing per-file content. If a project-local `.claude/` file has **diverged ahead** of the kit (edited locally but never synced back), the next update WILL overwrite that divergence.

Run `/t1k:sync-back` FIRST when you have uncommitted local edits — let the kit re-release, then update.

## Anti-patterns

Editing `$HOME/.claude/...` when a project-local equivalent exists; silently falling back to global when local is missing; editing both copies "to be safe".

## Narrow exceptions

Override ONLY when the user uses an explicit global trigger word, the change is user-personal (keybindings, MCP config, memory), or the file only exists in `$HOME/.claude/` by design. When in doubt, `AskUserQuestion`.

## Related

- `rules/orchestration-rules.md` · `rules/module-registry-sync.md`
- `CLAUDE.md` Core Requirement #5 (settings path scope) · Core Requirement #11 (default goal is ship)
