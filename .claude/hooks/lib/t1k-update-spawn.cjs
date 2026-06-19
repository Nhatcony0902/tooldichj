#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * t1k-update-spawn.cjs — Shared helpers for detached `t1k update` spawning.
 *
 * Exports:
 *   isInstallLockHeld(staleMinutes?)  — true when ~/.t1k/locks/kit-install.lock.lock/ exists and is fresh
 *   spawnT1kUpdateDetached(opts)      — cross-platform detached spawn with log fd + marker-before-spawn
 *
 * Cross-platform: no /dev/stdin, no 2>/dev/null. Uses path.join, os.homedir, os.tmpdir.
 */

'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { spawn } = require('child_process');

// ── Lock path ────────────────────────────────────────────────────────────────

/**
 * Returns the path to the lock directory.
 * The lock is a directory (`mkdir` is atomic on all platforms).
 * Path: ~/.t1k/locks/kit-install.lock.lock/
 */
function lockDir() {
  return path.join(os.homedir(), '.t1k', 'locks', 'kit-install.lock.lock');
}

// ── isInstallLockHeld ─────────────────────────────────────────────────────────

/**
 * Returns true when the kit-install lock directory exists and its mtime is
 * within the staleMinutes window (default 10 min).
 *
 * Staleness rule: if the lock is older than staleMinutes it is considered
 * abandoned (e.g. a crashed previous session) — treat as NOT held.
 *
 * @param {number} [staleMinutes=10]
 * @returns {boolean}
 */
function isInstallLockHeld(staleMinutes) {
  if (staleMinutes === undefined) staleMinutes = 10;
  const dir = lockDir();
  let stat;
  try {
    stat = fs.statSync(dir);
  } catch {
    return false; // directory absent → not held
  }
  if (!stat.isDirectory()) return false;
  const ageMs = Date.now() - stat.mtimeMs;
  return ageMs >= 0 && ageMs < staleMinutes * 60 * 1000;
}

// ── spawnT1kUpdateDetached ────────────────────────────────────────────────────

/**
 * Spawn `t1k <args>` detached with stdio redirected to logLabel (append fd).
 * Writes markerTmp BEFORE spawning so that even if the child crashes the
 * coordination marker is present (prevents replay loop on failure).
 *
 * Since Phase 02 (260418-1942-t1k-ecosystem-fixes), the child is actually
 * `node t1k-update-runner.cjs <binary> <...args>` — the runner captures the
 * real exit code + file-change snapshot into .kit-update.status so the NEXT
 * SessionStart can surface "PREV RUN FAILED" banners. The runner exit code
 * mirrors the t1k binary's exit code (Chrome/VSCode auto-update model).
 *
 * @param {object} opts
 * @param {string}   opts.binary      — absolute path to the t1k binary
 * @param {string[]} opts.args        — CLI args, e.g. ['modules', 'update', '--yes']
 * @param {string}   opts.logLabel    — path to the log file (opened in append mode)
 * @param {string}   [opts.markerTmp] — path to write coordination marker (optional)
 * @param {object}   [opts.env]       — process env overrides (merged on top of process.env)
 * @param {string}   [opts.cwd]       — working directory for the spawned child (default: process.cwd())
 * @returns {{ spawned: boolean, error?: Error }}
 */
function spawnT1kUpdateDetached({ binary, args, logLabel, markerTmp, env, cwd }) {
  // Write coordination marker BEFORE spawn (fix: prevents replay loop if child crashes)
  if (markerTmp) {
    try {
      const markerDir = path.dirname(markerTmp);
      fs.mkdirSync(markerDir, { recursive: true });
      fs.writeFileSync(markerTmp, new Date().toISOString());
    } catch { /* marker write failure is non-fatal */ }
  }

  const spawnEnv = Object.assign({}, process.env, {
    CI: '1',
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM: 'dumb',
  }, env || {});

  let logFd = null;
  try {
    logFd = fs.openSync(logLabel, 'a');
  } catch {
    logFd = null;
  }

  const stdio = logFd !== null
    ? ['ignore', logFd, logFd]
    : ['ignore', 'ignore', 'ignore'];

  // Wrap the t1k binary in the intermediate runner so the exit code + file diff
  // survive the detached parent unref. Args become [runner.cjs, binary, ...args]
  // passed to the `node` executable. `process.execPath` is cross-platform safe
  // and matches the node version already running this hook.
  const runnerPath = path.join(__dirname, 't1k-update-runner.cjs');
  const nodeBin = process.execPath;
  const runnerArgs = [runnerPath, binary, ...args];

  try {
    const spawnOpts = {
      detached: true,
      stdio,
      windowsHide: true,
      env: spawnEnv,
    };
    if (cwd) spawnOpts.cwd = cwd;
    const child = spawn(nodeBin, runnerArgs, spawnOpts);
    child.unref();

    // Close the log fd after a brief delay to allow the child to inherit it.
    // On Windows, immediate close can race with the child's fd inheritance.
    if (logFd !== null) {
      setTimeout(() => { try { fs.closeSync(logFd); } catch { /* ok */ } }, 100);
    }

    return { spawned: true };
  } catch (err) {
    if (logFd !== null) {
      try { fs.closeSync(logFd); } catch { /* ok */ }
    }
    // Append error to log so callers can diagnose without crashing
    if (logLabel) {
      try {
        fs.appendFileSync(logLabel, `Spawn failed: ${err && err.message ? err.message : String(err)}\n`);
      } catch { /* ok */ }
    }
    return { spawned: false, error: err };
  }
}

module.exports = { isInstallLockHeld, spawnT1kUpdateDetached, lockDir };
