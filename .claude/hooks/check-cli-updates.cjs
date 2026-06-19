#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * check-cli-updates.cjs — Auto-update the TheOneKit CLI binary at session start.
 *
 * Discovery:
 *   Reads cli.repo / cli.npmPackage from t1k-config-*.json (data-driven).
 *
 * Check:
 *   1. Confirms t1k binary is on PATH (skipped if user runs from source).
 *   2. Parses `t1k --version` → current semver.
 *   3. Queries `gh release view --repo <cli-repo>` → latest stable tag.
 *
 * Update:
 *   - Major bump  → notify only, user must run `t1k update` to review.
 *   - Minor/patch → spawn detached `t1k update --yes`, stdout/stderr → log file.
 *   - Current session keeps running the old binary; takes effect next session.
 *
 * Safeguards:
 *   - Opt-out: features.autoUpdate: false  (shared with check-kit-updates.cjs)
 *   - Log:     ~/.claude/.cli-update.log (rolling, capped at ~100KB)
 *   - Coordination: skips if check-kit-updates already spawned `t1k update --yes`
 *   - Self-update guard: skips when CWD git remote matches CLI repo
 *   - Fail-open: any error exits 0 without blocking the session
 *   - Dry-run:  T1K_CLI_UPDATE_NOOP=1 logs intent without spawning update
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const os = require('os');
const LOG_MAX_BYTES = 100 * 1024; // 100KB rolling log
const { isInstallLockHeld, spawnT1kUpdateDetached } = require('./lib/t1k-update-spawn.cjs');
const updateCheckCache = require('./lib/update-check-cache.cjs');

function parseSemver(v) {
  if (!v) return null;
  const m = String(v).trim().match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
  if (!m) return null;
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: Number(m[3]),
    prerelease: m[4] || null,
    raw: `${m[1]}.${m[2]}.${m[3]}${m[4] ? '-' + m[4] : ''}`,
  };
}

function compareSemver(a, b) {
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  // Prerelease < stable (per semver spec)
  if (a.prerelease && !b.prerelease) return -1;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

function findCliBinary() {
  try {
    if (process.platform === 'win32') {
      const out = execFileSync('where', ['t1k'], {
        encoding: 'utf8', timeout: 3000,
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      const lines = out.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      // Prefer Windows-executable shims; bare POSIX shebang files (no extension)
      // cannot be invoked via spawn() without shell:true and return ENOENT.
      const exts = ['.cmd', '.exe', '.bat'];
      return lines.find(p => exts.some(e => p.toLowerCase().endsWith(e))) || lines[0] || null;
    }
    const out = execFileSync('which', ['t1k'], {
      encoding: 'utf8', timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    return out.trim() || null;
  } catch { return null; }
}

function readCliVersion(binary) {
  try {
    const out = execFileSync(binary, ['--version'], {
      encoding: 'utf8', timeout: 5000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    return parseSemver(out);
  } catch { return null; }
}

function getLatestReleaseVersion(repo) {
  try {
    const raw = execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName'], {
      encoding: 'utf8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    const obj = JSON.parse(raw);
    return parseSemver((obj.tagName || '').replace(/^v/, ''));
  } catch { return null; }
}

function readCliConfig(claudeDir, T1K) {
  try {
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const cf of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(claudeDir, cf), 'utf8'));
        if (c.cli?.repo) {
          return { repo: c.cli.repo, npmPackage: c.cli.npmPackage || null };
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return null;
}

// Flag readers are centralized in telemetry-utils.cjs — see readFeatureFlag.

function rotateLog(logPath) {
  try {
    if (!fs.existsSync(logPath)) return;
    const stat = fs.statSync(logPath);
    if (stat.size <= LOG_MAX_BYTES) return;
    const raw = fs.readFileSync(logPath, 'utf8');
    const tail = raw.slice(-Math.floor(LOG_MAX_BYTES / 2));
    fs.writeFileSync(logPath, tail);
  } catch { /* ok */ }
}

function matchesCwdRemote(repo) {
  try {
    const out = execFileSync('git', ['remote', '-v'], {
      encoding: 'utf8', timeout: 3000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    return out.includes(repo);
  } catch { return false; }
}

(function main() {
  try {
    const { T1K, resolveClaudeDir, readFeatureFlag } = require('./telemetry-utils.cjs');
    const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
    const resolved = resolveClaudeDir();
    if (!resolved) return process.exit(0);
    const { claudeDir, home } = resolved;
    const timer = createHookTimer('check-cli-updates');

    if (readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_UPDATE, true) === false) return process.exit(0);

    const cliConfig = readCliConfig(claudeDir, T1K);
    if (!cliConfig) return process.exit(0);

    // Coordination: if check-kit-updates already spawned `t1k update --yes` (which handles
    // both CLI + content), skip CLI-only update to avoid redundant work.
    try {
      const markerPath = path.join(os.tmpdir(), 't1k-update', 'spawned');
      if (fs.existsSync(markerPath)) {
        const stamp = fs.readFileSync(markerPath, 'utf8').trim();
        const age = Date.now() - new Date(stamp).getTime();
        // Marker valid for 60s (both hooks fire within same SessionStart)
        if (Number.isFinite(age) && age >= 0 && age < 60000) {
          logHook('check-cli-updates', { action: 'skip-kit-handled' });
          timer.end({ outcome: 'skip-kit-handled' });
          return process.exit(0);
        }
      }
    } catch { /* marker not found — proceed normally */ }

    // Self-update guard: skip if CWD is the CLI repo itself
    if (matchesCwdRemote(cliConfig.repo)) return process.exit(0);

    const binary = findCliBinary();
    if (!binary) return process.exit(0); // CLI not installed as binary

    const current = readCliVersion(binary);
    if (!current) return process.exit(0);

    const cliNoop = process.env[T1K.ENV.CLI_UPDATE_NOOP] === '1';

    // Refresh cached currentVersion eagerly — independent of network cooldown.
    // Without this, a CLI that was self-updated since the last successful network
    // poll leaves the cache stale, causing require-current-cli to false-block
    // the user with "v<stale> behind v<latest>" even though local is already
    // current. recordCurrentVersion is a local-only operation (no network).
    if (!cliNoop) updateCheckCache.recordCurrentVersion(current.raw);

    // Death-spiral defense: skip the network round-trip if cache says we're in
    // cooldown or backoff. Honors GitHub's 60/h anonymous rate limit.
    if (!cliNoop && !updateCheckCache.shouldRun('cli')) {
      timer.end({ outcome: 'cache-hit', current: current.raw });
      return process.exit(0);
    }

    const latest = getLatestReleaseVersion(cliConfig.repo);
    if (!latest) {
      // Network call failed — record failure to drive backoff curve
      if (!cliNoop) updateCheckCache.recordFailure('cli');
      return process.exit(0);
    }
    // Network call succeeded — record success regardless of whether bump exists
    if (!cliNoop) updateCheckCache.recordSuccess('cli');

    // Also persist the detected versions so PreToolUse guard
    // (require-current-cli.cjs) can compare without re-querying GitHub.
    if (!cliNoop) updateCheckCache.recordCliVersions({ current: current.raw, latest: latest.raw });

    const cmp = compareSemver(current, latest);
    if (cmp >= 0) {
      // No cache — check every session
      return process.exit(0);
    }

    // Major bump → gated by features.autoUpdateMajor (default true)
    const isMajor = latest.major > current.major;
    if (isMajor && readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_UPDATE_MAJOR, true) === false) {
      logHook('check-cli-updates', { current: current.raw, latest: latest.raw, action: 'notify-major' });
      timer.end({ outcome: 'notify-major', current: current.raw, latest: latest.raw });
      console.log(`${T1K.TAGS.CLI_MAJOR} CLI ${current.raw} → ${latest.raw} (major). features.${T1K.FEATURES.AUTO_UPDATE_MAJOR} is false — run 't1k update' manually to review breaking changes.`);
      // No cache — check every session
      return process.exit(0);
    }

    // Minor/patch (or major with autoUpdateMajor:true) → background auto-update
    const logDir = home ? path.join(home, '.claude') : claudeDir;
    const logPath = path.join(logDir, '.cli-update.log');
    rotateLog(logPath);

    // Lock guard: if another session is already running `t1k update`, skip spawn.
    if (isInstallLockHeld()) {
      console.log('[t1k:cli-update] update in progress by peer session — skipping spawn');
      logHook('check-cli-updates', { current: current.raw, latest: latest.raw, action: 'lock-held' });
      timer.end({ outcome: 'lock-held', current: current.raw, latest: latest.raw });
      return process.exit(0);
    }

    // --cli-only flag shipped in CLI 2.5.0 — version-gate to avoid polluting
    // the log with "Unknown option" warnings on older CLIs. Old CLIs will
    // still cascade into the kit update (existing pre-2.5.0 behavior) for
    // one more session, then the new CLI takes over from there.
    const supportsCliOnly =
      current.major > 2 || (current.major === 2 && current.minor >= 5);
    const updateArgs = supportsCliOnly
      ? ['update', '--yes', '--cli-only']
      : ['update', '--yes'];

    const logMarker =
      `\n===== [${new Date().toISOString()}] Auto-update ${current.raw} → ${latest.raw}` +
      `${supportsCliOnly ? ' (--cli-only)' : ' (legacy, cascade enabled)'} =====\n`;
    try { fs.appendFileSync(logPath, logMarker); } catch { /* ok */ }

    const noop = cliNoop;
    let spawnOutcome = { spawned: true };
    if (!noop) {
      spawnOutcome = spawnT1kUpdateDetached({
        binary,
        args: updateArgs,
        logLabel: logPath,
        // No markerTmp here: check-cli-updates does not own the kit-update
        // coordination marker (that is check-kit-updates.cjs responsibility).
        markerTmp: undefined,
      });
    } else {
      try {
        fs.appendFileSync(logPath, `NOOP: would spawn '${binary} ${updateArgs.join(' ')}'\n`);
      } catch { /* ok */ }
    }

    // Banner tag contract (Phase 02 of 260418-1942-t1k-ecosystem-fixes):
    //   SUCCESS → T1K.TAGS.CLI_UPDATE  (spawn succeeded OR noop dry-run)
    //   FAILURE → T1K.TAGS.UPDATE_FAILED (spawn itself failed — e.g. EACCES)
    // Log parsers MUST distinguish outcomes by tag alone.
    if (!spawnOutcome.spawned) {
      const reason = (spawnOutcome.error && spawnOutcome.error.message) ? spawnOutcome.error.message : 'unknown';
      console.log(`${T1K.TAGS.UPDATE_FAILED} FAILED to spawn CLI auto-update (${current.raw} → ${latest.raw}): ${reason} — see ${logPath}`);
    } else {
      const suffix = noop ? ' (NOOP — no spawn)' : ' — restart your shell after it finishes';
      const majorTag = isMajor ? ' (major)' : '';
      console.log(`${T1K.TAGS.CLI_UPDATE} CLI ${current.raw} → ${latest.raw}${majorTag} updating in background${suffix}. Log: ${logPath}`);
    }

    logHook('check-cli-updates', { current: current.raw, latest: latest.raw, action: noop ? 'update-noop' : 'update-background' });
    timer.end({ outcome: 'update', current: current.raw, latest: latest.raw });

    process.exit(0);
  } catch (err) {
    try { require('./hook-logger.cjs').logHookCrash('check-cli-updates', err); } catch { /* ok */ }
    process.exit(0); // fail-open — never block the session
  }
})();
