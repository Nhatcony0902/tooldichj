#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// context-builder.cjs — Utility: build rich prompt context from project state
'use strict';
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

function buildContext(cwd) {
  cwd = cwd || process.cwd();
  const ctx = { git: {}, project: {}, modules: [] };

  // Git info
  try {
    ctx.git.branch = execSync('git branch --show-current', { cwd, encoding: 'utf8' }).trim();
    ctx.git.lastCommits = execSync('git log --oneline -5', { cwd, encoding: 'utf8' }).trim().split('\n');
    const status = execSync('git status --porcelain', { cwd, encoding: 'utf8' }).trim();
    ctx.git.dirtyFiles = status ? status.split('\n').length : 0;
  } catch {}

  // Package info (Node.js)
  const pkgPath = path.join(cwd, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      ctx.project.name = pkg.name;
      ctx.project.version = pkg.version;
      ctx.project.type = 'node';
    } catch {}
  }

  // Go module
  const goModPath = path.join(cwd, 'go.mod');
  if (fs.existsSync(goModPath)) {
    try {
      const goMod = fs.readFileSync(goModPath, 'utf8');
      const match = goMod.match(/^module\s+(.+)/m);
      if (match) { ctx.project.name = match[1]; ctx.project.type = 'go'; }
    } catch {}
  }

  // TheOneKit modules
  const metaPath = path.join(cwd, '.claude', 'metadata.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      const { getModuleNames } = require('./telemetry-utils.cjs');
      ctx.modules = getModuleNames(meta);
      ctx.project.kitName = meta.kitName;
      ctx.project.version = meta.version;
    } catch {}
  }

  // Active plan
  const plansDir = path.join(cwd, 'plans');
  if (fs.existsSync(plansDir)) {
    try {
      const dirs = fs.readdirSync(plansDir)
        .filter(d => /^\d{6}/.test(d) && fs.statSync(path.join(plansDir, d)).isDirectory())
        .sort().reverse();
      if (dirs.length > 0) ctx.activePlan = `plans/${dirs[0]}/`;
    } catch {}
  }

  return ctx;
}

module.exports = { buildContext };
