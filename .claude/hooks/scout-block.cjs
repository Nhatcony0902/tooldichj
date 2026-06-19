#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// scout-block.cjs — PreToolUse hook: blocks reads from noisy directories
// Targets: .git/ internals, node_modules/, lock files, build outputs
// Also reads .t1kignore from project root for per-project custom patterns.
'use strict';
try {
  const path = require('path');
  const { parseT1kIgnore } = require('./lib/t1kignore-parser.cjs');
  const { parseHookStdin } = require('./telemetry-utils.cjs');

  const input = parseHookStdin();
  if (!input) process.exit(0);

  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || toolInput.pattern || '';

  const BLOCKED = [
    /\/\.git\//,
    /node_modules\//,
    /package-lock\.json$/,
    /yarn\.lock$/,
    /pnpm-lock\.yaml$/,
    /\/dist\//,
    /\/build\//,
    /\/\.next\//,
    /\/obj\//,
    /\/Library\//,
  ];

  // Load .t1kignore patterns (additive, cached, fail-open)
  const projectRoot = process.cwd();
  const customPatterns = parseT1kIgnore(projectRoot);

  const allPatterns = [...BLOCKED, ...customPatterns];

  for (const pattern of allPatterns) {
    if (pattern.test(filePath)) {
      console.log(JSON.stringify({
        decision: 'block',
        reason: `scout-block: '${filePath}' matches noisy-directory pattern — read skipped to preserve context`,
      }));
      process.exit(2);
    }
  }
  process.exit(0);
} catch (e) {
  process.exit(0); // fail-open
}
