---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Fork Context Brief (FCB) — Resolve Before You Ask

When invoking a forked skill (`context: fork`), `Agent`, or `TeamCreate`, the receiver runs with ZERO prior conversation history. Ambiguous references (`"the plan above"`, `"plan B"`, `"that report"`) cannot be resolved unless explicitly provided — the receiver will round-trip ("I don't see X") or hallucinate.

Full spec (Brief format, examples, security, resolution algorithm): [`fcb-protocol.md`](../skills/t1k-resolve-context/references/fcb-protocol.md).

## Rule 1 — SENDER side

**Before invoking any fork, if the user's prompt contains ambiguous references, you MUST construct a Fork Context Brief and embed it in the prompt.**

| User phrasing contains... | Embed Brief? |
|---|---|
| `above`, `previous`, `that`, `this`, `the one`, `as we discussed` | Yes — always |
| `plan A/B/C`, `option N`, `round N`, `phase N` (no path) | Yes |
| Pronouns to prior artifacts (`it`, `them`, `they`) | Yes |
| Explicit file path or self-contained noun phrase | No — pass through |
| Pure factual question | No |

Use `/t1k:resolve-context` to automate Brief construction.

## Rule 2 — RECEIVER side

**Before responding "I don't see X" to any ambiguous reference, you MUST attempt resolution from local signals.** Asking is the LAST resort. The full resolution order (Validated Brief → recent plans/reports → recent git activity → session transcript → user memory + project `CLAUDE.md` → only then ask), plus FCB-consumption sub-rules (which discovery steps to skip when an FCB block is present) and exception-override semantics, live in [`fcb-protocol.md`](../skills/t1k-resolve-context/references/fcb-protocol.md) § "Receiver consumption".

## Related

- [`fcb-protocol.md`](../skills/t1k-resolve-context/references/fcb-protocol.md) — full spec + receiver-consumption sub-rules + exception override
- [`orchestration-rules.md`](orchestration-rules.md) — Context Isolation Principle
- [`always-ask-on-unresolved.md`](always-ask-on-unresolved.md) — when asking is unavoidable after resolution fails
