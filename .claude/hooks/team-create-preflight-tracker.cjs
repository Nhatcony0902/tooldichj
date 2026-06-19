#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * team-create-preflight-tracker.cjs — PostToolUse hook for ToolSearch.
 *
 * Companion to team-create-preflight-gate.cjs (PreToolUse on TeamCreate).
 *
 * When ToolSearch is invoked with a query targeting Agent OR TeamCreate
 * (the t1k-team Pre-flight Step 0 pattern), writes a per-session sentinel
 * file. The PreToolUse gate checks for this sentinel and allows TeamCreate
 * only if it exists.
 *
 * Sentinel location: os.tmpdir()/t1k-team-preflight-{sessionId}.marker
 * (ephemeral, no cleanup needed — OS clears /tmp on reboot).
 *
 * Exit codes:
 *   0 — always (this hook only observes, never blocks)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function sentinelPath(sessionId) {
  const safe = String(sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), `t1k-team-preflight-${safe}.marker`);
}

try {
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  if (hookData.tool_name !== 'ToolSearch') process.exit(0);

  const query = (hookData.tool_input && hookData.tool_input.query) || '';

  // Match Step 0 pattern: ToolSearch(query="select:Agent..." OR "select:TeamCreate..." OR "select:Agent,TeamCreate")
  // We're permissive — ANY ToolSearch including Agent or TeamCreate counts as Step 0.
  if (!/select:[^"]*\b(Agent|TeamCreate)\b/i.test(query)) process.exit(0);

  const sessionId = hookData.session_id || process.env.CLAUDE_SESSION_ID || '';
  const sentinel = sentinelPath(sessionId);

  fs.writeFileSync(sentinel, JSON.stringify({
    ts: Date.now(),
    query: query.slice(0, 200),
    sessionId
  }), 'utf8');

  process.exit(0);
} catch (err) {
  try { process.stderr.write('[team-create-preflight-tracker] internal error: ' + err.message + '\n'); } catch {}
  process.exit(0);
}
