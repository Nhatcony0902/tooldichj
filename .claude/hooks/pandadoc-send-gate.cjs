#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * pandadoc-send-gate.cjs — PreToolUse hook (PandaDoc send approval gate).
 *
 * Enforces the user policy: a PandaDoc document must NEVER be sent to
 * recipients without the user's explicit, per-send approval. The
 * t1k:business:pandadoc-esign skill body says "never auto-send", but skill
 * text is advisory — this hook makes it mechanical and un-bypassable by the
 * agent. Hosted in theonekit-core because non-core kits cannot ship hooks
 * (release-action Gate #22, validate-kits-ship-no-hooks.cjs --strict); core is
 * the canonical hook host. Companion advisory note: theonekit-business PR #2
 * (the pandadoc-esign SKILL.md hard-gate).
 *
 * Gated tools:
 *   - mcp__pandadoc__documents_send          → always (this IS the send)
 *   - mcp__pandadoc__documents_status_change → only when moving a document to
 *     a recipient-visible / sent state (document.sent / sent), which transmits
 *     it just like documents_send.
 *
 * Mechanism: emit a PreToolUse decision of "ask" so Claude Code ALWAYS shows
 * the human a confirmation prompt for the send, regardless of any allowlist or
 * auto-approve setting. The agent cannot satisfy the gate on its own — only the
 * human clicking approve can. Non-send PandaDoc tools (create/edit/track/
 * retrieve/draft-archive) are untouched. This is an "ask" gate, never a hard
 * exit-2 block — the human must be able to approve a legitimate send.
 *
 * Output contract: write ONLY the decision JSON to stdout (hook-runner inherits
 * child stdout → harness). Diagnostics, if any, go to stderr.
 *
 * Exit codes:
 *   0 — emitted the decision, or tool is not a gated send, or internal error
 *       (fail-safe: on a gated send we still emit "ask"; on anything else we
 *       allow normally). Fail-open per rules/security.md.
 */

function ask(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

try {
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const tool = hookData.tool_name || '';
  const input = hookData.tool_input || {};

  const isSend = tool === 'mcp__pandadoc__documents_send';

  let isStatusSend = false;
  if (tool === 'mcp__pandadoc__documents_status_change') {
    // status_change can transmit a draft (→ document.sent / sent). Gate those;
    // leave benign transitions (e.g. draft, paused) to flow normally. Match the
    // "sent" state as a whole token (word-boundary delimited) so a hypothetical
    // "unsent" value does not over-trigger. If the shape is unexpected we still
    // bias toward the safe "ask" direction below.
    const blob = JSON.stringify(input).toLowerCase();
    isStatusSend = /\bsent\b/.test(blob) || /document\.sent/.test(blob);
  }

  if (!isSend && !isStatusSend) process.exit(0);

  ask(
    'PandaDoc SEND gate — this transmits a document to its recipients for signature. ' +
    'Per user policy, a PandaDoc document must NEVER be sent without the user\'s explicit ' +
    'approval for THIS send. Confirm the title + recipient list with the user, and only ' +
    'proceed if they explicitly approve.'
  );
} catch (_e) {
  // Fail-safe: never crash the tool pipeline on an internal hook error.
  process.exit(0);
}
