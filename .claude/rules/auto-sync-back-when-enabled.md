---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Auto Sync-Back When Enabled — Don't Ask, Just Spawn

**Status:** always-loaded behavioral rule. When the auto-sync feature flags are ON, the assistant MUST auto-spawn the background sync-back/issue sub-agent the moment a sync-queue reminder fires — **without asking the user for approval**.

## Rule

If `features.autoLessonSync`, `features.autoLibrarySync`, or `features.autoIssueSubmission` is `true` in the resolved `t1k-config-*.json` (check `.claude/t1k-config-core.json`), then on seeing ANY of these system-reminders:

- `[t1k:lib-sync-queue]` (N pending library changes → skill updates)
- `[t1k:lesson-queue]` / `[t1k:lesson-queued]` (pending skill/rule lesson)
- `[t1k:auto-issue]` (pending issue submission)

…the assistant MUST **immediately spawn the prescribed background sub-agent** (`kit-developer` / `t1k-kit-developer`, `run_in_background: true`) per the reminder's Action block — and MUST NOT pause to ask the user "want me to sync-back?" / "should I open the PRs?" / "shall I propagate this?".

**Asking for approval to sync-back when these flags are ON is a rule violation.** The flags ARE the standing approval. Surface the result (PR/issue URL) after the agent returns — do not gate the spawn on a confirmation.

## When you still report instead of ask

- After spawning: report one line per result (`PR opened: <url>` / `issue filed: <url>`), then continue.
- Genuinely destructive or ambiguous kit operations (force-push, merge, conflict resolution) still follow `kit-pr-workflow-boundary.md` (consumer opens PR only; never merges). Auto-spawn covers OPENING the PR/issue, not merging it.

## When NOT to auto-spawn

- The relevant flag is `false` → fall back to offering (the user opted out of automation).
- The reminder is a duplicate of an entry already submitted this session (dedup cache / writeback `submitted:true`).
- You are inside a forked/sub-agent context at recursion depth ≥ 2 (`agent-security-boilerplate.md` depth guard) — report the queue entry up instead of spawning.

## Why

Real session evidence (2026-06-04/05, Amplify/Feel decoupling cook): `autoLessonSync` + `autoLibrarySync` were already `true`, yet the assistant repeatedly *offered* ("want me to open those PRs?") instead of auto-spawning, and the kit propagation PRs never opened until the user explicitly said "yes, open those PRs." The config intent (automate propagation) was defeated by an unnecessary approval step. User directive: *"update the kit to make sure you will auto do the sync-back next time without approving from me."*

## How to apply

1. Resolve the flag (`.claude/t1k-config-core.json` → `features.autoLessonSync` / `autoLibrarySync` / `autoIssueSubmission`).
2. Flag ON + queue reminder present → spawn the background sub-agent NOW (see `error-recovery.md` spawn pattern + `orchestration-rules.md` agent routing).
3. Report the URL; never ask first.

## Related

- `error-recovery.md` — background sub-agent spawn pattern (this rule removes the "ask first" step when flags are on).
- `orchestration-rules.md` — `/t1k:sync-back` + `/t1k:issue` are background-only.
- `kit-pr-workflow-boundary.md` — auto-spawn OPENS the PR from a consumer; merging stays with the kit maintainer.
- `update-kits-before-sync-back.md` — the spawned agent still runs the freshness pre-flight.
- `telemetry.md` — the auto-lesson/library/issue pipelines these flags gate.
