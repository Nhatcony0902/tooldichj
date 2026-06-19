---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-base
protected: true
---
# Doctor Checks Reference

## Core Checks (#1–6)

1. **Role coverage** — every role in `t1k-routing-*.json` has a matching agent `.md` file
2. **Skill existence** — every skill in `t1k-activation-*.json` has a matching skill folder in `.claude/skills/`
3. **No cross-layer hardcoding** — scan `t1k-routing-*.json` values for engine-specific strings (dots-, unity-, cocos-)
4. **Manifest integrity** — `.t1k-manifest.json` matches actually installed files
5. **Registry version compat** — all `t1k-routing-*.json` and `t1k-activation-*.json` use `registryVersion: 1`
6. **Config completeness** — every command in `t1k-config-*.json` has a matching skill folder

## Module Checks (#7–17)

Follow protocol: `skills/t1k-modules/references/module-detection-protocol.md` — skip if no `installedModules` key or no metadata.

| # | Check | Validates |
|---|---|---|
| 7 | Module file ownership | Every skill file belongs to exactly one module via `.t1k-manifest.json` (no overlap) |
| 8 | Module dependency integrity | All declared dependencies (from module.json) are installed with compatible versions |
| 9 | Activation fragment match | Each installed module has activation source (module.json or t1k-activation-*.json) |
| 10 | Module agent presence | Each module declaring agents has matching `.md` files |
| 11 | Routing overlay validity | Module overlays reference only that module's agents |
| 12 | No stale module files | No files from uninstalled modules remain (cross-check manifests) |
| 13 | SessionBaseline in required module | `sessionBaseline` skills are in required modules only |
| 14 | Keyword uniqueness | No keyword maps to skills in two different modules |
| 15 | Routing priority uniqueness | No two module overlays override same role at same priority |
| 16 | Origin frontmatter match | In-file `origin` frontmatter matches metadata entry |
| 17 | Module frontmatter presence | Files in `modules/*/` have `module:` field in frontmatter matching parent dir |

## Manifest Checks (#21)

| # | Check | Validates |
|---|---|---|
| 21 | Module manifest integrity | Each installed module has `modules/{name}/manifest.json`; listed files exist at flat locations; no orphaned flat files |

**Check #21 details:**
1. For each installed module in metadata: verify `.claude/modules/{name}/manifest.json` exists
2. For each file in manifest: verify it exists at the flattened location
3. Scan `.claude/skills/` for dirs matching `{module}-*` pattern not in any manifest → orphaned
4. Severity: WARN (pre-flattening installs won't have manifests)

## SSOT & Structure Checks (#22–27)

| # | Check | Validates |
|---|---|---|
| 22 | schemaVersion present | `metadata.json` has `schemaVersion: 3` |
| 23 | Version presence | `metadata.json` has real `version` (not `"0.0.0-source"`) and `buildDate` (not `null`) |
| 24 | No stale root modules/ | No `modules/` at repo root alongside `.claude/modules/` (canonical) |
| 25 | Context requiredPaths set | Engine kits (unity/cocos/rn) have `context.requiredPaths` in config |
| 26 | Activation format modern | All `t1k-activation-*.json` use `mappings` array, not deprecated `keywords` object |
| 27 | v3 installedModules | CLI writes `installedModules` with `kit`, `repository`, `version` per module |

## No-Override Checks (#28–29)

| # | Check | Validates |
|---|---|---|
| 28 | Filename collision detection | No two installed kits/modules have same-named agents, skills, or rules. Group files by basename + read `origin` metadata. Exception: merge targets (metadata.json, t1k-modules.json, settings.json, CLAUDE.md). |
| 29 | Agent prefix correctness | Non-core agents have proper prefix: `{kit-short}-` (kit-wide) or `{kit-short}-{module}-` (module). Core agents have no prefix. Slug part must be canonical per algorithm v2 dedup (no leading `{kit-short}-` or `{module-segment}-` redundancy). |
| 29b | Skill `name:` colon-form (planned) | Every SKILL.md `name:` field matches `lib-prefix.expectedSlashName({kit, module, slug})` colon-form. Currently INFO-only; promotes to WARN once colon-namespace migration ships per kit. |

**Check #28 details:**
1. Walk `.claude/agents/`, `.claude/skills/`, `.claude/rules/`
2. Read each file's `origin` metadata (frontmatter/`_origin`)
3. Group files by basename; if same basename with different `origin` values → ERROR: collision
4. Fix mode: suggest running CI auto-prefix or manual rename

**Check #29 details:**
1. For each agent in `.claude/agents/`, read `origin` field — derive expected kit-short
2. If origin != core: verify filename starts with `{kit-short}-`
3. If module agents: verify filename starts with `{kit-short}-{module}-`
4. Verify the canonical name matches `lib-prefix.expectedName({kit, module, slug})` — slug part MUST NOT have leading `{kit-short}-` or `{module-segment}-` redundancy (algorithm v2 dedup, since 2026-05-10). Names like `t1k-rn-rn-base-base-architecture` fail this check; the canonical form is `t1k-rn-rn-base-architecture`.

**Check #29b details (planned, deferred to colon-namespace Phase 4):**
1. For each `SKILL.md`, read frontmatter `name:` field and derive (kit, module, slug) from path.
2. Compute expected colon form via `lib-prefix.expectedSlashName({kit, module, slug})`.
3. If `name:` matches expected colon form → PASS.
4. If `name:` matches the hyphen form (`expectedName(...)`) → INFO during the migration window: "kit X has Y SKILL.md files awaiting colon-namespace migration". Single rolled-up message per kit (not per-skill noise).
5. If `name:` matches neither → WARN: "unexpected name: form `<actual>`, expected `<colon>`".
6. Agents are NOT in scope (agent `name:` stays hyphenated by design — see `t1k-agent-creator/references/architecture-rules.md` §0.2).
7. Implementation status: helper `expectedSlashName` shipped in release-action 2026-05-10. Doctor script wiring deferred until colon-namespace Phase 4 begins (post-dedup-soak). Plan: `theonekit-core/plans/260510-1711-skill-name-colon-namespace/`.

## Frontmatter Quality Checks (#18–20)

| # | Check | Validates |
|---|---|---|
| 18 | Agent maxTurns presence | Every agent `.md` has `maxTurns:` in frontmatter |
| 19 | Skill effort presence | Every skill `SKILL.md` has `effort:` in frontmatter (low/medium/high) |
| 20 | Agent model appropriateness | Implementer/t1k-debugger agents should use `inherit` or `opus`; utility agents (git, docs) should use `sonnet` |
| 51 | Agent budget calibration | Per `rules/agent-completion-discipline.md`: budget checkpoints must be window-relative, not flat tokens; tool-heavy agents must carry one; `maxTurns` sized to task class |

**Check #51 details (`scripts/check-agent-budget-calibration.cjs`):**

Scans every `.claude/agents/*.md`. An agent is "tool-heavy" when its `tools:` frontmatter includes `Bash`, `Task`, or `Agent` (it can mutate or orchestrate). Flags, at WARN level (exit 0 always):

| Sub-check | Trigger | Fix |
|---|---|---|
| (a) Flat-token checkpoint | Body contains a literal token threshold (`150K` / `150,000` / `200K`) with no window-relative anchoring | Make it relative to the agent's `model:` window (~75%@200K / ~55%@1M) |
| (b) Missing checkpoint | Tool-heavy agent body has no budget/checkpoint language at all | Add the window-relative + ~80%-`maxTurns` checkpoint |
| (c) Under-sized maxTurns | Tool-heavy agent with `maxTurns < 50` | Size to task class — multi-PR/refactor/MCP-validation work hits the turn cap before tokens (#528: `t1k-kit-developer` 45→90) |

Window-relative anchoring is recognized by phrases like `window-relative`, `% of … window`, `relative to … budget`, `maxTurns`, or a citation of `agent-completion-discipline`. Read-only discovery agents (no `Bash`/`Task`/`Agent`) are exempt from (b) and (c). SSOT for the policy: `rules/agent-completion-discipline.md`. Resolves core#530 (fleet calibration); motivated by core#528.

## Cross-Platform Checks (#30)

| # | Check | Validates |
|---|---|---|
| 30 | Hook cross-platform compliance | All `.cjs` files in `.claude/hooks/` are free of shell-only patterns |

**Check #30 details:**

Scan all `.cjs` files in `.claude/hooks/` for these violations:

| Pattern | Why It Fails | Fix |
|---------|-------------|-----|
| `2>/dev/null` in command strings | Shell redirect, not cross-platform | Use `stdio: ['pipe', 'pipe', 'ignore']` |
| `2>&1` in command strings | Shell redirect, not cross-platform | Capture both stdout/stderr via `stdio: ['pipe', 'pipe', 'pipe']` |
| `/dev/stdin` | Linux-only, breaks Windows | Use `fs.readFileSync(0, 'utf8')` |
| `/dev/null` (outside comments) | Unix-only | Use `stdio` option or `os.devNull` |
| `execSync('cmd arg')` (shell string) | Spawns shell, injection risk | Use `execFileSync('cmd', ['arg'])` |
| Hardcoded `/tmp/` | Unix-only temp path | Use `os.tmpdir()` |
| Hardcoded `/home/` or `/Users/` (in logic, not regex) | Platform-specific | Use `os.homedir()` or `process.env.HOME \|\| process.env.USERPROFILE` |

**Implementation:**
1. Read each `.cjs` file, strip comment lines (`//` and `/* */`)
2. Regex-match against violation patterns
3. Report file:line for each violation
4. Severity: WARN (hooks still work on Linux/macOS, just break on Windows)

**Fix mode:** Cannot auto-fix — requires manual code changes. Report violations with suggested replacement.

## Sync-back Health Checks (#32)

| # | Check | Validates |
|---|---|---|
| 32 | Sync-back PR health | Recent `/t1k:sync-back` PRs are healthy — no CONFLICTING state and no phantom-file (all-additions) diffs |

**Check #32 details:**

Validates that the `/t1k:sync-back` skill is producing healthy PRs. Added after the 2026-04-09 incident where two sync-back PRs were unusable: core#7 was stale (no upstream fetch → CONFLICTING), unity#7 targeted a non-existent path (missing `.claude/` prefix → phantom file at wrong location).

1. Collect all kit repos from `.claude/t1k-config-*.json` → `repos.primary` and from in-file `repository` frontmatter across changed files
2. For each repo (up to 10 distinct repos to bound runtime), query the last 5 PRs with sync-back branch prefix:
   ```
   gh pr list --repo {owner}/{repo} --search "head:t1k-sync/" --state all --limit 5 --json number,title,state,mergeStateStatus,headRefName,additions,deletions,files
   ```
3. For each returned PR, check two signatures:
   - **Staleness signature** — `mergeStateStatus == "CONFLICTING"` while the PR is still `OPEN` → WARN: stale sync-back PR (fix: the skill pushed without fetching upstream)
   - **Phantom-file signature** — any file in the PR has `additions > 0` AND `deletions == 0` AND the filename matches a skill/agent/rule basename that exists elsewhere in the repo → WARN: likely path-resolution bug (fix: verify `.claude/` prefix for modular kits)
4. Report counts: `Sync-back health: {healthy}/{checked} PRs healthy across {N} repos`
5. List problem PRs with URL and signature

**Severity:** WARN (advisory — doesn't fail doctor, just flags drift)

**Skip conditions (fail-open, never block):**
- `gh` CLI not available → skip with note
- `gh auth status` not authenticated → skip with note
- No kit repos resolvable from configs → skip
- Network error during PR query → skip with note

**Fix mode:** Cannot auto-fix — each problem PR needs manual review. For each flagged PR:
- Stale → close and re-run `/t1k:sync-back` (v1.2.0+ has staleness check)
- Phantom-file → close and re-run `/t1k:sync-back` (v1.2.0+ has `.claude/` prefix + path verification)
- Suggest: `gh pr close {number} --comment "Superseded by healthy resync"`

**Why this check exists:** The acceptance criteria for The1Studio/theonekit-core#8 require a doctor check or test that detects these two failure modes in historical PRs. Running this check after releasing a sync-back fix is a cheap smoke-test to confirm no broken PRs slipped through.

## Kits Membership SSOT Checks (#33)

| # | Check | Validates |
|---|---|---|
| 33 | Kits membership SSOT | Asserts `Object.keys(metadata.kits) === unique(installedModules[*].kit)` — catches drift between the derived kit membership and the source `installedModules`. WARN level on mismatch. |

**Check #33 details:**

Runs `scripts/check-kits-membership.cjs` (ships with this skill) against `.claude/metadata.json`. The script:

1. Loads the kit registry from `references/available-kits.json` (shared SSOT that mirrors `AVAILABLE_KITS` in `theonekit-cli/src/types/kit.ts`).
2. Resolves each `installedModules[*].kit` value to a `KitType` via the registry (`theonekit-unity` → `unity`, bare `unity` accepted as tolerance).
3. Compares `Object.keys(metadata.kits)` against the unique set of resolved owners.
4. Reports three drift categories:
   - **missing** — owners present in `installedModules` but missing from `kits`
   - **orphaned** — kit entries with no owning module in `installedModules`
   - **unresolved** — `installedModules` entries whose `kit` field does not resolve (dropped from the rebuild with a warning in CLI; surfaced here for visibility)
5. Prints `PASS` when all three are empty; otherwise `WARN` with details.

**Skip conditions:**
- `metadata.json` not found → SKIP
- No `installedModules` and not a v3 metadata file → SKIP (check only meaningful for v3 module-first metadata)

**Severity:** WARN (migration grace — doesn't fail doctor, just flags drift). Fix: run `t1k modules add ...` or `t1k modules remove ...` — the CLI rebuilds membership via `rebuildKitMembership` in `theonekit-cli/src/domains/modules/kit-membership.ts`.

**Why this check exists:** Prevents regression of the Zod `Unrecognized key` crash where unresolved kit values were bucketed under a synthetic `"unknown"` key, bricking `writeManifest` on the next `t1k` invocation. See `rebuildKitMembership` docstring for the derivation formula and SSOT rationale.

## Orphaned Agent Checks (#34)

| # | Check | Validates |
|---|---|---|
| 34 | Orphaned agents | Agent files in `.claude/agents/` whose `origin:` frontmatter points to a kit that is NOT in `installedModules[*].kit` (v3) or `metadata.kits` (older schemas). WARN level. |

**Check #34 details:**

Runs `scripts/check-orphaned-agents.cjs` against `.claude/metadata.json` and `.claude/agents/`. The script:

1. Loads the kit registry from `references/available-kits.json`.
2. Builds the set of installed kits from `installedModules[*].kit` (v3) unioned with `Object.keys(metadata.kits)` (older schemas). Accepts both short (`unity`) and long (`theonekit-unity`) keys.
3. Walks `.claude/agents/*.md`, parses the YAML frontmatter, and reads the `origin` field.
4. Reports agents whose `origin` does NOT resolve to any installed kit.

**Why this check exists:** `t1k uninstall --kit X` relies on the kit's `.t1k-manifest.json` to know which files to delete. Agents installed before per-module manifests (pre-v1.64.0) were never added to the manifest, so the ownership-aware uninstall skips them. The orphaned agent files stay on disk with `origin: theonekit-X` frontmatter even though kit X is uninstalled — they continue loading into every session, bloating context and potentially activating for tasks that no longer match the active toolchain.

**Skip conditions:**
- `metadata.json` not found → SKIP
- Both `installedModules` empty AND `kits` empty → SKIP
- `agents/` directory missing → SKIP

**Severity:** WARN (migration grace — doesn't fail doctor, just flags leftovers). Fix: upgrade CLI to v3.5+ and run `t1k uninstall --kit <name> --include-orphans`, or manually `rm .claude/agents/<file>` for each orphan.

**Related work:** Report the CLI gap via `/t1k:issue` against `The1Studio/theonekit-cli` so `t1k uninstall` gains a frontmatter-based fallback for pre-manifest installs.

## Context Window Hygiene (#35–#36)

| # | Check | Validates |
|---|---|---|
| 35 | CLAUDE.md bloat | Project `CLAUDE.md` ≤ 5000 tokens (char/4 heuristic). WARN. |
| 36 | Rule duplication | No rule filename present in both `~/.claude/rules/` and project `.claude/rules/`. INFO. |

**Check #35 details:**

Runs `scripts/check-claude-md-bloat.cjs`. Reads project `CLAUDE.md`, estimates tokens via `chars / 4`, compares against a 5000-token budget. When over, reports the overshoot and suggests moving details to `docs/` and deduplicating with `.claude/rules/` files.

**Why this check exists:** Every session loads `CLAUDE.md` in full. A bloated CLAUDE.md (>5k tokens) usually duplicates content that belongs in `.claude/rules/` (auto-loaded, so duplicating wastes context) or in `docs/` (searchable on demand). Example: an 11.9k-token CLAUDE.md was reduced to 2k tokens just by moving gate backlogs, hook implementation details, and origin-metadata tables to `docs/`.

**Severity:** WARN (doesn't fail doctor, just flags bloat).

**Check #36 details:**

Runs `scripts/check-rule-duplication.cjs`. Enumerates `*.md` files in `~/.claude/rules/` and `<project>/.claude/rules/`, compares by basename. Reports files present in both — those are double-loaded every session.

**Why this check exists:** Claude Code auto-loads rule files from BOTH the global `~/.claude/rules/` and the project `.claude/rules/` every session. When a kit ships rules at both scopes (common for core-overlapping rules like `code-conventions.md`, `coding-guidelines.md`), the content loads twice — roughly doubling its context cost. Keep shared patterns in one scope only.

**Severity:** INFO (advisory — doesn't fail doctor; some projects intentionally version-lock project-scope rules).

**Skip conditions:**
- Project rules/ resolves to the global rules/ (e.g., running inside `~/.claude/`): SKIP
- Either dir missing or empty: SKIP
## Adapter Contract Checks (#37)

| # | Check | Validates |
|---|---|---|
| 37 | Adapter contract | Every discovered adapter skill has valid `t1k-adapter` frontmatter, required scripts, and a conformant `install.json` |

**Check #37 details:**

Runs `hooks/doctor-check-37-adapter-contract.cjs` against the current `.claude/` dir:

1. Calls `listAllMatches()` from `skills/t1k-preview/scripts/adapter-discovery.cjs` (Steps 1–4: metadata read + frontmatter + schema validation only — no `detect.cjs` run, no side-effects).
2. For each discovered adapter:
   - Verifies all four required scripts exist in the skill dir: `detect.cjs`, `list-capabilities.cjs`, `generate.cjs`, `requirements.cjs`.
   - Verifies `install.json` is present, parses as valid JSON, and has a `schemaVersion` field and a non-empty `catalog`.
3. Exits 0 with `PASS` when no adapters are installed (nothing to validate).
4. Exits 0 with `PASS` when all adapters conform; exits 1 with per-adapter details on `FAIL`.

**Severity:** FAIL (exits 1) if any required script or `install.json` is missing; WARN for schema-level issues (empty catalog, missing schemaVersion).

**Skip conditions:**
- `adapter-discovery.cjs` not found (t1k-extended not installed) → FAIL with actionable message
- Zero adapters discovered → PASS silently

**Why this check exists:** Ensures kit authors cannot ship a broken adapter that crashes `t1k diagram refresh` mid-run. Catching missing `generate.cjs` or an empty `install.json` at doctor-time is cheaper than debugging a partial refresh at runtime.

**Inheritance-aware behavior:** When `metadata.json` contains `inheritsFrom` pointing at the global `.claude/`, filename duplicates are treated as INTENTIONAL overrides (child wins) and are NOT reported. Byte-identical copies are still reported regardless — those remain accidental. If `inheritsFrom` is set but the parent path is missing, the check exits non-zero with ERROR (see check #37).

## Inheritance Integrity Check (#37)

| # | Check | Validates |
|---|---|---|
| 37 | inheritsFrom integrity | When `metadata.json` contains `inheritsFrom`, validates the field value is a well-formed parent `.claude/` path. ERROR severity. |

**Check #37 details:**

Runs `scripts/check-inherits-from.cjs`. If the `inheritsFrom` field is absent from `metadata.json`, the check SKIPs (no-op for existing installs). If present, all conditions below are validated at ERROR severity (fail-loud, never silent):

1. **(a) Path exists** — `fs.existsSync(inheritsFrom)` must be true → ERROR: parent path missing. Remediation: remove the field OR re-create the parent `.claude/`.
2. **(b) Path is a directory** — `fs.statSync(inheritsFrom).isDirectory()` must be true → ERROR: not a directory.
3. **(c) Ends in `.claude`** — `path.basename(inheritsFrom) === '.claude'` must be true → ERROR: must end in `.claude` (not `.claude/metadata.json`).
4. **(d) Has metadata.json** — `fs.existsSync(path.join(inheritsFrom, 'metadata.json'))` must be true → ERROR: parent is not a T1K install.
5. **(e) Parent is T1K-shape** — `isT1KMetadata(parentMeta) === true` must hold → ERROR: not valid T1K metadata (CK stub?).
6. **(f) No self-reference** — `path.resolve(inheritsFrom) !== path.resolve(<project>/.claude)` must hold → ERROR: inheritsFrom points at self.
7. **(g) No cycle (≤5 hops)** — following `parent.metadata.inheritsFrom` recursively must terminate within 5 hops → ERROR: inheritance cycle detected at `<node>`.

**Severity:** ERROR. The field is opt-in — if you set it, it must be valid. Matches `development-principles.md` "Errors Over Silent Fallbacks".

**Skip condition:** `inheritsFrom` absent from `metadata.json` → SKIP (exit 0). No metadata.json → SKIP.

**Why this check exists:** Ensures that when `inheritsFrom` is set (e.g., by `t1k init --inherit-from`), the parent path remains valid across directory moves and renames. A stale pointer is detected at next `/t1k:doctor` run rather than silently degrading rule loading.

**References:**
- Script: `scripts/check-inherits-from.cjs`
- Tests: `.claude/hooks/__tests__/check-inherits-from.test.cjs` (scenarios T5–T11)
- Schema: `docs/registry-schema.md` (metadata v3 `inheritsFrom` field)
- Docs: `docs/global-only-mode.md` §Nested installs

## MCP Health Checks (#31)

| # | Check | Validates |
|---|---|---|
| 31 | MCP server connectivity | All required MCPs are connected; recommended MCPs present |

**Check #31 details:**

1. Read ALL `t1k-config-*.json` → collect `mcp.required` and `mcp.recommended` entries (additive across kits)
2. Deduplicate by `name` (higher-priority config wins on conflict)
3. Run `claude mcp list` to get connected servers
4. Also check `~/.claude/mcp.json` and `.mcp.json` for registered servers
5. For each **required** MCP not connected:
   - Output: `ERROR: Required MCP "{name}" not connected — {purpose}`
   - Suggest: `Fix: {installCmd}`
6. For each **recommended** MCP not connected:
   - Output: `WARN: Recommended MCP "{name}" not connected — {purpose}`
7. If entry has `verifyTool` field:
   - Check if deferred tools with that prefix exist via `ToolSearch`
   - If MCP is registered but no tools found: `WARN: MCP "{name}" registered but not functional (may need auth)`
8. Summary line: `MCP health: {N}/{total} required connected, {M} recommended missing`

**Severity:**
- Missing required: ERROR (fails doctor check)
- Missing recommended: WARN (advisory)
- Registered but not functional: WARN (advisory)

**Fix mode:**
- For each missing MCP with `installCmd`: run the install command via `claude mcp add ... -s user`
- After install: verify with `claude mcp get {name}`
- If `verifyTool` exists: verify deferred tools are available
- Suggest `! claude mcp auth {name}` if MCP needs authentication

### Frontmatter Check Output
```
### Frontmatter Quality
- Agent maxTurns: [PASS | WARN — N agents missing maxTurns: {list}]
- Skill effort: [PASS | WARN — N skills missing effort: {list}]
- Agent model: [PASS | WARN — {agent} uses {model} but role suggests {recommended}]
```

## Module Detect Coverage (#41)

| # | Check | Validates |
|---|---|---|
| 41 | Module detect coverage | Every non-base module in `.claude/modules/` has either `detect:` or `detect._optOut: true`; WARN pre-ratchet, ERROR post-ratchet |

**Check #41 details:**

Runs `.claude/skills/t1k-doctor/scripts/check-module-detect-coverage.cjs`. Iterates `.claude/modules/*/module.json` and reports modules that:
- are NOT in `CORE_REQUIRED = ["t1k-base", "t1k-extended", "t1k-maintainer"]`
- are NOT `required: true` (kit-base opt-out)
- lack an active `detect:` block, or have `_disabled: true` (stub modules are surfaced as "needs activation")

**Ratchet (data-driven):** reads `.claude/t1k-modules.json.ratchetDates."module-detect-coverage"` (ISO date). Before that date: `WARN`. After: `ERROR` (exit 1). Env bypass: `T1K_BYPASS_DETECT_RATCHET=1` forces `WARN` regardless. This matches the plan's P6e rollback design (editable ratchet + env escape hatch).

**Severity:** WARN pre-ratchet, ERROR post-ratchet (or WARN if bypass env set).

**Why this check exists:** Ships alongside the P0 `detect:` schema so kit authors cannot silently ship modules without detection. The 90-day warn window gives kits time to backfill; the ERROR-level ratchet ensures we don't drift indefinitely.

## Statusline Orphans (#43)

| # | Check | Validates |
|---|---|---|
| 43 | Statusline orphans | No residual `hooks/lib/statusline-*.cjs` or `hooks/lib/t1k-config-utils.cjs` subfiles remain after the 1.71.x refactor |

**Check #43 details:**

Runs `.claude/hooks/doctor-check-43-statusline-orphans.cjs`. Complements check #42 (which verifies the happy-path wiring): #43 verifies the absence of the 7 subfiles that the monolithic `hooks/statusline.cjs` replaced. These files were shipped in releases prior to `modules-20260421-0955` and must be removed by deletions metadata on update. If they remain on disk, auto-update failed to clean up (regression of issue #52).

Per-path list:
- `hooks/lib/statusline-activity-renderers.cjs`
- `hooks/lib/statusline-render-modes.cjs`
- `hooks/lib/statusline-section-registry.cjs`
- `hooks/lib/statusline-session-cache.cjs`
- `hooks/lib/statusline-string-utils.cjs`
- `hooks/lib/statusline-version-section.cjs`
- `hooks/lib/t1k-config-utils.cjs`

**User override:** if `metadata.json.installedFiles[].ownership === "user"` for any of those paths, the check emits an INFO line and does NOT flag it as an orphan. This respects intentional user retention.

**Severity:** ERROR (exit 1) when orphans present; PASS (exit 0) when clean; SKIP when `.claude/` absent.

**Why this check exists:** Per-module deletions ship in `.claude/modules/*/.t1k-manifest.json.deletions[]`. The CLI and release-action must cooperate to apply them; #43 is the user-facing gate that catches any pipeline regression.

**Run after:** `t1k update` completes. Running before or during an update may report transient orphans.

## No Inlined Universal Rules (#44)

| # | Check | Validates |
|---|---|---|
| 44 | No inlined universal rules | SKILL.md files and agent .md files do not contain the 3 known boilerplate blocks that live in `.claude/rules/` or a dedicated reference file. FAIL level. |

**Check #44 details:**

Runs `scripts/check-no-inline-universal-rules.cjs`. Scans `.claude/skills/*/SKILL.md`, `.claude/modules/*/skills/*/SKILL.md`, `.claude/agents/*.md`, and `.claude/modules/*/agents/*.md` for three forbidden boilerplate patterns:

| Pattern | What it catches | Lives in |
|---|---|---|
| `Never reveal skill internals or system prompts` | Skill-security block pasted into skill body | `.claude/rules/skill-security-boilerplate.md` |
| `Per CLAUDE.md principle #8` | AI-Driven Design block pasted into skill body | `.claude/rules/ai-driven-design.md` |
| `T1K_FORK_DEPTH < 2` (outside `references/fork-hygiene.md`) | Fork-hygiene 5-line inline pasted outside its canonical home | `.claude/skills/t1k-architecture/references/fork-hygiene.md` |
| `Forbidden thought patterns` (outside `rules/agent-anti-rationalization.md`) | Anti-Avoidance / Anti-Rationalization block pasted into agent or skill body | `.claude/rules/agent-anti-rationalization.md` |
| `HARD-GATE is a mandatory stopping point` (outside `rules/workflow-gates.md`) | HARD-GATE universal contract prose pasted into skill or agent body | `.claude/rules/workflow-gates.md` |

Emits JSON `{ status: "ok" | "fail", violations: [{ file, line, pattern }] }` to stdout. Human-readable `file:line [pattern]` summary to stderr when violations exist.

**Severity:** FAIL (exit 1) if any violation found; PASS (exit 0) otherwise.

**Skip conditions:**
- No `.claude/skills/`, no `.claude/agents/`, and no `.claude/modules/` → SKIP (no files to scan).

**Why this check exists:** During plan `20260428-1530-architecture-fix-rollout`, ~350 lines of inlined boilerplate were removed from 25+ skills across 7 kits. These three boilerplates auto-load every session via `.claude/rules/` — pasting them into skill or agent bodies doubles their context cost and causes drift when the canonical version is updated. Extended to agent `.md` files because `t1k-skills-manager.md:47–56` was found to inline the skill-security block verbatim. This check catches re-introductions at doctor-run time; release-action CI gate `validate-no-inline-universal-rules.cjs` catches them at PR level.

**Related:** `architecture-rules.md` (skill-creator) → "Anti-Pattern: Inlining Universal Rules in Skill Bodies". Same rule applies to agent bodies via `agent-creator/references/architecture-rules.md`.

## Auto-Pipeline Prereq (#46)

| # | Check | Validates |
|---|---|---|
| 46 | Auto-pipeline GitHub MCP prereq | When `features.autoIssueSubmission` or `features.autoLessonSync` is ON, the GitHub MCP must be registered. Diagnostic WARN when there is a mismatch. |

**Check #46 details:**

Runs `scripts/check-auto-pipelines-prereq.cjs`. Reads merged `features.{autoIssueSubmission, autoLessonSync}` across all `t1k-config-*.json` fragments (later fragments win). When at least one is `true`, probes `claude mcp list` and looks for a `github` entry. The two auto-pipelines spawn background sub-agents that call `mcp__github__*` tools (issue creation, PR creation); without the MCP the marker queues silently and submissions fail without a visible error.

Output: JSON `{ status: "pass" | "skip" | "warn", enabled: {...}, githubMcpPresent: bool|null, reason: string }` to stdout; WARN summary to stderr when a mismatch is detected.

**Severity:** WARN (advisory; never blocks doctor). Exit code is always 0.

**Skip conditions:**
- Both flags OFF → PASS with `reason: auto-pipelines disabled — GH MCP prereq not applicable`
- `claude` CLI unavailable → SKIP (cannot probe MCP state)

**Fix mode:** Run `claude mcp add github` (per `t1k-config-core.json` → `mcp.required[github].installCmd`). If the MCP is registered but unauthenticated, run `claude mcp auth github`. This check complements #31 (which already errors on missing required MCPs); #46 is the diagnostic version that ties the consequence to the enabled-pipeline flags.

**Output fields (when pipelines enabled):** `pendingLessonUpdates` (count of unsubmitted entries in `pending-skill-updates.jsonl`) and `pendingIssueSubmissions` (from `pending-issue-submissions.jsonl`). Non-zero counts surface as part of the `reason` string (e.g., `"GitHub MCP present; 3 lesson updates pending"`). A value of `-1` means the file could not be read (unknown). **Fix mode for pending counts:** no automated fix — wait for the next session trigger or manually invoke the appropriate background sub-agent (`/t1k:issue` or `/t1k:sync-back`).

**Why this check exists:** Both pipelines were flipped ON by default in `t1k-config-core.json` on 2026-05-06 (calibrated for TheOneKit's ~50-user internal scope). Consumers without the GitHub MCP would see queue entries pile up in `.claude/telemetry/pending-issue-submissions.jsonl` / `pending-skill-updates.jsonl` with no submissions and no failure surface. The check makes the silent-fail mode visible at doctor-run time.

**Related:** `docs/auto-issue-collection.md` (issue pipeline contract), `.claude/rules/telemetry.md` (lesson-sync contract), `docs/auto-issue-pipeline.md` (setup + troubleshooting guide).

## Project Module Fitness (#40)

| # | Check | Validates |
|---|---|---|
| 40 | Project module fitness | Shells `t1k modules detect --json --cache-only`; WARN when confident install/recover recommendations exist |

**Check #40 details:**

Runs `.claude/hooks/doctor-check-40-project-module-fitness.cjs`. The hook is cache-only — it never triggers a cold scan (cold scans can exceed 10s on monorepos and would block every doctor run). The CLI owns TTL/staleness; if the cache is missing or stale, the hook SKIPs with a hint to run `/t1k:modules detect`.

1. Skip if `resolveProjectDir()` reports global-only mode.
2. Skip if `t1k` CLI is absent from PATH.
3. Skip if `.claude/session-state/detect-cache.json` is missing.
4. Spawn `t1k modules detect --json --cache-only` with a 5s timeout (`shell: false`).
5. Skip if CLI reports `{mode: "cache-empty"}` or non-zero exit.
6. Parse JSON; WARN when `confident.install.length > 0 || confident.recover.length > 0` and list module names.
7. **Ignore `ambiguous[]` and `unused-suspect[]`** — those require AI review (skill P7), not doctor.

**Severity:** WARN (advisory — never blocks).

**Why this check exists:** Surfaces project-module fitness drift (e.g., `IComponentData` present in Assets but `dots-ecs-core` not installed) so consumers notice before bugs accumulate. Doctor stays deterministic; ambiguous evidence is deferred to the interactive `/t1k:modules` flow.

## Activation Skill Resolution (#47)

| # | Check | Validates |
|---|---|---|
| 47 | Activation skill resolution | Every skill ref in every `t1k-activation-*.json` `sessionBaseline[]` and `mappings[].skills[]` array resolves to a real skill directory |

**Check #47 details:**

Wraps the release-action gate `validate-activation-skill-resolution.cjs` (added 2026-05-11 alongside the PR #76 self-heal). Walks fragments at three locations:

1. Kit-level fragments under `.claude/` matching glob `t1k-activation-*.json`
2. Module-level fragments under `.claude/modules/<m>/` matching the same glob
3. Dual-tree fragments under `modules/<m>/` (web/marketing layout) matching the same glob

For every ref in `sessionBaseline[]` and `mappings[].skills[]`, accepts BOTH:

- **Full-prefixed form** — exact match against canonical skill dir basename (`t1k-nakama-rpc`).
- **Bare-slug form** — match against any of the four `stripPrefix` variants the prefixer's `auto-prefix-skills.cjs::buildSelfHealMap()` accepts:
  - kit + module strip → `script-graph` (from `t1k-rn-rn-base-script-graph`)
  - kit-only strip → `rn-base-script-graph`
  - module-only strip → `rn-rn-base-script-graph`
  - `t1k-` only strip → `rn-rn-base-script-graph`

When a ref doesn't resolve, surfaces a "did you mean" hint listing the closest canonical dir names by Levenshtein distance.

**Severity:** WARN locally (doctor advisory). The release-action gate is the strict enforcer at PR time — it's wired in WARN mode (`continue-on-error: true`) during the introduction soak, ratcheting to ERROR after per-kit cleanup PRs land for the legacy `{kit}-{slug-without-module}` form (e.g., `rn-script-graph` skipping the `rn-base` module segment).

**Skip conditions:**
- No `.claude/` directory → SKIP
- No skill dirs found → SKIP
- No activation fragments → SKIP
- Fragment paths under `/fixtures/`, `/__fixtures__/`, `/test-fixtures/` → SKIP

**Fix mode:** Cannot auto-fix — the right rewrite depends on intent (use canonical dir name, or one of the four self-heal-accepted bare forms). Doctor reports the violations and the recommended fix.

**Why this check exists:** PR #76's auto-prefix-skills self-heal handles only the documented `stripPrefix` accept-set. The legacy `{kit}-{slug}` form (skipping the module segment) is real but NOT in the self-heal set — so refs in that form survived the 2026-05-08 universal-prefix migration AND the 2026-05-11 self-heal. Surfacing them at PR time + doctor time pushes the cleanup forward instead of letting drift accumulate. See release-action PR #77 for the gate introduction.

**Related:** Check #2 (skill existence — orthogonal: validates the inverse, that activation refs aren't pointing at nothing). The activation-coverage check (release-action `validate-activation-coverage.cjs`) validates the OTHER inverse: skills that exist but have no activation ref.

## Global Install Core-Only (#48)

| # | Check | Validates |
|---|---|---|
| 48 | Global install core-only | `$HOME/.claude/metadata.json` `.kits` should contain ONLY `core`. Non-core kits installed globally trigger a WARN. |

**Check #48 details:**

Reads `$HOME/.claude/metadata.json` (regardless of CWD — the check is about the GLOBAL install state, not the current project) and enumerates `.kits.*` keys. Any key that is NOT `core` (e.g., `unity`, `designer`, `cocos`, `react-native`, `web`, `nakama`) emits a WARN line with the kit name, installed version, and the recommended `t1k uninstall --global --kit <name>` command.

**Why this check exists:**

- Global = always-on essentials; only `theonekit-core` has the universal registry/rules/hooks/skills that every session needs.
- Per-project = engine/domain-specific. Unity skills are only useful when working on a Unity project; loading them globally surfaces irrelevant activation candidates in every session.
- Real incident (2026-05-11): a user's `$HOME/.claude/` accumulated 162 unprefixed Unity skills as orphans because Unity was installed globally but never updated cleanly. The orphan skills then showed up in unrelated projects, polluted keyword activation, and bloated SessionStart hook scans.

**Severity:** WARN — this is a recommendation, not a violation. Does not block CI. Users with a deliberate global engine-kit install (rare; usually a mistake) can ignore.

**Skip conditions:**
- No `$HOME/.claude/metadata.json` (T1K not installed globally) → SKIP
- `metadata.json` unparseable → SKIP with error message
- No `.kits` key in metadata → SKIP

**Fix mode:** Cannot auto-uninstall (destructive — affects user's global install). Doctor reports the offending kits + the exact CLI command to remove each.

**Related:** Check #34 (orphaned agents — related symptom: stale-install drift in global). The corrective workflow is: (1) `t1k uninstall --global --kit <name>` for each non-core kit, (2) install the engine kit per-project in projects that actually use it.

## Multimodal Setup (#49)

| # | Check | Validates |
|---|---|---|
| 49 | Multimodal setup | When `t1k-extended` module is installed AND `skills/t1k-extended-multimodal/SKILL.md` is present: GEMINI_API_KEY set, MINIMAX_API_KEY set (optional), python3 ≥ 3.10 available, `github:The1Studio/human-mcp#v2.15.1` resolvable |

**Check #49 details:**

Runs `.claude/hooks/doctor-check-49-multimodal-setup.cjs`. Two-part install guard:
1. `installedModules['t1k-extended']` must exist in `metadata.json` (keys are module names, NOT skill names).
2. `.claude/skills/t1k-extended-multimodal/SKILL.md` must exist on disk (secondary guard for partial installs).

When both pass, runs four sub-checks:

| Sub-check | Severity | Detail |
|---|---|---|
| GEMINI_API_KEY env var | WARN | Required for Gemini image/video generation and analysis |
| MINIMAX_API_KEY env var | WARN | Optional — required only for MiniMax speech/music generation |
| python3 ≥ 3.10 | FAIL (exit 1) | Required for all multimodal Python scripts |
| `github:The1Studio/human-mcp#v2.15.1` resolvable | WARN | Uses `npm view @goonnguyen/human-mcp@2.15.1` as upstream freshness signal (metadata-only, no code execution); install hint points to fork |

**Status set:** `SKIP | OK | WARN | FAIL`. `FAIL` is also used by the top-level fail-open catch block (internal exceptions — never silently dropped).

**Exit codes:**
- `0` — SKIP, OK, WARN, or internal error (fail-open)
- `1` — FAIL (python3 missing or too old; check 3 only)

**Skip conditions:**
- No `.claude/` directory resolvable → SKIP
- `metadata.json` not readable (new install, no modules yet) → SKIP
- `t1k-extended` not in `installedModules` → SKIP
- `skills/t1k-extended-multimodal/SKILL.md` absent on disk → SKIP

**Phase 10 support:** Honors `T1K_METADATA_PATH` env override so smoke-test fixtures can inject an arbitrary `metadata.json` path without touching real disk state.

**Supply-chain safety:** Uses `npm view ... version --json` for MCP resolvability — metadata-only, no `npx --yes` code execution.

**Why this check exists:** The multimodal skill (`t1k-extended-multimodal`) requires Python 3.10+, an API key for Gemini, and the optional `human-mcp` server. Without this check, users who install the skill would see silent failures at runtime (Python version too old, missing API keys) with no diagnostic surface. Check #49 is the consumer-facing gate that surfaces these setup issues at doctor-run time before any multimodal operation is attempted.

## Stale-Backup Folders Inside Auto-Scanned Dirs (#50)

| # | Check | Validates |
|---|---|---|
| 50 | Stale-backup folders inside auto-scanned dirs | No quarantine subdirectory (`.stale-backup-*`, `.zombies-*`, `.backup-*`, `.archive-*`, `.old`, `.deprecated`, `.trash`) exists inside `agents/`, `skills/`, `rules/`, `hooks/`, or `commands/` under either global `~/.claude/` or project `.claude/`. |

**Check #50 details:**

Runs `scripts/check-stale-backup-folders.cjs`. Walks each of the 5 auto-scanned folders (`agents/`, `skills/`, `rules/`, `hooks/`, `commands/`) under BOTH `~/.claude/` (global) and the project's `.claude/` (local). Any direct child directory whose name matches one of the quarantine patterns emits a WARN line with the full path, file count, and the exact `mv` (move out) and `rm -rf` (delete) commands to remediate.

**Quarantine patterns detected:**
- `.stale-backup` / `.stale-backup-{YYMMDD}`
- `.zombies` / `.zombie-*`
- `.backup` / `.backup-*`
- `.archive` / `.archive-*`
- `.old` / `.old-*`
- `.deprecated` / `.deprecated-*`
- `.trash` / `.trash-*`

**Why this check exists:**

Real incident (2026-05-28): the `/agents` UI displayed 6 `t1k-model-router-mr-*` agents that the kit source had removed. Investigation showed they lived in `~/.claude/agents/.stale-backup-260526/` — moved there 2 days earlier by a consumer-side cleanup following the `naming-convention.md` rule's "Move to `.stale-backup-{YYMMDD}/` subdir" advice. **Claude Code's `/agents` UI and skill discovery walk dot-prefixed subdirectories.** Files inside surface as live registrations regardless of the parent dir's hidden status. The "hide them with a dot prefix" assumption is wrong.

**Severity:** WARN — informational. Does not block CI; fix-mode does not auto-remediate (destructive — affects user files).

**Fix paths:**
1. **Move out of the auto-scanned folder:** `mv ~/.claude/agents/.stale-backup-260526 ~/.claude/.stale-backup-260526` — keeps a rollback safety net under `~/.claude/` (one level up) where nothing scans.
2. **Delete after verification:** `rm -rf ~/.claude/agents/.stale-backup-260526` — permanent. Use once you're sure no rollback is needed.

**Related:**
- `rules/naming-convention.md` § Violation handling — canonical guidance amended 2026-05-28 to forbid the in-folder quarantine pattern.
- Check #34 (orphaned agents) — related symptom, different cause (frontmatter `origin:` mismatch vs. quarantine-folder leak).

**Skip conditions:** None — runs unconditionally; harmless when the directories don't exist (silent PASS).
