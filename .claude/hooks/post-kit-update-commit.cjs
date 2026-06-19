// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * post-kit-update-commit.cjs — PostToolUse(Bash) hook
 *
 * Closes the mid-session auto-commit gap. The existing SessionStart hook
 * `check-kit-updates.cjs` only auto-commits the PREVIOUS session's background-
 * update status. When a user runs `t1k modules update --yes` interactively
 * mid-session, the kit churn lands in the working tree but stays uncommitted
 * until the next SessionStart.
 *
 * This hook fires PostToolUse(Bash). When the executed command matches a t1k
 * update invocation (`t1k modules update`, `t1k update`), it reads the just-
 * updated `~/.claude/.kit-update.status` and invokes the shared auto-commit
 * helper — same code path the SessionStart hook uses.
 *
 * Gates (all must pass):
 *   - Bash command text matches t1k-update regex
 *   - features.autoCommitKitSync === true in resolved kit config
 *   - ~/.claude/.kit-update.status exists, exitCode === 0, filesChanged.length > 0
 *   - Working tree is NOT mid-merge / mid-rebase
 *   - cwd is a git repo
 *
 * Fail-open on any internal error. Exit 0 always (never block the user's flow).
 *
 * Origin: project-local invention 2026-05-27 (StickManForge_IdleRPG.wiki).
 * Should sync-back to theonekit-core. Resolves theonekit-core skill-bug
 * "t1k modules update mid-session doesn't auto-commit".
 */

'use strict';

const fs = require('fs');
const path = require('path');

function safeReadStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch { return ''; }
}

function looksLikeT1kUpdate(command) {
  if (!command || typeof command !== 'string') return false;
  const c = command.trim();
  // Match `t1k modules update`, `t1k update`, with any flags (--yes, etc.)
  // Anchored: must be a token at start or after && / ; / | / pipe to be a real invocation.
  return /(^|[&|;\s])t1k\s+(modules\s+update|update)\b/.test(c);
}

function fileExistsSync(p) {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

(function main() {
  try {
    const raw = safeReadStdin();
    if (!raw) process.exit(0);

    let payload;
    try { payload = JSON.parse(raw); } catch { process.exit(0); }
    if (!payload || typeof payload !== 'object') process.exit(0);

    // Only fire on Bash invocations
    if (payload.tool_name !== 'Bash') process.exit(0);

    const command = payload.tool_input && payload.tool_input.command;
    if (!looksLikeT1kUpdate(command)) process.exit(0);

    const cwd = process.env.CLAUDE_PROJECT_DIR || process.cwd();
    const home = process.env.HOME || process.env.USERPROFILE;
    if (!home) process.exit(0);

    // Locate claudeDir for feature-flag read (project-local first, fall back to global)
    const helperLibPath = path.join(cwd, '.claude', 'hooks', 'telemetry-utils.cjs');
    if (!fileExistsSync(helperLibPath)) process.exit(0);

    const { resolveClaudeDir, readFeatureFlag } = require(helperLibPath);
    const claudeDir = resolveClaudeDir(cwd);
    if (!claudeDir) process.exit(0);

    // T1K is exposed as a CommonJS constant in telemetry-utils.cjs — re-require to read the FEATURES enum
    let T1K;
    try { T1K = require(helperLibPath).T1K; } catch { /* ok */ }
    const featAutoCommit = T1K && T1K.FEATURES ? T1K.FEATURES.AUTO_COMMIT_KIT_SYNC : 'autoCommitKitSync';
    const featAutoPush = T1K && T1K.FEATURES ? T1K.FEATURES.AUTO_PUSH_KIT_SYNC : 'autoPushKitSync';

    const autoCommitFlag = readFeatureFlag(claudeDir, featAutoCommit, false);
    const autoPushFlag = readFeatureFlag(claudeDir, featAutoPush, false);

    if (!autoCommitFlag) {
      // Feature OFF — respect user choice, no commit
      process.exit(0);
    }

    const statusFile = path.join(home, '.claude', '.kit-update.status');
    if (!fileExistsSync(statusFile)) process.exit(0);

    let status;
    try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); } catch { process.exit(0); }

    if (!status || status.exitCode !== 0) process.exit(0);
    if (!Array.isArray(status.filesChanged) || status.filesChanged.length === 0) process.exit(0);

    const helperPath = path.join(cwd, '.claude', 'hooks', 'lib', 'auto-commit-helper.cjs');
    if (!fileExistsSync(helperPath)) process.exit(0);

    const { autoCommitUpdates } = require(helperPath);
    const result = autoCommitUpdates(cwd, {
      flagEnabled: true,
      pushEnabled: autoPushFlag === true,
      expectedFiles: status.filesChanged,
      kits: Array.isArray(status.kits) ? status.kits : [],
    });

    if (result && result.committed) {
      // Emit a brief stdout line — surfaces in PostToolUse output for the user
      process.stdout.write(`[t1k:auto-commit] kit churn committed (${result.commitSha || '?'}, ${status.filesChanged.length} files)${result.pushed ? ' + pushed' : ''}\n`);
    } else if (result && result.reason && result.reason !== 'no-changes') {
      process.stdout.write(`[t1k:auto-commit] skipped: ${result.reason}\n`);
    }
    process.exit(0);
  } catch {
    // Fail-open — never block user flow on hook error
    process.exit(0);
  }
})();
