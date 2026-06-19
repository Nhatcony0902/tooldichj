---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Delegate to Sub-Agents to Preserve Main-Session Context

## Rule

The main session is the **orchestrator**, not the worker. A sub-agent (`Agent` / `Task`) runs in its **own isolated context window** — its reads, searches, and intermediate reasoning stay there; **only its final summary returns** (the spawn prompt + returned summary are the *only* main-session token cost).

So **delegate token-heavy work by default** to keep the orchestrator lean — every raw dump you absorb inline is context you can't reclaim, and signal-to-noise degrades well before the window is "full." This is the **Orchestrator-Workers** pattern (Anthropic, *Building Effective Agents*).

## Delegate by default

| Trigger | Narrowest agent |
|---|---|
| Exploration / broad search / reading 3+ files to answer one question | `Explore` |
| Verbose-output work you won't reference again (logs, dumps, scans) | `Explore` / `general-purpose` |
| Mechanical edits — rename, format, lint-fix, boilerplate | `t1k-fullstack-developer` |
| Run a test suite + report pass/fail | `t1k-tester` |
| Research / web lookups / doc audits | `t1k-researcher` / `t1k-docs-manager` |
| Bounded code review (read-only → summary) | `t1k-code-reviewer` |
| Kit-script / cross-kit work / issue-filing / sync-back | `t1k-kit-developer` |

Pick the narrowest specialist (`orchestration-rules.md` routing table); `general-purpose` is the last resort.

## Keep inline

- Architecture, planning, design — judgment needing the full accumulated context
- Multi-file refactor where each step needs awareness of prior steps
- Sequential chains where step N needs step N-1's *full* output, not a summary
- A single quick `Read`/`Grep` you act on immediately, or a < ~20-line patch
- **Synthesis** of sub-agent results — the orchestrator's core job; never delegated away

## Full details

The three guard-clauses (don't-delegate cases — context reconstruction, output saturation, ambiguous spec), the "raw material vs conclusion" apply-test, and the super-linear-accumulation rationale: `docs/delegate-to-preserve-context.md`.

## Related

- `orchestration-rules.md` · `fork-context-brief.md` · `mr-transparent-routing.md` · `agent-completion-discipline.md` · `parallelize-batch-work.md` · `t1k-context` skill
