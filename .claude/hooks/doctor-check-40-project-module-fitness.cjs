// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-40-project-module-fitness.cjs — Doctor check #40: project-module fitness.
 *
 * Shells to `t1k modules detect --json --cache-only` and surfaces any confident
 * install/recover recommendations as WARN. Never applies, never installs, never
 * surfaces ambiguous[] or unused-suspect[] (those require AI review).
 *
 * Cache-only: the CLI owns TTL/staleness. Doctor never triggers a cold scan
 * (cold scans can exceed 10s on monorepos and would block every doctor run).
 *
 * Skip conditions (exit 0, non-blocking):
 *   1. Global-only mode — no project to scan.
 *   2. `t1k` CLI absent from PATH.
 *   3. Cache file missing.
 *   4. CLI reports {mode: "cache-empty"}.
 *   5. Spawn timeout.
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const { resolveProjectDir } = require('./telemetry-utils.cjs');

const CHECK_ID = 40;
const CHECK_NAME = 'project-module-fitness';
const CACHE_REL_PATH = path.join('session-state', 'detect-cache.json');
const CLI_TIMEOUT_MS = 5000;

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
}

function hasCli() {
  const probe = spawnSync('t1k', ['--version'], { shell: false, timeout: CLI_TIMEOUT_MS });
  return probe.status === 0;
}

function cachePresent(projectDir) {
  return fs.existsSync(path.join(projectDir, '.claude', CACHE_REL_PATH));
}

function runDetect() {
  return spawnSync(
    't1k',
    ['modules', 'detect', '--json', '--cache-only'],
    { shell: false, timeout: CLI_TIMEOUT_MS, encoding: 'utf8' }
  );
}

function run() {
  const project = resolveProjectDir();
  if (project.globalOnly) {
    emit('SKIP', 'global-only mode — no project to scan');
    process.exit(0);
  }

  if (!hasCli()) {
    emit('SKIP', '`t1k` CLI not found on PATH — install with `npm i -g @the1studio/theonekit-cli`');
    process.exit(0);
  }

  const projectDir = project.t1kDir ? path.dirname(project.t1kDir) : process.cwd();
  if (!cachePresent(projectDir)) {
    emit('SKIP', 'detect cache missing — run `/t1k:modules detect` to populate it');
    process.exit(0);
  }

  const result = runDetect();
  if (result.error && result.error.code === 'ETIMEDOUT') {
    emit('WARN', 'detect timed out — run `/t1k:modules detect` manually');
    process.exit(0);
  }
  if (result.status !== 0) {
    const stderr = (result.stderr || '').toString().trim();
    emit('SKIP', `t1k exited ${result.status}${stderr ? ` — ${stderr}` : ''}`);
    process.exit(0);
  }

  let parsed;
  try {
    parsed = JSON.parse((result.stdout || '').toString());
  } catch (err) {
    emit('SKIP', `could not parse t1k JSON output: ${err.message}`);
    process.exit(0);
  }

  if (parsed && parsed.mode === 'cache-empty') {
    emit('SKIP', 'detect cache is stale — run `/t1k:modules detect` to refresh it');
    process.exit(0);
  }

  const confident = (parsed && parsed.confident) || {};
  const install = Array.isArray(confident.install) ? confident.install : [];
  const recover = Array.isArray(confident.recover) ? confident.recover : [];

  if (install.length === 0 && recover.length === 0) {
    emit('PASS', 'no install/recover recommendations');
    process.exit(0);
  }

  emit(
    'WARN',
    `${install.length} install recommendation(s), ${recover.length} recover recommendation(s)`
  );
  for (const entry of install) {
    const name = typeof entry === 'string' ? entry : entry && entry.module;
    if (name) process.stdout.write(`       install: ${name}\n`);
  }
  for (const entry of recover) {
    const name = typeof entry === 'string' ? entry : entry && entry.module;
    if (name) process.stdout.write(`       recover: ${name}\n`);
  }
  process.stdout.write('       run `/t1k:modules add <name>` to apply\n');
  process.exit(0);
}

try {
  run();
} catch (err) {
  emit('SKIP', `unexpected error: ${err.message}`);
  process.exit(0);
}
