#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
try {
  const { load, save } = require('./session-state-manager.cjs');
  const { parseHookStdin } = require('./telemetry-utils.cjs');

  const input = parseHookStdin() || {};
  const toolResult = input.tool_result || input.result || {};

  // Only process TaskUpdate completions
  const resultStatus = typeof toolResult === 'object' ? toolResult?.status : null;
  if (resultStatus === 'completed') {
    const state = load() || {};
    const completedTasks = state.completedTasks || [];
    const taskId = input.tool_input?.taskId || 'unknown';
    if (!completedTasks.includes(taskId)) {
      completedTasks.push(taskId);
    }
    save({ ...state, completedTasks });
  }
  process.exit(0);
} catch (e) {
  process.exit(0); // fail-open
}
