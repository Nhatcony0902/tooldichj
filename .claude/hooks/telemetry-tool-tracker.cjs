#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-tool-tracker.cjs — PostToolUse hook: track tool usage for cloud telemetry
 *
 * Fires on ALL tool invocations. Updates .prompt-state.json with tool names
 * and agent spawn count. Lightweight — only reads/writes one small JSON file.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const { T1K, isTelemetryEnabled, ensureTelemetryDir } = require('./telemetry-utils.cjs');

  let input = '';
  try { input = fs.readFileSync(0, 'utf8'); } catch { process.exit(0); }
  let hookData;
  try { hookData = JSON.parse(input); } catch { process.exit(0); }

  const toolName = hookData.tool_name;
  if (!toolName || !isTelemetryEnabled()) process.exit(0);

  const telemetryDir = ensureTelemetryDir();
  const statePath = path.join(telemetryDir, T1K.STATE_FILE);
  if (!fs.existsSync(statePath)) process.exit(0);

  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  if (!state.toolsUsed) state.toolsUsed = [];
  let changed = false;

  if (!state.toolsUsed.includes(toolName)) {
    state.toolsUsed.push(toolName);
    changed = true;
  }
  if (toolName === 'Agent') {
    state.subagentsSpawned = (state.subagentsSpawned || 0) + 1;
    changed = true;
  }

  if (changed) fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
