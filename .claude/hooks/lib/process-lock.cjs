// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * process-lock.cjs — Cross-platform exclusive-process lock for t1k diagram commands.
 * Lock file: { pid, command, acquiredAt, host }. Acquire is atomic via O_EXCL (flag 'wx').
 * Stale-lock recovery: if PID is not alive, reclaim with a warning.
 * Cross-platform: process.kill(pid, 0) works on Windows (EPERM = alive, different user).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 min per H8
const DEFAULT_POLL_INTERVAL_MS = 200;

// ── Custom errors ──────────────────────────────────────────────────────────

class LockTimeoutError extends Error {
  constructor(lockPath, timeoutMs, holderPid, holderCommand) {
    super(
      `Lock timeout after ${timeoutMs}ms at ${lockPath}. ` +
      `Holder: PID ${holderPid} (${holderCommand || 'unknown'}). ` +
      `Delete the lock file to recover.`
    );
    this.name = 'LockTimeoutError';
    this.lockPath = lockPath;
    this.timeoutMs = timeoutMs;
    this.holderPid = holderPid;
    this.holderCommand = holderCommand;
  }
}

class LockStalenessError extends Error {
  constructor(lockPath, reason) {
    super(`Stale lock at ${lockPath}: ${reason}`);
    this.name = 'LockStalenessError';
    this.lockPath = lockPath;
  }
}

// ── Internal helpers ───────────────────────────────────────────────────────

function validateLockPath(lockPath) {
  // Split on both / and \ to catch traversal sequences in the raw path
  const parts = lockPath.split(/[/\\]/);
  if (parts.includes('..')) {
    throw new Error(`Lock path rejected — path traversal: ${lockPath}`);
  }
}

/** Returns true if PID is alive. Windows EPERM = alive (different user). */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM'; // EPERM = exists, ESRCH = dead
  }
}

/** Read lock file. Returns null on missing, unreadable, or corrupt JSON. */
function readLockFile(lockPath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || typeof parsed.pid !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Atomic acquire via O_EXCL. Returns true on success, false if EEXIST.
 * Throws on other errors (EACCES, ENOENT = missing parent dir, etc.).
 */
function tryWriteLock(lockPath, command) {
  const content = JSON.stringify({
    pid: process.pid,
    command: command || 't1k diagram',
    acquiredAt: new Date().toISOString(),
    host: os.hostname(),
  });
  try {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, content);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    if (err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Delete lock file only if this process owns it. No-op + warning otherwise. */
function releaseLockFile(lockPath) {
  const entry = readLockFile(lockPath);
  if (!entry) return;
  if (entry.pid !== process.pid) {
    process.stderr.write(`[t1k process-lock] WARNING: release skipped — owned by PID ${entry.pid}\n`);
    return;
  }
  try { fs.unlinkSync(lockPath); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Acquire an exclusive process lock.
 * @param {string} lockPath - Absolute path to lock file.
 * @param {{ timeout?: number, staleRecovery?: boolean, pollInterval?: number, command?: string }} [opts]
 * @returns {Promise<{ release: Function, acquiredAt: Date, holderPid: number }>}
 * @throws {LockTimeoutError} if timeout expires with lock held by alive process
 */
async function acquireLock(lockPath, opts = {}) {
  const timeout = opts.timeout !== undefined ? opts.timeout : DEFAULT_TIMEOUT_MS;
  const staleRecovery = opts.staleRecovery !== false;
  const pollInterval = opts.pollInterval !== undefined ? opts.pollInterval : DEFAULT_POLL_INTERVAL_MS;
  const command = opts.command || 't1k diagram';

  validateLockPath(lockPath);

  const deadline = Date.now() + timeout;
  const removeHandlers = [];
  const doRelease = () => {
    removeHandlers.forEach(fn => { try { fn(); } catch { /* ignore */ } });
    releaseLockFile(lockPath);
  };

  // Register OS signal handlers to release lock on unexpected exit
  const onExit = () => { try { releaseLockFile(lockPath); } catch { /* best-effort */ } };
  process.once('SIGINT', onExit);
  process.once('SIGTERM', onExit);
  process.once('uncaughtException', onExit);
  removeHandlers.push(() => {
    process.removeListener('SIGINT', onExit);
    process.removeListener('SIGTERM', onExit);
    process.removeListener('uncaughtException', onExit);
  });

  while (true) {
    if (tryWriteLock(lockPath, command)) {
      return { release: doRelease, acquiredAt: new Date(), holderPid: process.pid };
    }

    const entry = readLockFile(lockPath);

    // Corrupted lock → treat as stale and reclaim
    if (!entry) {
      if (staleRecovery) {
        process.stderr.write(`[t1k process-lock] WARNING: corrupted lock at ${lockPath} — reclaiming.\n`);
        try { fs.unlinkSync(lockPath); } catch { /* ignore */ }
        continue;
      }
    } else if (staleRecovery && !isPidAlive(entry.pid)) {
      process.stderr.write(`[t1k process-lock] WARNING: stale lock (PID ${entry.pid} not running) — reclaiming.\n`);
      try { fs.unlinkSync(lockPath); } catch { /* ignore race */ }
      continue;
    }

    if (Date.now() >= deadline) {
      removeHandlers.forEach(fn => { try { fn(); } catch { /* ignore */ } });
      throw new LockTimeoutError(lockPath, timeout, entry ? entry.pid : -1, entry ? entry.command : 'unknown');
    }

    await new Promise(resolve => setTimeout(resolve, pollInterval));
  }
}

/**
 * Check if the lock is currently held (without acquiring).
 * @param {string} lockPath
 * @returns {boolean}
 */
function isLocked(lockPath) {
  validateLockPath(lockPath);
  const entry = readLockFile(lockPath);
  return !!entry && isPidAlive(entry.pid);
}

/**
 * Force-release the lock regardless of owner. For testing and documented recovery ONLY.
 * @param {string} lockPath
 */
function forceReleaseLock(lockPath) {
  validateLockPath(lockPath);
  const entry = readLockFile(lockPath);
  if (entry && entry.pid !== process.pid && isPidAlive(entry.pid)) {
    process.stderr.write(
      `[t1k process-lock] WARNING: force-releasing lock held by alive PID ${entry.pid}. Testing/recovery only.\n`
    );
  }
  try { fs.unlinkSync(lockPath); } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

module.exports = { acquireLock, isLocked, forceReleaseLock, LockTimeoutError, LockStalenessError };
