#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-error-collector.cjs - Log error patterns from failed Bash commands
 *
 * PostToolUse hook for Bash tool.
 * When a Bash command exits non-zero, logs error context to
 * .claude/telemetry/errors-{date}.jsonl for later aggregation.
 *
 * Respects features.telemetry config flag (opt-out).
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const { T1K, parseHookStdin, isTelemetryEnabled, ensureTelemetryDir, todayDateStr } = require('./telemetry-utils.cjs');

  if (!isTelemetryEnabled()) process.exit(0);

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput, tool_result: toolResult } = hookData;

  // Only check Bash
  if (toolName !== 'Bash') process.exit(0);

  // Check for non-zero exit — tool_result contains stdout/stderr
  const result = typeof toolResult === 'string' ? toolResult : JSON.stringify(toolResult || '');
  const cmd = (toolInput?.command || '').trim();
  if (!cmd) process.exit(0);

  // Detect non-zero exit via exit code marker (most reliable)
  // Also check for strong error indicators that rarely appear in normal output
  const hasExitCode = /exit code [1-9]\d*/i.test(result) || /Exit code: [1-9]\d*/i.test(result);
  const hasStrongError = /^(TypeError|SyntaxError|ReferenceError|ENOENT|FATAL ERROR):/m.test(result) ||
    result.includes('command not found') ||
    result.includes('Permission denied') ||
    /npm ERR!/.test(result);

  if (!hasExitCode && !hasStrongError) process.exit(0);

  // Extract first meaningful error line (max 200 chars)
  const errorLines = result.split('\n')
    .filter(l => /error|fail|cannot|exception|TypeError|SyntaxError/i.test(l))
    .slice(0, 3)
    .map(l => l.trim().substring(0, 200));

  const stderrHead = errorLines.join(' | ') || result.substring(0, 200);

  // Sanitize command: strip env var values (KEY=value → KEY=***)
  const sanitizedCmd = cmd.replace(/(\w+)=\S+/g, '$1=***').substring(0, 200);

  const entry = {
    ts: new Date().toISOString(),
    cmd: sanitizedCmd,
    stderrHead: stderrHead.substring(0, 200),
  };

  // Write to date-stamped JSONL file
  const telemetryDir = ensureTelemetryDir();
  const date = todayDateStr();
  const filePath = path.join(telemetryDir, `${T1K.ERRORS_PREFIX}${date}.jsonl`);
  fs.appendFileSync(filePath, JSON.stringify(entry) + '\n');

  // Count total errors to check threshold
  const ERROR_THRESHOLD = 3;
  const errorContent = fs.readFileSync(filePath, 'utf8').trim();
  const errorCount = errorContent ? errorContent.split('\n').length : 0;

  if (errorCount >= ERROR_THRESHOLD) {
    const thresholdMarker = path.join(telemetryDir, '.threshold-triggered');
    if (!fs.existsSync(thresholdMarker)) {
      fs.writeFileSync(thresholdMarker, new Date().toISOString());
      console.log(`[t1k:telemetry-threshold] ${errorCount} errors logged (threshold: ${ERROR_THRESHOLD}). Run /t1k:watzup now to review error patterns and submit telemetry.`);
    } else {
      console.log(`[t1k:telemetry] Error logged (${errorCount} total). Update relevant skill gotcha if this is a new pattern.`);
    }
  } else {
    console.log(`[t1k:telemetry] Error logged (${errorCount}/${ERROR_THRESHOLD}). Update relevant skill gotcha if this is a new pattern.`);
  }

  process.exit(0);
} catch {
  process.exit(0); // Fail-open
}
