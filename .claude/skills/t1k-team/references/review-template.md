---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Review Template — `/t1k:team review`

Parallel code review with registry-routed reviewers and module boundary checks. Read-only, low risk.

## Execution Protocol

When activated, IMMEDIATELY execute — do NOT ask for confirmation.

### 1. Derive Review Focuses

From `<scope>`, generate N focuses (default N=3):
- **Focus 1:** Security — vulnerabilities, auth, input validation, OWASP
- **Focus 2:** Performance — bottlenecks, memory, complexity, scaling
- **Focus 3:** Test coverage — gaps, edge cases, error paths

**T1K enhancement:** If reviewing code across 2+ installed modules, add automatic focus:
- **Focus N+1:** Module boundary compliance — cross-module imports, dependency violations, manifest alignment

### 2. Pre-flight

Follow SKILL.md → Pre-flight Protocol:
1. **Re-verify Pre-flight Step 1 (Agent callable?).** Defense-in-depth for #259. If FAIL, bail per `fork-context-bail.md`.
2. **Verify `TeamCreate` available.** `ToolSearch(query="select:TeamCreate", max_results=1)`. If unavailable, STOP per SKILL.md Step 2.
3. `TeamCreate(team_name: "review-<scope-slug>")`
4. Resolve `reviewer` role via routing protocol
5. Detect modules, build skill injection per reviewer

### 3. Create Tasks

`TaskCreate` x N — one per focus:
- Subject: `Review: <focus-title>`
- Description: `Review <scope> for <focus>. Output severity-rated findings ONLY. Format: [CRITICAL|IMPORTANT|MODERATE] <finding> — <evidence> — <recommendation>. No "seems" or "probably" — concrete evidence only. Save to: plans/reports/reviewer-{N}-{scope-slug}.md. Mark task completed when done.`

### 4. Spawn Reviewers

For each focus, spawn via `Agent` tool:
```
Agent(
  subagent_type: "{resolved reviewer agent}",
  name: "reviewer-{N}",
  description: "Review: {focus-title}",
  prompt: "{task description} + {T1K Context Block}",
  model: "opus",
  run_in_background: true
)
```

**Module-scoped reviewers:** Inject module skills so reviewers check compliance with module-specific patterns:
```
Module context:
 - Agent: reviewer (module: {module-name} v{version})
 - Module skills: {skill list — contains coding patterns to check against}
 - Review for compliance with module patterns. Flag deviations.
```

### 5. Monitor

- Primary: TaskCompleted events
- Fallback: TaskList poll every 60s

### 6. Synthesize

Read all reviewer reports. Create synthesis:
- File: `plans/reports/review-{scope-slug}.md`
- Deduplicate findings across reviewers (same issue found by multiple = stronger signal)
- Prioritize: CRITICAL > IMPORTANT > MODERATE
- Create action items list
- **T1K addition:** Separate section for module boundary violations (if any)

### 7. Cleanup

1. `SendMessage(type: "shutdown_request")` to each teammate
2. `TeamDelete`
3. Report: "Review complete. {X} findings ({Y} critical). Report: {path}."
4. Run `/t1k:watzup` to log session summary.
