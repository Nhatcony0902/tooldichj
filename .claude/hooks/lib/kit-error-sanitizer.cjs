// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * kit-error-sanitizer.cjs — Strip secrets, env vars, and user paths from tool errors.
 *
 * Pure function: sanitize(rawPayload) → safePayload. No I/O.
 * Runs BEFORE fingerprinting so identical secrets produce identical fingerprints.
 *
 * Reuses SENSITIVE_PATTERNS from telemetry-utils.cjs (SSOT with privacy-guard/secret-guard).
 */
'use strict';

const path = require('path');
const os = require('os');
const { SENSITIVE_PATTERNS, SECRET_TOKEN_PATTERNS } = require('../telemetry-utils.cjs');

// Secret patterns: known token/key formats seen in error logs and stack traces.
// Specific patterns from telemetry-utils SSOT are spread FIRST so they win against
// generic prefixes (e.g. sk-ant-... must redact to 'sk-ant-***' before the generic
// /sk-.../ pattern below would mask it to 'sk-***' and lose the 'ant-' marker).
const SECRET_PATTERNS = [
  ...SECRET_TOKEN_PATTERNS,
  { re: /sk-[A-Za-z0-9_\-]{20,}/g, replace: 'sk-***' },
  { re: /ghp_[A-Za-z0-9]{20,}/g, replace: 'ghp_***' },
  { re: /gho_[A-Za-z0-9]{20,}/g, replace: 'gho_***' },
  { re: /ghs_[A-Za-z0-9]{20,}/g, replace: 'ghs_***' },
  { re: /github_pat_[A-Za-z0-9_]{20,}/g, replace: 'github_pat_***' },
  { re: /AKIA[A-Z0-9]{16}/g, replace: 'AKIA***' },
  { re: /Bearer\s+[A-Za-z0-9._\-]{20,}/gi, replace: 'Bearer ***' },
  { re: /(password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*\S+/gi, replace: '$1=***' },
  // JWT tokens (3 base64url segments separated by dots)
  { re: /eyJ[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+\.[A-Za-z0-9_\-]+/g, replace: 'JWT_***' },
];

/**
 * Replace absolute user paths with ~ or project-relative paths.
 * @param {string} str
 * @param {string} home
 * @param {string} cwd
 * @returns {string}
 */
function stripUserPaths(str, home, cwd) {
  if (!str || typeof str !== 'string') return '';
  let out = str;
  if (cwd && out.includes(cwd)) {
    // Replace cwd with "." but keep the trailing path segment
    out = out.split(cwd).join('.');
  }
  if (home && out.includes(home)) {
    out = out.split(home).join('~');
  }
  // Strip Windows-style user paths too
  out = out.replace(/C:\\Users\\[^\\/\s"']+/gi, '~');
  return out;
}

/**
 * Strip env var assignments (KEY=value → KEY=***) in command strings.
 * Only touches sequences that look like env exports, not JSON fields.
 */
function stripEnvVars(str) {
  if (!str || typeof str !== 'string') return '';
  // Match shell env assignment: word followed by = followed by non-whitespace
  // Conservative: only replace when preceded by whitespace or start-of-string
  return str.replace(/(^|\s)([A-Z][A-Z0-9_]{2,})=(\S+)/g, '$1$2=***');
}

/**
 * Apply all known secret pattern replacements.
 */
function stripSecrets(str) {
  if (!str || typeof str !== 'string') return '';
  let out = str;
  for (const { re, replace } of SECRET_PATTERNS) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * Scan a string for sensitive file paths and replace them with a marker.
 */
function stripSensitiveFilePaths(str) {
  if (!str || typeof str !== 'string') return '';
  // Extract path-like tokens and check each against SENSITIVE_PATTERNS
  return str.replace(/(["']?)([~.]?[\/\\][\w\/\\.\-]+)(["']?)/g, (match, q1, filePath, q2) => {
    for (const pattern of SENSITIVE_PATTERNS) {
      if (pattern.test(filePath)) {
        return `${q1}[REDACTED_SENSITIVE_FILE]${q2}`;
      }
    }
    return match;
  });
}

/**
 * Extract meaningful error lines from a tool result string.
 * Returns up to 3 lines matching error keywords, each capped at 200 chars.
 */
function extractErrorLines(str) {
  if (!str || typeof str !== 'string') return [];
  return str.split('\n')
    .filter(l => /error|fail|cannot|exception|TypeError|SyntaxError|ENOENT/i.test(l))
    .slice(0, 3)
    .map(l => l.trim().substring(0, 200))
    .filter(Boolean);
}

/**
 * Coerce any value to a string safely.
 */
function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return String(v); }
}

/**
 * Pure sanitization function.
 * @param {object} args
 * @param {string} [args.toolName]
 * @param {object|string} [args.toolInput]
 * @param {object|string} [args.toolResult]
 * @param {string} [args.cwd]
 * @param {string} [args.home]
 * @returns {{ cmd: string, stderrHead: string, filesMentioned: string[], tool: string }}
 */
function sanitize(args = {}) {
  const { toolName, toolInput, toolResult, cwd, home } = args || {};
  const userHome = home || os.homedir() || '';
  const workDir = cwd || '';

  // Extract command string (Bash → toolInput.command, others → stringified input)
  let rawCmd = '';
  if (toolInput && typeof toolInput === 'object' && toolInput.command) {
    rawCmd = String(toolInput.command);
  } else if (typeof toolInput === 'string') {
    rawCmd = toolInput;
  } else if (toolInput) {
    try { rawCmd = JSON.stringify(toolInput).substring(0, 500); } catch { rawCmd = ''; }
  }

  // Sanitize the command through the full pipeline
  let cmd = rawCmd;
  cmd = stripUserPaths(cmd, userHome, workDir);
  cmd = stripEnvVars(cmd);
  cmd = stripSecrets(cmd);
  cmd = stripSensitiveFilePaths(cmd);
  cmd = cmd.substring(0, 200);

  // Sanitize the tool result
  const rawResult = toStr(toolResult);
  let cleanResult = rawResult;
  cleanResult = stripUserPaths(cleanResult, userHome, workDir);
  cleanResult = stripEnvVars(cleanResult);
  cleanResult = stripSecrets(cleanResult);
  cleanResult = stripSensitiveFilePaths(cleanResult);

  const errorLines = extractErrorLines(cleanResult);
  const stderrHead = (errorLines.join(' | ') || cleanResult.substring(0, 200)).substring(0, 200);

  // Extract file paths mentioned in the (already sanitized) result
  const filesMentioned = [];
  const filePattern = /([.~]?\/[\w\/\-.]+\.\w{1,6})/g;
  let match;
  let safety = 0;
  while ((match = filePattern.exec(cleanResult)) !== null && safety++ < 50) {
    const p = match[1];
    if (p.length < 200 && !filesMentioned.includes(p)) filesMentioned.push(p);
  }

  return {
    cmd,
    stderrHead,
    filesMentioned: filesMentioned.slice(0, 10),
    tool: toolName || 'unknown',
  };
}

module.exports = {
  sanitize,
  // Exposed for unit testing only
  _stripUserPaths: stripUserPaths,
  _stripEnvVars: stripEnvVars,
  _stripSecrets: stripSecrets,
  _stripSensitiveFilePaths: stripSensitiveFilePaths,
  _extractErrorLines: extractErrorLines,
};
