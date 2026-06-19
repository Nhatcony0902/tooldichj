// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-42-statusline-wiring.cjs — Doctor check #42: statusline wiring end-to-end.
 *
 * Validates that the T1K statusline is fully wired from disk to Claude Code:
 *   1. hooks/statusline.cjs exists under the resolved .claude/ dir.
 *   2. metadata.json.installedFiles[] lists hooks/statusline.cjs with
 *      ownership=kit AND moduleName=t1k-base.
 *   3. settings.json has a statusLine block whose command contains both
 *      "hook-runner.cjs" and "statusline" tokens.
 *   4. hooks/hook-runner.cjs exists (dispatch target).
 *
 * Deterministic invariant check — no policy, no network, no CLI spawns.
 * Fail-open on unexpected errors (matches existing doctor checks).
 *
 * Usage: node doctor-check-42-statusline-wiring.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

const { resolveClaudeDir } = require('./telemetry-utils.cjs');

const CHECK_ID = 42;
const CHECK_NAME = 'statusline-wiring';
const STATUSLINE_REL = path.join('hooks', 'statusline.cjs');
const HOOK_RUNNER_REL = path.join('hooks', 'hook-runner.cjs');
const EXPECTED_MODULE = 't1k-base';
const EXPECTED_OWNERSHIP = 'kit';

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
}

function resolveDir(argvPath) {
  if (argvPath) return argvPath;
  const resolved = resolveClaudeDir();
  return resolved ? resolved.claudeDir : path.join(process.cwd(), '.claude');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { _error: err.message };
  }
}

function findInstalledEntry(meta) {
  const list = meta && Array.isArray(meta.installedFiles) ? meta.installedFiles : null;
  if (!list) return null;
  // Match by path — accept both forward-slash and OS-specific forms.
  const targets = ['hooks/statusline.cjs', STATUSLINE_REL];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    if (targets.includes(entry.path)) return entry;
  }
  return null;
}

function statusLineCommandHasTokens(settings) {
  const block = settings && settings.statusLine;
  if (!block || typeof block !== 'object') return false;
  const cmd = typeof block.command === 'string' ? block.command : '';
  return cmd.includes('hook-runner.cjs') && cmd.includes('statusline');
}

function run() {
  const claudeDir = resolveDir(process.argv[2]);
  if (!fs.existsSync(claudeDir)) {
    emit('SKIP', `.claude/ not found at ${claudeDir}`);
    process.exit(0);
  }

  const issues = [];

  // 1. statusline.cjs exists
  const statuslinePath = path.join(claudeDir, STATUSLINE_REL);
  if (!fs.existsSync(statuslinePath)) {
    issues.push(`missing ${STATUSLINE_REL} under ${claudeDir} — reinstall t1k-base or run \`t1k update\``);
  }

  // 2. metadata.json.installedFiles[] lists the file with ownership=kit, moduleName=t1k-base
  const metadataPath = path.join(claudeDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    issues.push(`missing metadata.json under ${claudeDir} — run \`t1k init\` to generate it`);
  } else {
    const meta = readJson(metadataPath);
    if (meta._error) {
      issues.push(`metadata.json parse error: ${meta._error}`);
    } else {
      const entry = findInstalledEntry(meta);
      if (!entry) {
        // installedFiles is only present on schemaVersion 3+ consumer installs.
        // Kit source repos do not carry this — treat as informational skip for that case.
        const hasInstalledFiles = meta && Array.isArray(meta.installedFiles);
        if (!hasInstalledFiles) {
          emit('SKIP', 'metadata.json has no installedFiles[] (kit source repo or pre-v3 install) — ownership invariant not applicable');
          process.exit(0);
        }
        issues.push(`metadata.json.installedFiles[] does not list ${STATUSLINE_REL} — run \`t1k update\` to sync`);
      } else {
        if (entry.ownership !== EXPECTED_OWNERSHIP) {
          issues.push(`${STATUSLINE_REL} ownership is "${entry.ownership}", expected "${EXPECTED_OWNERSHIP}" — run \`t1k update\` to reclaim ownership`);
        }
        if (entry.moduleName !== EXPECTED_MODULE) {
          issues.push(`${STATUSLINE_REL} moduleName is "${entry.moduleName}", expected "${EXPECTED_MODULE}" — run \`t1k update\` to reclaim ownership`);
        }
      }
    }
  }

  // 3. settings.json statusLine block wired to hook-runner.cjs statusline
  const settingsPath = path.join(claudeDir, 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    issues.push(`missing settings.json under ${claudeDir}`);
  } else {
    const settings = readJson(settingsPath);
    if (settings._error) {
      issues.push(`settings.json parse error: ${settings._error}`);
    } else if (!statusLineCommandHasTokens(settings)) {
      issues.push('settings.json.statusLine is missing or does not reference hook-runner.cjs statusline — run `t1k update` to remerge settings');
    }
  }

  // 4. hook-runner.cjs exists (dispatch target)
  const hookRunnerPath = path.join(claudeDir, HOOK_RUNNER_REL);
  if (!fs.existsSync(hookRunnerPath)) {
    issues.push(`missing ${HOOK_RUNNER_REL} under ${claudeDir} — hooks dispatcher absent, reinstall kit`);
  }

  if (issues.length === 0) {
    emit('PASS', 'statusline wired end-to-end');
    process.exit(0);
  }

  emit('FAIL', `${issues.length} issue(s)`);
  for (const msg of issues) {
    process.stdout.write(`       - ${msg}\n`);
  }
  process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
}

try {
  run();
} catch (err) {
  emit('SKIP', `unexpected error: ${err.message}`);
  process.exit(0);
}
