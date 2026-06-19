#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
const fs = require('fs');
const path = require('path');

const { resolveClaudeDir } = require('./telemetry-utils.cjs');
const resolved = resolveClaudeDir();
const STATE_DIR = resolved
  ? path.join(resolved.claudeDir, 'session-state')
  : path.join(__dirname, '..', 'session-state');

function ensureDir() {
  if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

function save(data) {
  ensureDir();
  const filename = new Date().toISOString().split('T')[0] + '.json';
  const filepath = path.join(STATE_DIR, filename);
  fs.writeFileSync(filepath, JSON.stringify({ ...data, timestamp: new Date().toISOString() }, null, 2));
  return filepath;
}

function load() {
  ensureDir();
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json')).sort().reverse();
  if (files.length === 0) return null;
  return JSON.parse(fs.readFileSync(path.join(STATE_DIR, files[0]), 'utf8'));
}

function cleanup(days = 7) {
  ensureDir();
  const cutoff = Date.now() - days * 86400000;
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  for (const f of files) {
    const stat = fs.statSync(path.join(STATE_DIR, f));
    if (stat.mtimeMs < cutoff) fs.unlinkSync(path.join(STATE_DIR, f));
  }
}

module.exports = { save, load, cleanup, STATE_DIR };
