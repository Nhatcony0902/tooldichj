// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * safe-paths.cjs — Path traversal / symlink-escape guard for T1K hooks.
 *
 * Exported helper:
 *   safeResolve(input, allowedRoots) → absolute path (throws SafePathError on rejection)
 *
 * Design notes:
 *   - Q1 decision (t1k-architecture-260427-1137-decisions.md): P1 (transcript_path) and
 *     P2 (env-var cache overrides) are collapsed into one helper to eliminate duplication.
 *   - For transcript_path the allowed roots are os.tmpdir() + os.homedir() — the harness
 *     writes transcripts under one of these on all platforms. This is a defense-in-depth
 *     check, not a strict allow-list; the realpath re-check defeats symlink escape.
 *   - For env-var cache paths, the allowed roots are os.homedir() + os.tmpdir() — test
 *     overrides use tmpdir, production cache lives in homedir.
 */
'use strict';

const fs = require('fs');
const path = require('path');

class SafePathError extends Error {
  constructor(message) {
    super(message);
    this.name = 'SafePathError';
  }
}

/**
 * Walk up the path until we find the deepest ancestor that exists on disk.
 * @param {string} p — absolute path
 * @returns {string} deepest existing ancestor (may be p itself)
 */
function deepestExistingAncestor(p) {
  let current = p;
  while (current && current !== path.dirname(current)) {
    if (fs.existsSync(current)) return current;
    current = path.dirname(current);
  }
  // Fallback: filesystem root always exists
  return current || '/';
}

/**
 * Check whether `p` starts with at least one root in `allowedRoots`.
 * Requires a path separator boundary to prevent prefix collisions
 * (e.g. /home/alice should not be matched by root /home/al).
 * @param {string} p — absolute resolved path
 * @param {string[]} allowedRoots — array of absolute root paths
 * @returns {boolean}
 */
function isUnderAllowedRoot(p, allowedRoots) {
  const sep = path.sep;
  return allowedRoots.some(root => {
    const normalRoot = root.endsWith(sep) ? root : root + sep;
    return p === root || p.startsWith(normalRoot);
  });
}

/**
 * Compute the canonical real paths for a set of allowed roots.
 * On macOS, os.tmpdir() returns /var/folders/... which is a symlink to
 * /private/var/folders/... — we must accept BOTH forms.
 * @param {string[]} allowedRoots
 * @returns {string[]} deduplicated union of original + realpaths
 */
function canonicalRoots(allowedRoots) {
  const set = new Set(allowedRoots);
  for (const r of allowedRoots) {
    try { set.add(fs.realpathSync(r)); } catch { /* root may not exist — ignore */ }
  }
  return Array.from(set);
}

/**
 * Resolve and validate a file path against a set of allowed roots.
 *
 * Security layers:
 *   1. Reject empty/non-string input.
 *   2. path.resolve(input) → absolute path (defeats `..` traversal from CWD).
 *   3. Verify resolved path starts under at least one allowedRoot (logical form).
 *   4. Walk up to deepest existing ancestor, fs.realpathSync it, re-check root
 *      membership against canonical roots (defeats symlink escape: /allowed/link → /etc).
 *      On macOS, os.tmpdir() is itself a symlink — canonical roots include both
 *      the logical path and its realpath so legitimate tmpdir paths are accepted.
 *
 * @param {string} input — raw path (relative or absolute)
 * @param {string[]} allowedRoots — absolute paths that are permitted parents
 * @returns {string} resolved absolute path
 * @throws {SafePathError} if input is invalid or escapes allowed roots
 */
function safeResolve(input, allowedRoots) {
  if (!input || typeof input !== 'string') {
    throw new SafePathError(`safeResolve: input must be a non-empty string, got ${typeof input}`);
  }
  if (!Array.isArray(allowedRoots) || allowedRoots.length === 0) {
    throw new SafePathError('safeResolve: allowedRoots must be a non-empty array');
  }

  // Include both logical and real forms of allowed roots to handle OS-level symlinks
  const roots = canonicalRoots(allowedRoots);

  // Layer 2: resolve to absolute (defeats `..` traversal)
  const resolved = path.resolve(input);

  // Layer 3: prefix check on the logical path (using expanded roots)
  if (!isUnderAllowedRoot(resolved, roots)) {
    throw new SafePathError(
      `safeResolve: '${resolved}' is not under any allowed root: [${allowedRoots.join(', ')}]`
    );
  }

  // Layer 4: realpath check on deepest existing ancestor (defeats symlink escape)
  const ancestor = deepestExistingAncestor(resolved);
  let realAncestor;
  try {
    realAncestor = fs.realpathSync(ancestor);
  } catch {
    // realpathSync failed — treat as suspicious and reject
    throw new SafePathError(
      `safeResolve: could not resolve real path of '${ancestor}' — symlink check failed`
    );
  }

  // Reconstruct the full real path by appending the remaining suffix
  const suffix = resolved.slice(ancestor.length);
  const realResolved = realAncestor + suffix;

  if (!isUnderAllowedRoot(realResolved, roots)) {
    throw new SafePathError(
      `safeResolve: real path '${realResolved}' escapes allowed roots — possible symlink escape`
    );
  }

  return resolved;
}

module.exports = { safeResolve, SafePathError };
