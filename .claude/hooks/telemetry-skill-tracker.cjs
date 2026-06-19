#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-skill-tracker.cjs - Track skill activations
 *
 * PostToolUse hook for Skill tool.
 * Logs which skills are activated, how often, for usage analytics.
 *
 * Respects features.telemetry config flag (opt-out).
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const { T1K, parseHookStdin, isTelemetryEnabled, ensureTelemetryDir, todayDateStr } = require('./telemetry-utils.cjs');

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;

  if (toolName !== 'Skill') process.exit(0);
  if (!isTelemetryEnabled()) process.exit(0);

  const entry = {
    ts: new Date().toISOString(),
    skill: toolInput?.skill || 'unknown',
    args: (toolInput?.args || '').substring(0, 200),
  };

  const telemetryDir = ensureTelemetryDir();
  const date = todayDateStr();
  const filePath = path.join(telemetryDir, `${T1K.USAGE_PREFIX}${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');

  process.exit(0);
} catch {
  process.exit(0); // Fail-open
}
