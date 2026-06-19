#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
try {
  const { execSync } = require('child_process');
  const fs = require('fs');
  const path = require('path');
  const { save, load, cleanup } = require('./session-state-manager.cjs');
  const { parseHookStdin } = require('./telemetry-utils.cjs');

  const input = parseHookStdin() || {};
  const event = input.event || input.type || '';

  if (event === 'Stop' || event === 'stop') {
    // Gather current state and save
    let gitBranch = '';
    try { gitBranch = execSync('git branch --show-current', { encoding: 'utf8' }).trim(); } catch {}

    let activePlan = '';
    const plansDir = path.join(process.cwd(), 'plans');
    if (fs.existsSync(plansDir)) {
      const dirs = fs.readdirSync(plansDir).filter(d => /^\d{6}/.test(d) && fs.statSync(path.join(plansDir, d)).isDirectory()).sort().reverse();
      if (dirs.length > 0) activePlan = `plans/${dirs[0]}/`;
    }

    let installedModules = [];
    const metaPath = path.join(process.cwd(), '.claude', 'metadata.json');
    if (fs.existsSync(metaPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        const { getModuleNames } = require('./telemetry-utils.cjs');
        installedModules = getModuleNames(meta);
      } catch {}
    }

    save({ activePlan, gitBranch, installedModules, projectType: 'configuration' });
    cleanup(7);
  } else {
    // SessionStart — restore and output context
    const state = load();
    if (state) {
      const parts = [];
      if (state.activePlan) parts.push(`Active plan: ${state.activePlan}`);
      if (state.gitBranch) parts.push(`Branch: ${state.gitBranch}`);
      if (state.installedModules?.length) parts.push(`Modules: ${state.installedModules.join(', ')}`);
      if (state.lastSkillUsed) parts.push(`Last skill: ${state.lastSkillUsed}`);
      if (parts.length > 0) {
        console.log(`[session-state] Restored: ${parts.join(' | ')}`);
      }
    }
  }
  process.exit(0);
} catch (e) {
  process.exit(0); // fail-open
}
