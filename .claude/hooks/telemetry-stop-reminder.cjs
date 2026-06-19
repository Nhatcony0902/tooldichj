#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-stop-reminder.cjs - Remind to run watzup when telemetry data exists
 *
 * Stop hook. Fires when AI is about to stop responding.
 * Checks if .claude/telemetry/ has unprocessed JSONL files.
 * If so, outputs a reminder to run /t1k:watzup.
 *
 * Non-blocking — just a nudge.
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
(async () => {
  try {
    const fs = require('fs');
    const path = require('path');
    const { T1K, isTelemetryEnabled, resolveClaudeDir } = require('./telemetry-utils.cjs');

    if (!isTelemetryEnabled()) process.exit(0);

    // Only remind if threshold was triggered but watzup wasn't run
    const resolved = resolveClaudeDir();
    if (!resolved) process.exit(0);
    const telemetryDir = path.join(resolved.claudeDir, T1K.TELEMETRY_DIR);
    if (!fs.existsSync(telemetryDir)) {
      process.exit(0);
    }

    // Only fire if error threshold was reached
    const thresholdMarker = path.join(telemetryDir, '.threshold-triggered');
    if (!fs.existsSync(thresholdMarker)) {
      process.exit(0);
    }

    // Debounce: only remind once per session
    const remindedMarker = path.join(telemetryDir, '.reminded');
    if (fs.existsSync(remindedMarker)) {
      process.exit(0);
    }

    // Count error entries
    const errorFiles = fs.readdirSync(telemetryDir)
      .filter(f => f.startsWith(T1K.ERRORS_PREFIX) && f.endsWith('.jsonl'));

    let errorCount = 0;
    for (const file of errorFiles) {
      const content = fs.readFileSync(path.join(telemetryDir, file), 'utf8').trim();
      if (content) errorCount += content.split('\n').length;
    }

    if (errorCount === 0) {
      process.exit(0);
    }

    fs.writeFileSync(remindedMarker, new Date().toISOString());
    console.log(`[t1k:telemetry-pending] ${errorCount} errors pending review. Run /t1k:watzup to review and submit.`);

    process.exit(0);
  } catch (e) {
    // Fail-open
    process.exit(0);
  }
})();
