---
name: t1k:git
description: "Git operations with conventional commits. Stage, commit, push, PR, merge. Security scans for secrets. Auto-splits commits by scope."
keywords: [git, commit, push, branch, pull-request, stage, merge, issue-link, fixes, closes]
argument-hint: "cm|cp|pr|merge [args]"
effort: low
version: 2.20.0
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-base
protected: true
---

# TheOneKit Git — Git Operations

Unified git command. Routes to registered `t1k-git-manager` agent via routing protocol.

## Default (No Arguments)

Use `AskUserQuestion` to present available operations:

| Operation | Description |
|-----------|-------------|
| `cm` | Stage files and create commits |
| `cp` | Stage files, create commits, and push |
| `pr` | Create Pull Request |
| `merge` | Merge branches |

## Arguments
- `cm`: Stage files and create commits
- `cp`: Stage files, create commits, and push
- `pr [to-branch] [from-branch]`: Create Pull Request
- `merge [to-branch] [from-branch]`: Merge branches

## Core Workflow

### Step 1: Stage + Analyze
```bash
git add -A && git diff --cached --stat && git diff --cached --name-only
```

### Step 2: Security Check
```bash
git diff --cached | grep -iE "(api[_-]?key|token|password|secret|credential)"
```
**If secrets found:** STOP, warn user, suggest `.gitignore`.

### Step 2.5: Local Quality Gate — Lint + Typecheck

Before commit, run the kit's quality scripts if present. This catches CI-side failures (biome, eslint, ruff, tsc) that would otherwise bounce the PR.

```bash
# Auto-discover scripts
jq -r '.scripts | to_entries[] | select(.key | test("^(lint|typecheck|check)$")) | .key' package.json 2>/dev/null
```

Then run each discovered script (short-circuit on first failure):

| Script | Purpose | If fails |
|---|---|---|
| `typecheck` / `check` | Type-check source | STOP — fix types before commit |
| `lint` | Style/format check (biome/eslint/ruff) | STOP — run `bun run lint --write` or equivalent auto-fix, then re-check |

**Skip rules:**
- No `package.json`: skip (not a Node/Bun project). Check for `Cargo.toml`, `pyproject.toml`, etc.; run their equivalents (`cargo check`, `ruff check`).
- Script doesn't exist: skip that script silently.
- User explicitly passed `--skip-lint`: skip with a warning in output.
- Staged diff is 100% docs-only (all `*.md` / `docs/**`): skip — content rules only.

**Rationale:** Over the span of PR #79 (2026-04-21), three CI rounds were lost to biome format violations that `bun run lint` would have caught in 3 seconds locally. Running lint before commit costs a few seconds; skipping it costs a full CI cycle + a fix-up commit that pollutes the PR history.

### Step 3: Split Decision
Split commits if: different types mixed, multiple scopes, FILES > 10 unrelated.
Single commit if: same type/scope, FILES <= 3, LINES <= 50.

### Step 4: Commit
```bash
git commit -m "type(scope): description"
```

## Output Format
```
staged: N files (+X/-Y lines)
security: passed
commit: HASH type(scope): description
pushed: yes/no
```

## Linking Commits / PRs / Branches to Issues

Associate work with the issue it resolves so GitHub builds the cross-reference trail and auto-closes on merge.

### Keywords in commit messages and PR bodies

| Intent | Keywords | Effect |
|---|---|---|
| Close the issue on merge | `Closes #N` · `Fixes #N` · `Resolves #N` (also closed/fixed/resolved) | Auto-closes #N **when the commit/PR lands on the repo's DEFAULT branch** |
| Reference without closing | `Refs #N` · `Part of #N` · bare `#N` | Creates a timeline cross-reference; issue stays open |
| Cross-repo | `owner/repo#N` (e.g. `Fixes The1Studio/StickmanForge_IdleRPG#8`) | Same, targeting another repo |

- **Default-branch rule:** closing keywords auto-close ONLY when merged into the repo's *default* branch. A `Fixes #N` merged into a non-default branch (e.g. `develop` when default is `main`) will NOT close the issue until it reaches the default branch.
- **Prefer PR-level over commit-level:** put `Fixes #N` in the PR body (`gh pr create --body $'...\n\nFixes #N'`). One closing keyword in the PR closes the issue when the PR merges.
- **Multiple issues:** repeat the full keyword — `Fixes #3, Fixes #4`. A bare list `Fixes #3, #4` closes ONLY #3.

### Branch → issue

A branch name like `8-anim-groups` does NOT auto-link to issue #8. To create a branch GitHub actually links to the issue:
```bash
gh issue develop <N> --name <branch> --base <base-branch>   # creates + links a branch to issue #N
```
or use the issue's **Create a branch** link in the Development sidebar.

### ⚠ Wiki commits do NOT link to issues

A repo's wiki is a **separate git repo** (`<repo>.wiki.git`) that lives OUTSIDE the issue/PR cross-reference graph. `Fixes #N` / `Refs #N` in a **wiki** commit message is **inert** — GitHub emits no timeline event and never auto-closes. To associate a wiki change with an issue:

1. Comment on the issue with the wiki page revision URL: `https://github.com/<owner>/<repo>/wiki/<Page>/<commit-sha>` (private-repo links require auth to open).
2. OR reference `#N` from a **main-repo** commit/PR (the only place keywords are honored) when the related code lands.

**Evidence:** StickmanForge `#8` — wiki commit `8942519` carried `Refs ...#8` in its message but produced zero cross-reference on the issue timeline (`commit_id: null` on every event); the issue had to be closed manually. (2026-06-04)

## Force-Push Safeguard

| Scenario | Action |
|----------|--------|
| `git push --force` on `main` or `master` | **BLOCKED** — warn user, refuse to execute |
| `git push --force` on any other branch | **WARNING** — ask for confirmation, suggest `--force-with-lease` |
| `git push --force-with-lease` anywhere | **ALLOWED** — safer alternative, proceed normally |

**Rule:** Never execute bare `--force` on protected branches (main, master, release/*). Always suggest `--force-with-lease` as the correct alternative — it fails if the remote was updated by someone else, preventing accidental overwrites.

Note: `secret-guard.cjs` hook already blocks credential exposure in commits. This rule extends to push safety.

## Commit TYPE in Skill/Doc Kits — Shipped `.claude/` Content Is `fix`/`feat`, NOT `docs`

In a TheOneKit kit the shipped product **is** the `.claude/` payload — skill `SKILL.md` bodies + their `references/`, agents, rules, registry fragments. Editing any of these changes **what consumers receive**, so it MUST use a **releasable** type:

| You edited… | Use |
|---|---|
| Skill body / `references/`, fixed a gotcha, corrected a pattern | `fix(<module>): …` |
| New skill, reference doc, agent, or capability | `feat(<module>): …` |
| Breaking change to a shipped skill/agent contract | `feat(<module>)!:` / `BREAKING CHANGE:` |
| `README.md`, `CONTRIBUTING.md`, `docs/**`, `plans/**`, code comments | `docs: …` (these never ship) |

**NEVER `docs(...)` for files under `.claude/`.** `docs`/`chore`/`style`/`test`/`ci` are no-bump — `parse-commits.cjs` skips them entirely, so the edit never ships and the kit silently stops releasing (`[release] No releasable commits since last tag — exiting`). The conventional-commits instinct "it's a `.md` edit → `docs:`" is **wrong here**: a skill `.md` is *product source*, not repo documentation. (The lint "diff is 100% docs-only → skip" rule earlier is about *lint-skipping*, NOT commit type.)

**Test before choosing `docs`:** does the edited file land in a consumer's `.claude/` on `t1k modules update`? Yes (path contains `/.claude/`, or it's a `SKILL.md` / agent `.md` / rule `.md`) → `fix`/`feat`. No (README/`docs/`/`plans/`) → `docs`.

**Bug trail (2026-06-08):** theonekit-unity sat unreleased after three skill-body edits committed as `docs(animation):` / `docs(tof):` (#206/#195/#208); the litmotion + tof skill improvements never reached consumers until a `fix(animation,tof):` trigger commit forced the release.

## Commit Scopes in Modular Kits — Must Map to Real Modules

TheOneKit's release pipeline (`parse-commits.cjs` in `theonekit-release-action`) triggers a per-module version bump **only** when the commit scope matches one of:

- An exact module name (e.g. `feat(t1k-base):`, `fix(dots-core):`)
- A comma-separated list of module names (e.g. `feat(dots-core,dots-combat):`)
- The kit repo name (e.g. `feat(theonekit-unity):`) — bumps all modules
- One of the kit-wide meta-scopes: `modules`, `all`, `meta`, `kit` — bumps all modules
- Unscoped `feat`/`fix`/`refactor`/`perf` — bumps all modules
- Unscoped commit with `!` or `BREAKING CHANGE` — bumps all modules (major)

**Anything else is silently dropped.** `chore`, `docs`, `style`, `test`, `ci` are always no-bump. **Skill names are NOT module names.** `fix(t1k-handoff):`, `feat(t1k-doctor):`, `fix(t1k-modules):` all produce zero affected modules → the release workflow logs `[release] No releasable commits since last tag — exiting` and publishes nothing.

**Before committing a skill-level fix to a modular kit:** check which module owns the skill (`cat .claude/modules/*/module.json | jq '{name, skills}'`) and either:
- Use the owning module name as scope: `fix(t1k-base): ...` when editing `t1k-handoff` (since `t1k-handoff` is in `t1k-base`)
- OR use a meta-scope when the fix is kit-wide: `feat(modules): ...`

**Bug trail:** `theonekit-core` main was stuck at `modules-20260417-1213` for 3 commits (2026-04-17 → 2026-04-18) because `feat(modules):` wasn't recognized (before theonekit-release-action#6). Unsticking required force-moving the `v2` tag and a subsequent core commit to trigger the fixed release pipeline.

## Contribution Scoring

After `pr` succeeds (not `cm`/`cp` — no artifact), invoke `t1k:contribution-score` with `type=sync-back-pr` + PR URL/title/body and target kit/repo. Fire-and-forget; SSOT gates non-T1K repos. See `.claude/skills/t1k-contribution-score/SKILL.md`.

## Scope

Git operations only. Never sync files containing credentials, API keys, or secrets.
