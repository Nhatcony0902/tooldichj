#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * t1k-update-runner.cjs — Intermediate wrapper that runs `t1k update --yes`
 * in the background and persists the outcome so the NEXT SessionStart can
 * surface "PREV RUN FAILED" banners (Chrome/VSCode auto-update pattern).
 *
 * Phase 02 of 260418-1942-t1k-ecosystem-fixes. Detached children lose their
 * exit code when the parent unrefs immediately — this wrapper plugs that hole.
 *
 * Invocation (from t1k-update-spawn.cjs):
 *   node /path/to/t1k-update-runner.cjs <binary> <...args>
 *
 * Outputs (all under $HOME/.claude/):
 *   .kit-update.log     — human-readable log with appended `[t1k-update] exit=N ts=ISO` footer
 *   .kit-update.status  — JSON { exitCode, ts, args, filesChanged[], kits[], stderrTail }
 *                         written atomically (tmp + rename). Consumed by Phase 03's
 *                         scope-safety gate (`expectedFiles`) and the PREV RUN FAILED banner.
 *
 * Cross-platform: no /dev/stdin, no `2>/dev/null`, no shell syntax. Uses spawnSync,
 * os.homedir, path.join, process.platform.
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { T1K } = require('../telemetry-utils.cjs');

const DEBUG = process.env.T1K_DEBUG_UPDATE === '1';
const STDERR_TAIL_BYTES = 2 * 1024;

function dbg(msg) {
  if (!DEBUG) return;
  try { process.stderr.write(`[t1k-update-runner] ${msg}\n`); } catch { /* ok */ }
}

function claudeHomeDir() {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  return path.join(home, '.claude');
}

function logPath()    { return path.join(claudeHomeDir(), T1K.PATHS.UPDATE_LOG); }
function statusPath() { return path.join(claudeHomeDir(), T1K.PATHS.UPDATE_STATUS); }

/**
 * Read installed kit names from $HOME/.claude/metadata.json (best effort).
 * Derives a PRE-UPDATE snapshot of kits so Phase 03 can build a
 * user-friendly commit message even if the update itself rewrites metadata.
 *
 * @returns {string[]} kit repo short names (e.g. ["theonekit-unity"])
 */
function readInstalledKits() {
  try {
    const metaPath = path.join(claudeHomeDir(), 'metadata.json');
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const kits = new Set();
    const mods = meta && meta.installedModules ? meta.installedModules : {};
    for (const entry of Object.values(mods)) {
      if (entry && typeof entry === 'object' && entry.repository) {
        kits.add(String(entry.repository).split('/').pop());
      }
    }
    return Array.from(kits);
  } catch { return []; }
}

/**
 * List tracked + untracked files in the repo at `cwd` (no --exclude-standard
 * so untracked-but-gitignored files are still caught). Returns [] on any error.
 * @param {string} cwd
 * @returns {string[]}
 */
function listGitFiles(cwd) {
  try {
    const raw = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd, encoding: 'utf8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    return raw.split('\n').filter(Boolean);
  } catch { return []; }
}

/**
 * Derive the list of `.claude/` files the update actually changed.
 *
 * Strategy:
 *   1. Prefer `git diff --name-only HEAD` scoped to `.claude/` — captures both
 *      tracked edits and deletions. Untracked (new) files are added via
 *      `git ls-files --others --exclude-standard`.
 *   2. If CWD is not a git repo, return [].
 *
 * Paths are repo-root-relative so Phase 03's scope-safety gate can use them
 * directly as `expectedFiles` with `git diff --name-only` comparison.
 *
 * @param {string} cwd
 * @returns {string[]}
 */
function deriveFilesChanged(cwd) {
  let tracked = [];
  try {
    const raw = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', '.claude/'], {
      cwd, encoding: 'utf8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    tracked = raw.split('\n').filter(Boolean);
  } catch { /* not a git repo or no HEAD */ }

  let untracked = [];
  try {
    const raw = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '--', '.claude/'], {
      cwd, encoding: 'utf8', timeout: 10000,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    untracked = raw.split('\n').filter(Boolean);
  } catch { /* ok */ }

  // `t1k modules update` also regenerates kit artifacts at the REPO ROOT (e.g.
  // .t1k-module-summary.txt) outside `.claude/`. Capture those too so the
  // auto-commit's expectedFiles gate accepts them and they don't get left dirty
  // after the commit (issue #510). KIT_ROOT_ARTIFACTS is the SSOT, imported
  // from the same helper the runner already uses for autoCommitUpdates.
  let rootArtifacts = [];
  try {
    const { KIT_ROOT_ARTIFACTS } = require('./auto-commit-helper.cjs');
    const artifactPaths = Array.from(KIT_ROOT_ARTIFACTS);
    if (artifactPaths.length > 0) {
      const raw = execFileSync('git', ['diff', '--name-only', 'HEAD', '--', ...artifactPaths], {
        cwd, encoding: 'utf8', timeout: 10000,
        stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
      });
      rootArtifacts = raw.split('\n').filter(Boolean);
    }
  } catch { /* ok */ }

  const merged = new Set([...tracked, ...untracked, ...rootArtifacts]);
  return Array.from(merged);
}

/**
 * Truncate a buffer to the last `maxBytes` of UTF-8 text. Safe on non-UTF-8
 * inputs (returns what decodes). Used for `stderrTail` in the status file.
 * @param {Buffer|string|null|undefined} buf
 * @param {number} maxBytes
 * @returns {string}
 */
function tailText(buf, maxBytes) {
  if (!buf) return '';
  const s = Buffer.isBuffer(buf) ? buf.toString('utf8') : String(buf);
  if (s.length <= maxBytes) return s;
  return s.slice(-maxBytes);
}

/**
 * Build the `stderrTail` persisted to .kit-update.status for the next session's
 * "PREV RUN FAILED" banner (core#386).
 *
 * Guarantees a NON-EMPTY tail whenever exitCode is non-zero — a silent
 * `exitCode=1` with no diagnostic was the original bug. Source priority:
 *   1. stderr (canonical error stream)
 *   2. stdout (the t1k CLI prints its failure cause here on `--yes`)
 *   3. spawn-level error message (ENOENT / EINVAL — binary unspawnable)
 *   4. explicit `exitCode=N (no output captured)` fallback marker
 *
 * On a clean exit (exitCode === 0) the tail is just the stderr tail (typically
 * empty) — no fabricated diagnostic for success.
 *
 * @param {number} exitCode
 * @param {Buffer|string|null} stderrBuf
 * @param {Buffer|string|null} stdoutBuf
 * @param {Error|null|undefined} spawnError result.error from spawnSync
 * @returns {string}
 */
function buildDiagnosticTail(exitCode, stderrBuf, stdoutBuf, spawnError) {
  const stderrTail = tailText(stderrBuf, STDERR_TAIL_BYTES);
  if (exitCode === 0) return stderrTail;

  if (stderrTail.trim()) return stderrTail;

  const stdoutTail = tailText(stdoutBuf, STDERR_TAIL_BYTES);
  if (stdoutTail.trim()) return `[stdout] ${stdoutTail}`;

  if (spawnError && spawnError.message) {
    return `[spawn-error] ${spawnError.message}`;
  }

  return `exitCode=${exitCode} (no output captured)`;
}

/**
 * Write a JSON payload atomically: tmp file in the same directory, then
 * fs.renameSync to the final path. Cross-platform; rename within the same
 * filesystem is atomic on Linux, macOS, and Windows.
 */
function writeStatusAtomic(finalPath, payload) {
  const dir = path.dirname(finalPath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
  const tmp = path.join(dir, `.kit-update.status.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
  fs.renameSync(tmp, finalPath);
}

function appendLogFooter(exitCode) {
  try {
    fs.appendFileSync(logPath(), `[t1k-update] exit=${exitCode} ts=${new Date().toISOString()}\n`);
  } catch { /* ok */ }
}

/**
 * Commit (and optionally push) the `.claude/` churn this background update just
 * produced — IN THE SAME SESSION (core#455).
 *
 * Previously the detached SessionStart update wrote `.kit-update.status` but
 * never committed: the PostToolUse `post-kit-update-commit.cjs` hook only fires
 * for INTERACTIVE Bash invocations (not a detached spawn), and the SessionStart
 * `check-kit-updates.cjs` auto-commit only handles the PREVIOUS session's
 * status. So the current session's churn sat dirty in the working tree until
 * the next session boot — a full-session lag.
 *
 * This closes that gap at the source: the runner IS the process that applied
 * the update, knows the exact `filesChanged[]` scope, and runs in the right
 * `cwd` (the consumer project). It invokes the SAME shared `autoCommitUpdates`
 * helper the other two paths use — gated on the SAME feature flags
 * (`autoCommitKitSync` / `autoPushKitSync`) read from the resolved config.
 *
 * Errors over silent fallbacks: the commit outcome (or the reason it was
 * skipped) is appended to the log so a dirty-tree-after-update is diagnosable.
 *
 * Fail-open: any internal error is swallowed so a commit-helper fault never
 * changes the runner's own exit code (which mirrors the t1k binary, core#386).
 *
 * @param {string}   cwd          the project working directory (runner's cwd)
 * @param {string[]} filesChanged repo-relative `.claude/` paths the update changed
 * @param {string[]} kits         kit short names for the commit message
 */
function maybeAutoCommit(cwd, filesChanged, kits) {
  try {
    if (!Array.isArray(filesChanged) || filesChanged.length === 0) return;

    // Resolve flags from the consumer project's config. resolveClaudeDir walks
    // up from process.cwd(); the runner's cwd is the project dir, so this lands
    // on the project .claude/ (or the global one in a global-only install).
    const { resolveClaudeDir, readFeatureFlag } = require('../telemetry-utils.cjs');
    const resolved = resolveClaudeDir();
    if (!resolved) return;
    const { claudeDir, isGlobalOnly } = resolved;

    // A global-only install ($HOME/.claude/) is typically not a git repo we
    // should commit into — mirror check-kit-updates.cjs which gates its
    // auto-commit on !isGlobalOnly. The global churn is committed by whatever
    // owns that directory, not the runner.
    if (isGlobalOnly) return;

    const autoCommitFlag = readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_COMMIT_KIT_SYNC, false);
    if (!autoCommitFlag) {
      try {
        fs.appendFileSync(logPath(), `[t1k-update] auto-commit skipped: autoCommitKitSync off (${filesChanged.length} file(s) left in working tree)\n`);
      } catch { /* ok */ }
      return;
    }
    const autoPushFlag = readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_PUSH_KIT_SYNC, false);

    const { autoCommitUpdates } = require('./auto-commit-helper.cjs');
    const result = autoCommitUpdates(cwd, {
      flagEnabled: true,
      pushEnabled: autoPushFlag === true,
      expectedFiles: filesChanged, // scope-safety gate (issue #404 / Phase 03)
      kits: Array.isArray(kits) ? kits : [],
    });

    try {
      if (result && result.committed) {
        fs.appendFileSync(logPath(), `[t1k-update] auto-commit: committed ${filesChanged.length} file(s)${result.pushed ? ' + pushed' : ''}\n`);
      } else if (result && result.reason && result.reason !== 'no-changes') {
        fs.appendFileSync(logPath(), `[t1k-update] auto-commit skipped: ${result.reason}\n`);
      }
    } catch { /* ok */ }
  } catch (err) {
    // Fail-open — never let a commit fault flip the runner's exit code.
    dbg(`auto-commit failed: ${err && err.message}`);
    try {
      fs.appendFileSync(logPath(), `[t1k-update] auto-commit error: ${err && err.message ? err.message : String(err)}\n`);
    } catch { /* ok */ }
  }
}

// ── main ────────────────────────────────────────────────────────────────────

// Suppress the auto-run IIFE when a test harness wants to require() the module
// to exercise individual exported helpers (e.g. maybeAutoCommit). Production
// invocation never sets this, so behavior is unchanged in the field.
if (process.env.T1K_UPDATE_RUNNER_NO_IIFE === '1') {
  module.exports = {
    _internal: {
      claudeHomeDir,
      logPath,
      statusPath,
      readInstalledKits,
      deriveFilesChanged,
      tailText,
      buildDiagnosticTail,
      maybeAutoCommit,
      writeStatusAtomic,
      listGitFiles,
    },
  };
} else (function main() {
  const [, , binary, ...args] = process.argv;

  if (!binary) {
    // Invocation error — still emit a status so the next session knows.
    const payload = {
      exitCode: 2,
      ts: new Date().toISOString(),
      args: [],
      filesChanged: [],
      kits: [],
      stderrTail: 'runner invoked without <binary> argument',
    };
    try { writeStatusAtomic(statusPath(), payload); } catch { /* ok */ }
    appendLogFooter(2);
    process.exit(2);
  }

  dbg(`binary=${binary} args=${JSON.stringify(args)} cwd=${process.cwd()}`);

  // Snapshot kits BEFORE the update — metadata may be rewritten by the CLI.
  const kits = readInstalledKits();

  // spawnSync to capture exit code + stderr in-process. Stdout goes to the log
  // file via appending from the parent's stdio inheritance (runner itself is
  // spawned detached with fd → log).
  //
  // Windows: npm installs CLIs as a .cmd shim alongside a bare POSIX shebang
  // file. Node's spawn cannot run the extensionless file (ENOENT) and, since
  // CVE-2024-27980, refuses .cmd/.bat without shell:true (EINVAL). So when the
  // binary is a Windows shim, spawn through the shell. Args here are static
  // flags (update/--yes/--cli-only) so there is no injection surface; the
  // binary is quoted to tolerate spaces in the path.
  const isWinShim = process.platform === 'win32' && /\.(cmd|bat)$/i.test(binary);
  // Capture BOTH stdout AND stderr (core#386). The previous `inherit` on stdout
  // sent the CLI's output straight to the detached log fd, so it was never
  // available in-process — when the CLI printed its failure cause to STDOUT
  // (which `t1k update --yes` does: success/failure lines go to stdout), an
  // exit≠0 produced an empty `stderrTail` → the next session's banner read
  // "no stderr captured" (a silent failure). Piping both lets us mirror them to
  // the log AND build a non-empty diagnostic tail with a stdout fallback below.
  const result = spawnSync(isWinShim ? `"${binary}"` : binary, args, {
    cwd: process.cwd(),
    env: process.env, // already set by caller (NO_COLOR, CI, etc.)
    stdio: ['ignore', 'pipe', 'pipe'], // both captured → mirrored to log + tail
    windowsHide: true,
    shell: isWinShim,
  });

  // exitCode vs signal: mirror Node convention. Signals surface as 128 + signum.
  let exitCode;
  if (result.error) {
    exitCode = 1;
  } else if (typeof result.status === 'number') {
    exitCode = result.status;
  } else if (result.signal) {
    // SIGTERM → 143, SIGINT → 130, etc. (128 + signal number on POSIX)
    const sigNums = { SIGINT: 2, SIGTERM: 15, SIGKILL: 9, SIGHUP: 1, SIGQUIT: 3 };
    exitCode = 128 + (sigNums[result.signal] || 0);
  } else {
    exitCode = 1;
  }

  dbg(`spawn result: status=${result.status} signal=${result.signal} error=${result.error && result.error.message}`);

  // Mirror child stdout + stderr to the log so humans can inspect both. Stdout
  // is now piped (was inherited) so we re-emit it to the log to preserve the
  // prior log content. Stdout first, then stderr, matching stream order.
  const stdoutBuf = result.stdout || Buffer.alloc(0);
  const stderrBuf = result.stderr || Buffer.alloc(0);
  try {
    if (stdoutBuf && stdoutBuf.length > 0) fs.appendFileSync(logPath(), stdoutBuf);
    if (stderrBuf && stderrBuf.length > 0) fs.appendFileSync(logPath(), stderrBuf);
  } catch { /* ok */ }

  // Build the diagnostic tail that the NEXT session's "PREV RUN FAILED" banner
  // reads (core#386). Errors over silent fallbacks: never persist an empty tail
  // for a non-zero exit. Source priority:
  //   1. captured stderr (the canonical error stream)
  //   2. captured stdout (the CLI prints its failure cause here on `--yes`)
  //   3. the spawn-level error message (ENOENT / EINVAL — binary unspawnable)
  //   4. an explicit fallback marker so the banner is never blank
  const stderrTail = buildDiagnosticTail(exitCode, stderrBuf, stdoutBuf, result.error);
  const filesChanged = deriveFilesChanged(process.cwd());

  const payload = {
    exitCode,
    ts: new Date().toISOString(),
    args,
    filesChanged,
    kits,
    stderrTail,
  };

  try { writeStatusAtomic(statusPath(), payload); }
  catch (err) { dbg(`status write failed: ${err && err.message}`); }

  // core#455: commit this session's churn now (only on a clean update). Runs
  // AFTER the status write so a commit fault can never block the status file
  // the next session's banner depends on. Gated internally on the feature
  // flags; fail-open so it never changes our exit code.
  if (exitCode === 0) {
    maybeAutoCommit(process.cwd(), filesChanged, kits);
  }

  appendLogFooter(exitCode);

  process.exit(exitCode);
})();

module.exports = {
  // Exported for unit tests only — the module also auto-runs via IIFE above.
  // Test harness sets env T1K_UPDATE_RUNNER_NO_IIFE=1 to suppress — not used
  // currently because tests spawn the runner as a child process.
  _internal: {
    claudeHomeDir,
    logPath,
    statusPath,
    readInstalledKits,
    deriveFilesChanged,
    tailText,
    buildDiagnosticTail,
    maybeAutoCommit,
    writeStatusAtomic,
    listGitFiles,
  },
};
