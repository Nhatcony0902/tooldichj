---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Research Template — `/t1k:team research`

Parallel research with module-scoped angles. Read-only, low risk.

## Execution Protocol

When activated, IMMEDIATELY execute — do NOT ask for confirmation.

### 1. Derive Angles

From `<topic>`, generate N angles (default N=3):
- **Angle 1:** Architecture, patterns, proven approaches
- **Angle 2:** Alternatives, competing solutions, trade-offs
- **Angle 3:** Risks, edge cases, failure modes, security

**T1K enhancement:** If topic matches installed modules, scope angles per module:
- Read `metadata.json` → `installedModules`
- Match topic keywords against module activation keywords
- If 2+ modules match: one t1k-researcher per matched module + one cross-cutting t1k-researcher

### 2. Pre-flight

Follow SKILL.md → Pre-flight Protocol:
1. **Re-verify Pre-flight Step 1 (Agent callable?).** Defense-in-depth for #259. If FAIL, bail per `fork-context-bail.md`.
2. **Verify `TeamCreate` available.** `ToolSearch(query="select:TeamCreate", max_results=1)`. If unavailable, STOP per SKILL.md Step 2.
3. `TeamCreate(team_name: "<topic-slug>")`
4. Resolve `t1k-researcher` role via routing protocol
5. Detect modules, build skill injection

### 3. Create Tasks

`TaskCreate` x N — one per angle:
- Subject: `Research: <angle-title>`
- Description: `Investigate <angle> for topic: <topic>. Save report to: plans/reports/researcher-{N}-{topic-slug}.md. Format: executive summary, key findings, evidence, recommendations. Mark task completed when done. Send findings summary to lead.`

### 4. Spawn Researchers

For each angle, spawn via `Agent` tool:
```
Agent(
  subagent_type: "{resolved t1k-researcher agent}",
  name: "researcher-{N}",
  description: "Research: {angle-title}",
  prompt: "{task description} + {T1K Context Block}",
  model: "opus",
  run_in_background: true
)
```

**Module-scoped researchers:** If scoped to a module, inject that module's skills:
```
Module context:
 - Agent: t1k-researcher (module: {module-name} v{version})
 - Module skills: {skill list from module activation}
 - Research within your module's domain. Cross-reference other modules if relevant.
```

### 5. Monitor

- Primary: TaskCompleted events notify when researchers finish
- Fallback: Check TaskList every 60s if no events
- If stuck >5 min: SendMessage directly to stuck t1k-researcher

### 6. Synthesize

Read all t1k-researcher reports from `plans/reports/`. Create synthesis:
- File: `plans/reports/research-summary-{topic-slug}.md`
- Format: executive summary, key findings across all angles, comparative analysis, recommendations, unresolved questions

### 7. Cleanup

1. `SendMessage(type: "shutdown_request")` to each teammate
2. `TeamDelete`
3. Report to user: "Research complete. {N} reports + synthesis at {path}."
4. Run `/t1k:watzup` to log session summary.
