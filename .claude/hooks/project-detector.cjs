#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// project-detector.cjs — SessionStart hook: auto-detect project type and framework
'use strict';

if (process.env.T1K_DEBUG_DETECTOR === '1') {
  console.error('[t1k:detector-debug] starting');
}

try {
  const { detectProjectType } = require('./telemetry-utils.cjs');
  const cwd = process.cwd();

  // SSOT — detection logic (incl. phantom-kit framework filtering) lives in
  // telemetry-utils.detectProjectType so check-mcp-health's appliesWhen gate
  // reuses the exact same rules (#R1). project-detector keeps the stdout shape.
  const { projectType, framework, packageManager } = detectProjectType(cwd);

  if (process.env.T1K_DEBUG_DETECTOR === '1') {
    console.error('[t1k:detector-debug] detected:', JSON.stringify({ projectType, framework, packageManager }));
  }

  const parts = [`[project-type] ${projectType}`];
  if (framework) parts.push(`[framework] ${framework}`);
  if (packageManager) parts.push(`[package-manager] ${packageManager}`);
  console.log(parts.join(' | '));

  process.exit(0);
} catch (e) {
  process.exit(0); // fail-open
}
