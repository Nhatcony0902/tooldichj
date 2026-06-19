// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * kit-error-dedup.cjs — Fingerprint + TTL cache for auto-submitted issues.
 *
 * Cache lives at ~/.claude/.kit-error-fingerprints.json (global, survives per-project).
 * Same fingerprint within 7 days → treated as duplicate, submission skipped.
 *
 * Fail-open: corrupted cache → reset and treat as first-seen.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { safeResolve, SafePathError } = require('./safe-paths.cjs');

const DEFAULT_MAX_AGE_DAYS = 7;
const CACHE_FILENAME = '.kit-error-fingerprints.json';

/**
 * Resolve the fingerprint cache path. Override via env var for testing.
 * safeResolve validates the env-var-supplied path against allowed roots (home + tmpdir)
 * to prevent .envrc-injected path traversal or symlink escape.
 * Falls back to the default path on rejection (fail-open).
 */
function cachePath() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  const defaultPath = path.join(home, '.claude', CACHE_FILENAME);
  const envPath = process.env.T1K_KIT_ERROR_CACHE_PATH;
  if (!envPath) return defaultPath;
  try {
    return safeResolve(envPath, [os.homedir(), os.tmpdir()]);
  } catch (e) {
    if (e instanceof SafePathError) return defaultPath; // reject unsafe override, use default
    throw e;
  }
}

/**
 * Load cache from disk. Returns empty structure on any error.
 */
function loadCache() {
  try {
    const p = cachePath();
    if (!fs.existsSync(p)) return { version: 1, entries: {} };
    const raw = fs.readFileSync(p, 'utf8');
    if (!raw.trim()) return { version: 1, entries: {} };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !parsed.entries) {
      return { version: 1, entries: {} };
    }
    return parsed;
  } catch {
    return { version: 1, entries: {} };
  }
}

/**
 * Persist cache to disk. Fail-open on write errors.
 */
function saveCache(cache) {
  try {
    const p = cachePath();
    const dir = path.dirname(p);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cache, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

/**
 * Compute a stable fingerprint from sanitized payload + classification.
 * Uses MD5 (16 hex chars) — we want deterministic, not cryptographic strength.
 * @param {{ stderrHead?: string, cmd?: string, tool?: string }} payload
 * @param {{ reason?: string, originKit?: string }} classification
 * @returns {string}
 */
function fingerprint(payload, classification) {
  const parts = [
    payload?.tool || '',
    payload?.cmd || '',
    payload?.stderrHead || '',
    classification?.reason || '',
    classification?.originKit || '',
  ];
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 16);
}

/**
 * Remove cache entries older than maxAgeDays. Mutates and returns the cache.
 */
function pruneCache(cache, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  if (!cache || !cache.entries) return { version: 1, entries: {} };
  for (const [fp, entry] of Object.entries(cache.entries)) {
    const last = entry.lastSeen ? new Date(entry.lastSeen).getTime() : 0;
    if (last < cutoff) delete cache.entries[fp];
  }
  return cache;
}

/**
 * Check whether a fingerprint has been seen within the TTL window.
 * Records the occurrence regardless (count bumps, lastSeen updates).
 *
 * @param {string} fp
 * @param {{ maxAgeDays?: number, reason?: string, originKit?: string }} [opts]
 * @returns {{ isDuplicate: boolean, count: number, submittedBefore: boolean, issueUrl: string|null }}
 */
function checkAndRecord(fp, opts = {}) {
  const maxAgeDays = opts.maxAgeDays || DEFAULT_MAX_AGE_DAYS;
  try {
    let cache = loadCache();
    cache = pruneCache(cache, maxAgeDays);

    const now = new Date().toISOString();
    const existing = cache.entries[fp];
    let isDuplicate = false;
    let count = 1;
    let submittedBefore = false;
    let issueUrl = null;

    if (existing) {
      isDuplicate = true;
      count = (existing.count || 0) + 1;
      submittedBefore = Boolean(existing.submitted);
      issueUrl = existing.issueUrl || null;
      existing.lastSeen = now;
      existing.count = count;
    } else {
      cache.entries[fp] = {
        firstSeen: now,
        lastSeen: now,
        count: 1,
        reason: opts.reason || null,
        originKit: opts.originKit || null,
        submitted: false,
        issueUrl: null,
      };
    }

    saveCache(cache);
    return { isDuplicate, count, submittedBefore, issueUrl };
  } catch {
    return { isDuplicate: false, count: 1, submittedBefore: false, issueUrl: null };
  }
}

/**
 * Mark a fingerprint as successfully submitted to GitHub.
 */
function markSubmitted(fp, issueUrl) {
  try {
    const cache = loadCache();
    if (!cache.entries[fp]) {
      cache.entries[fp] = {
        firstSeen: new Date().toISOString(),
        lastSeen: new Date().toISOString(),
        count: 1,
        reason: null,
        originKit: null,
      };
    }
    cache.entries[fp].submitted = true;
    cache.entries[fp].issueUrl = issueUrl || null;
    cache.entries[fp].lastSeen = new Date().toISOString();
    return saveCache(cache);
  } catch {
    return false;
  }
}

/**
 * Clear the entire cache (for testing).
 */
function clearCache() {
  try {
    const p = cachePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  fingerprint,
  checkAndRecord,
  markSubmitted,
  pruneCache,
  clearCache,
  _cachePath: cachePath,
  _loadCache: loadCache,
  _saveCache: saveCache,
};
