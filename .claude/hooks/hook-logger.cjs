#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * hook-logger.cjs — Structured JSON logger for hook diagnostics
 *
 * Logs to .claude/telemetry/hook-log-{YYYY-MM-DD}.jsonl (daily rotation, JSON Lines).
 * File locking via 'wx' flag + lock file to prevent concurrent write corruption.
 * Rotation: >1000 lines → keep last 500.
 *
 * Exports: logHook, createHookTimer, logHookCrash, read
 * Backwards-compat: log(entry) → logHook(entry.hook || 'unknown', entry)
 *
 * Feature flag: features.hookLogging in t1k-config-core.json (default: true).
 * If flag is false → all exports become no-ops.
 *
 * Zero external dependencies: fs, path, crypto, os only.
 * Cross-platform: path.join, os.tmpdir(), fs.existsSync — no /tmp, no /dev/stdin.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const MAX_LINES = 1000;
const KEEP_LINES = 500;
const LOCK_TIMEOUT_MS = 250;
const LOCK_RETRY_MS = 10;

// ── Resolve .claude directory ─────────────────────────────────────────────────

let _claudeDir = null;
function getClaudeDir() {
  if (_claudeDir) return _claudeDir;
  try {
    const utils = require('./telemetry-utils.cjs');
    const resolved = utils.resolveClaudeDir && utils.resolveClaudeDir();
    if (resolved && resolved.claudeDir) {
      _claudeDir = resolved.claudeDir;
      return _claudeDir;
    }
  } catch { /* fall through */ }
  // Fallback: __dirname is .claude/hooks/ → parent is .claude/
  _claudeDir = path.resolve(__dirname, '..');
  return _claudeDir;
}

// ── Feature flag (read once at module load, fail-closed) ─────────────────────

let _loggingEnabled = true;
(function loadFeatureFlag() {
  try {
    const claudeDir = getClaudeDir();
    const files = fs.readdirSync(claudeDir).filter(f => f.startsWith('t1k-config-') && f.endsWith('.json'));
    for (const f of files) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        if (cfg && cfg.features && cfg.features.hookLogging === false) {
          _loggingEnabled = false;
          return;
        }
      } catch { /* skip malformed */ }
    }
  } catch {
    // fail-closed: if we cannot read config, disable logging to be safe
    _loggingEnabled = false;
  }
})();

// ── Log path helpers ──────────────────────────────────────────────────────────

function getTelemetryDir() {
  return path.join(getClaudeDir(), 'telemetry');
}

function getLogFile() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(getTelemetryDir(), `hook-log-${date}.jsonl`);
}

function getLockFile() {
  return path.join(getTelemetryDir(), 'hook-log.lock');
}

// ── Low-level helpers ─────────────────────────────────────────────────────────

function ensureTelemetryDir() {
  try {
    const dir = getTelemetryDir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch { /* fail-silent */ }
}

/** Busy-wait (cross-platform, no Atomics.wait requirement). */
function sleep(ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) { /* spin */ }
}

/** Acquire lock file, run fn(), then release. Returns null on timeout. Fail-silent. */
function withLock(fn) {
  ensureTelemetryDir();
  const lockFile = getLockFile();
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  while (Date.now() < deadline) {
    let fd;
    try {
      fd = fs.openSync(lockFile, 'wx'); // EEXIST if already locked
      try {
        return fn();
      } finally {
        try { fs.closeSync(fd); } catch { /* ok */ }
        try { fs.unlinkSync(lockFile); } catch { /* ok */ }
      }
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return null; // unexpected error → bail
      sleep(LOCK_RETRY_MS);
    }
  }
  return null; // timed out
}

/** Rotate log if over MAX_LINES — called inside the lock. */
function rotateIfNeeded(logFile) {
  try {
    if (!fs.existsSync(logFile)) return;
    const raw = fs.readFileSync(logFile, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    if (lines.length >= MAX_LINES) {
      fs.writeFileSync(logFile, lines.slice(-KEEP_LINES).join('\n') + '\n', 'utf8');
    }
  } catch { /* fail-silent */ }
}

// ── Core write function ───────────────────────────────────────────────────────

function writeEntry(entry) {
  if (!_loggingEnabled) return;
  try {
    const logFile = getLogFile();
    const serialized = JSON.stringify(entry) + '\n';
    const wrote = withLock(() => {
      fs.appendFileSync(logFile, serialized, 'utf8');
      rotateIfNeeded(logFile);
      return true;
    });
    // Lock timed out — write anyway without lock (better a slightly inconsistent file than lost data)
    if (wrote === null) {
      try { fs.appendFileSync(logFile, serialized, 'utf8'); } catch { /* fail-silent */ }
    }
  } catch { /* fail-silent — never crash a hook */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Log a hook event.
 * @param {string} hookName - Hook name (e.g. 'privacy-guard')
 * @param {object} data - Arbitrary fields merged into the log entry
 */
function logHook(hookName, data) {
  if (!_loggingEnabled) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      hook: String(hookName || 'unknown'),
      ...data,
    };
    writeEntry(entry);
  } catch { /* fail-silent */ }
}

/**
 * Create a duration timer. Call timer.end(extraData) to log with duration.
 * @param {string} hookName
 * @param {object} [baseData] - Fields included in the end() log entry
 * @returns {{ end: (data?: object) => void }}
 */
function createHookTimer(hookName, baseData) {
  if (!_loggingEnabled) return { end: function() {} };
  const start = Date.now();
  let ended = false;
  return {
    end: function(data) {
      if (ended) return;
      ended = true;
      try {
        const durationMs = Date.now() - start;
        logHook(hookName, Object.assign({}, baseData || {}, data || {}, { durationMs: durationMs }));
      } catch { /* fail-silent */ }
    }
  };
}

/**
 * Log a hook crash with error details.
 * @param {string} hookName
 * @param {unknown} error
 * @param {object} [data]
 */
function logHookCrash(hookName, error, data) {
  if (!_loggingEnabled) return;
  try {
    const errMsg = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : String(error || 'unknown error');
    const errStack = (error instanceof Error && error.stack)
      ? error.stack.split('\n').slice(0, 5).join(' | ')
      : '';
    logHook(hookName, Object.assign({}, data || {}, {
      crash: true,
      errMsg: errMsg,
      errStack: errStack,
    }));
  } catch { /* fail-silent */ }
}

/**
 * Read last N entries from today's log file. Used by /t1k:watzup.
 * @param {number} [n=50]
 * @returns {object[]}
 */
function read(n) {
  if (n === undefined) n = 50;
  try {
    const logFile = getLogFile();
    if (!fs.existsSync(logFile)) return [];
    const lines = fs.readFileSync(logFile, 'utf8').trim().split('\n');
    return lines.slice(-n).map(function(l) {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/**
 * Backwards-compatible shim: old log(entry) API → logHook(entry.hook || 'unknown', entry)
 * @param {object} entry
 */
function log(entry) {
  try {
    const hookName = (entry && entry.hook) ? String(entry.hook) : 'unknown';
    logHook(hookName, entry || {});
  } catch { /* fail-silent */ }
}

module.exports = {
  logHook,
  createHookTimer,
  logHookCrash,
  read,
  log,
};
