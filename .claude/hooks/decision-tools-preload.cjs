#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// decision-tools-preload.cjs — SessionStart hook
//
// Emits a system-reminder telling the AI that AskUserQuestion is mandatory for
// multi-option decisions, and to load it via ToolSearch if the harness has
// deferred its schema. Background: Claude Code's long-context (1M Opus) mode
// auto-defers tool schemas above ~10K tokens of definitions; AskUserQuestion
// is among the deferred tools and must be loaded explicitly before its first
// call. There is no settings.json knob to pin specific tools as eager — this
// reminder is the harness-supported path. See:
//   ~/.claude/rules/ask-before-deciding.md (the rule)
//   plans/research/2026-04-29-deferred-tool-mechanism.md (research notes)
//
// Cost: one extra ToolSearch round-trip per session if the AI follows the
// reminder. With prompt caching the schema stays loaded after first call.
//
// Fail-open: any I/O error swallows and exits 0 — never blocks SessionStart.
'use strict';
try {
  const REMINDER = '[t1k:decision-tools] AskUserQuestion is mandatory for any multi-option decision per rules/ask-before-deciding.md. If the deferred-tools list shows "AskUserQuestion", run ToolSearch(query="select:AskUserQuestion", max_results=1) BEFORE any response that would otherwise contain prose "Q1/Q2", "Pick one of", "Should I A or B", or bulleted choice lists. Never substitute prose questions inside skill bodies — load the schema first, then call the tool.';
  console.log(REMINDER);
  process.exit(0);
} catch {
  process.exit(0);
}
