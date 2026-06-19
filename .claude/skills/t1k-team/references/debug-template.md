---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---
# Debug Template — `/t1k:team debug`

Adversarial hypothesis testing with registry-routed debuggers and worktree isolation. Debuggers actively challenge each other's findings.

## Execution Protocol

When activated, IMMEDIATELY execute — do NOT ask for confirmation.

### 1. Generate Hypotheses

From `<issue>`, generate N competing hypotheses (default N=3):
- Each hypothesis must be independently testable
- Each must predict different observable symptoms
- Frame as: "If <cause>, then we should see <evidence>"

**T1K enhancement:** If issue spans modules, scope hypotheses per module:
- Read `metadata.json` → match issue keywords against module activation
- If 2+ modules: "Module A's combat system causes overflow" vs "Module B's UI doesn't handle null"

### 2. Pre-flight

Follow SKILL.md → Pre-flight Protocol:
1. **Re-verify Pre-flight Step 1 (Agent callable?).** Defense-in-depth for #259. If FAIL, bail per `fork-context-bail.md`.
2. **Verify `TeamCreate` available.** `ToolSearch(query="select:TeamCreate", max_results=1)`. If unavailable, STOP per SKILL.md Step 2.
3. `TeamCreate(team_name: "debug-<issue-slug>")`
4. Resolve `t1k-debugger` role via routing protocol
5. Detect modules, build skill injection

### 3. Create Tasks

`TaskCreate` x N — one per hypothesis:
- Subject: `Debug: Test hypothesis — <theory>`
- Description: `Investigate hypothesis: <theory>. For issue: <issue>. ADVERSARIAL: actively try to DISPROVE other theories. Message other debuggers to challenge findings. Report evidence FOR and AGAINST your theory. Save findings to: plans/reports/debugger-{N}-{issue-slug}.md. Mark task completed when done.`

### 4. Spawn Debuggers

For each hypothesis:
```
Agent(
  subagent_type: "{resolved t1k-debugger agent}",
  name: "debugger-{N}",
  description: "Debug: {theory}",
  prompt: "{task description} + {T1K Context Block}",
  model: "opus",
  run_in_background: true,
  isolation: "worktree"
)
```

**MANDATORY:** `isolation: "worktree"` — debuggers may add logging, test code, or instrumentation. Worktrees are throwaway (NOT merged).

**Module-scoped debuggers:** Inject module skills for domain context:
```
Module context:
 - Agent: t1k-debugger (module: {module-name} v{version})
 - Module skills: {skill list — contains patterns and known gotchas}
 - Investigate within your module's domain. Challenge other debuggers' findings.
```

### 5. Monitor

- Let debuggers converge via peer `SendMessage` — they challenge each other
- Primary: TaskCompleted events
- Fallback: TaskList poll every 60s
- Do NOT intervene unless stuck >10 min — adversarial debate is productive

### 6. Identify Root Cause

Read all t1k-debugger reports. Determine:
- Which hypotheses were disproven (and by what evidence)?
- Which hypothesis survives with strongest evidence?
- **T1K addition:** Which module owns the root cause? → Note for fix routing

### 7. Write Root Cause Report

File: `plans/reports/debug-{issue-slug}.md`
Format:
- Root cause (with evidence chain)
- Module ownership (which module to fix)
- Disproven hypotheses (what was ruled out and why)
- Recommended fix approach
- Suggested command: `/t1k:fix <root-cause-summary>`

### 8. Cleanup

1. `SendMessage(type: "shutdown_request")` to each t1k-debugger
2. `TeamDelete`
3. **Do NOT merge worktrees** — debug code is throwaway
4. Worktree cleanup: `git worktree remove <path>` for each
5. Report: "Debug complete. Root cause: {summary}. Module: {name}. Report: {path}."
6. Run `/t1k:watzup` to log session summary.
