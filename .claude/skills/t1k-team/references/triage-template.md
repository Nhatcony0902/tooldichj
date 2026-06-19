---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Triage Template — `/t1k:team triage`

Parallel issue/PR processing across all registered kit repos. T1K unique — no CK equivalent.

## Execution Protocol

When activated, IMMEDIATELY execute — do NOT ask for confirmation.

### 1. Discover Repos

Read ALL `t1k-config-*.json` files → collect `repos` entries:
- Primary repo (e.g., `The1Studio/theonekit-unity`)
- Related repos (e.g., `The1Studio/theonekit-core`, `The1Studio/theonekit-designer`)

### 2. Fetch Open Items

For each repo, via `gh` CLI:
```bash
gh issue list --repo {owner/repo} --state open --limit 20 --json number,title,labels,createdAt
gh pr list --repo {owner/repo} --state open --limit 20 --json number,title,labels,createdAt,isDraft
```

### 3. Pre-flight

1. **Re-verify Pre-flight Step 1 (Agent callable?).** Defense-in-depth for #259. If FAIL, bail per `fork-context-bail.md`.
2. **Verify `TeamCreate` available.** `ToolSearch(query="select:TeamCreate", max_results=1)`. If unavailable, STOP per SKILL.md Step 2.
3. `TeamCreate(team_name: "triage-<date>")`
4. Resolve roles: `reviewer` for PR reviews, `t1k-skills-manager` for skill issues

### 4. Create Tasks

One task per repo (or per category if single repo with many items):

- Subject: `Triage: {owner/repo} ({N} items)`
- Description:
  ```
  Process open issues and PRs for {owner/repo}.

  For each PR:
  - Review changes, check quality, approve or request changes
  - Use /t1k:review patterns for assessment

  For each issue:
  - Classify: bug, feature, enhancement, docs, question
  - Add labels via gh CLI
  - If actionable: create fix plan summary
  - If skill-related: validate skill, note needed updates

  Save report to: plans/reports/triage-{repo-slug}.md
  Format: table of items with classification, priority, action needed
  Mark task completed when done.
  ```

### 5. Spawn Triagers

For each repo task:
```
Agent(
  subagent_type: "{resolved reviewer agent}",
  name: "triager-{repo-slug}",
  description: "Triage: {repo}",
  prompt: "{task description} + {T1K Context Block}",
  model: "opus",
  run_in_background: true
)
```

No worktree needed — triage is read + GitHub API operations.

### 6. Monitor

- Primary: TaskCompleted events
- Fallback: TaskList poll every 60s

### 7. Synthesize

Read all triage reports. Create synthesis:
- File: `plans/reports/triage-summary-<date>.md`
- Cross-repo overview: total items, by category, by priority
- Actionable items list with suggested next command
- Skill issues found (flag for `/t1k:issue`)

### 8. Cook Handoff

Offer: "Found {N} actionable items across {M} repos. Options:"
- `/t1k:team cook` — implement all fixes in parallel
- `/t1k:cook` — implement one at a time
- Skip — just use the triage report for manual processing

### 9. Cleanup

1. `SendMessage(type: "shutdown_request")` to each triager
2. `TeamDelete`
3. Report: "Triage complete. {X} items processed across {Y} repos. {Z} actionable. Report: {path}."
4. Run `/t1k:watzup` to log session summary.
