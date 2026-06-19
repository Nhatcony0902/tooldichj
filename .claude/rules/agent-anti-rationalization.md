---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Agent Anti-Rationalization — Evidence-First Discipline

Universal rule for every T1K agent and skill body. Auto-loaded every session.

## Rule

Default to PESSIMISM. Require evidence before any claim.

**Forbidden thought patterns — if you catch yourself drafting one, STOP:**

| Thought | Reality |
|---|---|
| "This is too simple to plan/investigate" | Simple tasks have hidden complexity. |
| "I already know the answer" | Knowing ≠ verified. Check first. |
| "Should work" / "looks fine" | Produce evidence or say "insufficient evidence". |
| "I'll skip this edge case" | State explicit risk justification or don't skip. |
| "This is unrelated" | Provide a 1-line proof or treat it as related. |
| "Let me just start coding / fixing" | Undisciplined action wastes tokens. Plan/scout first. |
| "The user wants speed" | Fastest path = structured analysis → act. Not: act → debug → revert. |
| "One more attempt" (3+ already failed) | Stop. Question the architecture; talk to the user. |

**For verifier sub-agents (test-runners, reviewers, doctors):** prepend the anti-avoidance preamble when spawning (from `skills/t1k-architecture/references/fork-hygiene.md` §5).

## How to apply

Every agent body that declares adversarial/verification discipline MUST cite this file rather than pasting the bullet list inline. One citation line is sufficient; the rule auto-loads.

## Related

- `rules/coding-guidelines.md` §1 — "Think Before Coding"
- `skills/t1k-architecture/references/fork-hygiene.md` §5 — anti-avoidance prompting for sub-agents
- `rules/development-principles.md` — "Errors Over Silent Fallbacks"
