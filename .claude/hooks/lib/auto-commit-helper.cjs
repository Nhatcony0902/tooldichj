// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * auto-commit-helper.cjs — Extracted from check-kit-updates.cjs:~483-514.
 *
 * Phase 03 of 260418-1942-t1k-ecosystem-fixes. Commits `.claude/` changes
 * produced by the auto-update pipeline. Gated on `features.autoCommitKitSync`
 * (default OFF) so the pre-existing always-on behavior is preserved as opt-in.
 *
 * Risk #2 mitigation: when `options.expectedFiles` is supplied, the helper
 * asserts every staged `.claude/` path appears in that list and ABORTS on any
 * extra — preventing the auto-commit from bundling the user's unrelated
 * `.claude/` work. The list is produced by t1k-update-runner.cjs (Phase 02)
 * and persisted to `~/.claude/.kit-update.status` → `filesChanged[]`.
 *
 * `--no-verify --no-gpg-sign` is a DOCUMENTED EXCEPTION for this path only:
 * the hook may run inside a TTY-less detached background process, where
 * Pinentry / GPG-SSH prompts would hang forever. See
 * `skills/t1k-kit/references/cli-auto-update.md` → "--no-verify exception".
 *
 * Cross-platform: no shell syntax, no `2>/dev/null`, no `/dev/stdin`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const DEFAULT_COMMIT_MESSAGE = 'chore(t1k): sync kit modules';
const DEBUG = process.env.T1K_DEBUG_AUTOCOMMIT === '1';

// Kit artifacts that `t1k modules update` regenerates at the REPO ROOT (outside
// `.claude/`). These are kit-owned, update-generated, and otherwise left dirty
// after an auto-commit that only scopes `.claude/` (issue #510). The set is the
// SSOT for "non-.claude/ paths the auto-commit pipeline is allowed to own" —
// t1k-update-runner.cjs (deriveFilesChanged) imports it so the runner records
// the same paths in filesChanged[]. Add new root artifacts here, nowhere else.
const KIT_ROOT_ARTIFACTS = new Set(['.t1k-module-summary.txt']);

/**
 * True if a repo-relative path is a committable kit-sync path: anything under
 * `.claude/`, OR a known update-generated root artifact (issue #510).
 * @param {string} p repo-root-relative path
 * @returns {boolean}
 */
function isCommittablePath(p) {
  return p.startsWith('.claude/') || KIT_ROOT_ARTIFACTS.has(p);
}

function dbg(msg) {
  if (!DEBUG) return;
  try { process.stderr.write(`[t1k:auto-commit-helper] ${msg}\n`); } catch { /* ok */ }
}

/**
 * Parse `git status --porcelain` output into repo-root-relative file paths.
 * Handles quoted paths (spaces / unicode) by stripping surrounding quotes.
 * @param {string} raw stdout of `git status --porcelain`
 * @returns {string[]} file paths (may be empty)
 */
function parsePorcelainPaths(raw) {
  return raw.split('\n')
    .filter(l => l.length >= 4)
    .map(l => l.substring(3).trimEnd().replace(/^"(.*)"$/, '$1'));
}

/**
 * True if the repo is mid-merge / mid-rebase. We never auto-commit over those.
 * @param {string} cwd
 */
function isMidMergeOrRebase(cwd) {
  const gitDir = path.join(cwd, '.git');
  return fs.existsSync(path.join(gitDir, 'MERGE_HEAD'))
      || fs.existsSync(path.join(gitDir, 'rebase-merge'))
      || fs.existsSync(path.join(gitDir, 'rebase-apply'));
}

/**
 * Build the commit message. When `kits[]` is non-empty, produce
 * `chore(t1k): sync <kit1>,<kit2> kit modules` to match the user's manual
 * convention; otherwise use `options.commitMessage` or the default.
 *
 * @param {{ commitMessage?: string, kits?: string[] }} options
 * @returns {string}
 */
function buildCommitMessage(options) {
  const kits = Array.isArray(options.kits) ? options.kits.filter(Boolean) : [];
  if (kits.length > 0) return `chore(t1k): sync ${kits.join(',')} kit modules`;
  return options.commitMessage || DEFAULT_COMMIT_MESSAGE;
}

/**
 * Attempt to auto-commit `.claude/` changes, and optionally push them.
 *
 * Behavior matrix:
 *   flagEnabled=false          → no-op (returns { committed:false, pushed:false, reason:'flag-off' })
 *   clean working tree         → no-op ('no-changes')
 *   mid-merge / mid-rebase     → skip ('mid-merge')
 *   no `.claude/` in status    → skip ('no-claude-changes')
 *   expectedFiles mismatch     → abort + warn ('unexpected-files')
 *   commit succeeds, pushEnabled=false  → return { committed:true, pushed:false, reason:'committed' }
 *   commit succeeds, push succeeds       → return { committed:true, pushed:true, reason:'pushed' }
 *   commit succeeds, push fails          → log + return { committed:true, pushed:false, reason:'push-failed' }
 *
 * Scope safety: staging is path-scoped (explicit `git add -- <committable
 * paths>`) and the commit names the staged files explicitly after `--`, so the
 * commit can only ever contain kit-sync paths — everything under `.claude/`
 * plus the known update-generated root artifacts (issue #510). Unrelated work
 * is never swept in, no matter how dirty the rest of the tree is (issue #404).
 * Additionally, when `options.expectedFiles` is provided, every staged
 * `.claude/` file MUST appear in that list; any mismatch aborts without
 * committing, preventing bundling of unrelated `.claude/` work dirty at
 * hook time.
 *
 * Push semantics (only when `options.pushEnabled === true`):
 *   - If the current branch has an upstream → `git push` (no flags).
 *   - If no upstream → `git push -u origin HEAD` (sets upstream on current branch).
 *   - Never `--force` or `--force-with-lease`.
 *   - Fail-open: push failure logs `[t1k:auto-push]` and retains the commit
 *     (user can `git push` manually later). The commit is NEVER undone.
 *
 * Never amends. Fail-open on any unexpected error: returns
 * `{ committed:false, pushed:false, reason:'error' }` so the caller keeps running.
 *
 * @param {string} cwd repository working directory
 * @param {object} options
 * @param {boolean} options.flagEnabled REQUIRED. When false, return early.
 * @param {boolean} [options.pushEnabled=false] When true AND commit succeeds, run `git push`.
 * @param {string[]} [options.expectedFiles] repo-relative paths allowed in the commit.
 * @param {string} [options.commitMessage] custom message (ignored if `kits` present).
 * @param {string[]} [options.kits] kit short names for message formatting.
 * @returns {{ committed: boolean, pushed: boolean, reason: string, files?: string[] }}
 */
function autoCommitUpdates(cwd, options = {}) {
  const flagEnabled = !!options.flagEnabled;
  const pushEnabled = !!options.pushEnabled;

  if (!flagEnabled) {
    dbg('flag off — no-op');
    return { committed: false, pushed: false, reason: 'flag-off' };
  }

  try {
    // -uall enumerates untracked files individually (default collapses them
    // to the parent directory, which defeats the scope-safety gate).
    const gitStatus = execSync('git status --porcelain -uall', {
      encoding: 'utf8', cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
    });

    if (!gitStatus.trim()) {
      dbg('clean working tree');
      return { committed: false, pushed: false, reason: 'no-changes' };
    }

    if (isMidMergeOrRebase(cwd)) {
      dbg('mid-merge / mid-rebase — skipping');
      return { committed: false, pushed: false, reason: 'mid-merge' };
    }

    const allPaths = parsePorcelainPaths(gitStatus);
    // Committable kit-sync paths: everything under `.claude/` plus the known
    // update-generated root artifacts (issue #510). Variable name kept as
    // `claudePaths` to minimize churn in downstream references; the contents
    // now also include root artifacts when present.
    const claudePaths = allPaths.filter(isCommittablePath);

    if (claudePaths.length === 0) {
      dbg('no committable kit-sync changes in porcelain output');
      return { committed: false, pushed: false, reason: 'no-claude-changes' };
    }

    // NOTE (issue #404): we deliberately do NOT skip when non-.claude/ files
    // are dirty. In any active project (especially Unity game repos) the
    // working tree is almost always dirty with unrelated files (asset
    // re-imports, ProjectSettings.asset, generated docs, etc.), so a blanket
    // "non-claude-dirty" skip made the auto-commit/push effectively never
    // fire — kit-sync .claude/ churn then accumulated uncommitted indefinitely.
    // That skip was also redundant: this helper (a) stages with a .claude/
    // pathspec and (b) commits with an explicit .claude/-scoped pathspec
    // (below), and (c) enforces the expectedFiles allow-list. Those guarantee
    // the commit can only ever contain kit-sync .claude/ files — the user's
    // unrelated non-.claude/ work is physically untouchable, regardless of how
    // dirty the rest of the tree is.

    if (Array.isArray(options.expectedFiles)) {
      const allowed = new Set(options.expectedFiles);
      const extras = claudePaths.filter(p => !allowed.has(p));
      if (extras.length > 0) {
        console.log(`[t1k:auto-commit] abort — ${extras.length} .claude/ file(s) not in expectedFiles: ${extras.slice(0, 5).join(', ')}${extras.length > 5 ? '…' : ''}`);
        return { committed: false, pushed: false, reason: 'unexpected-files', files: extras };
      }
    }

    // Stage ONLY the committable kit-sync paths by explicit pathspec — never a
    // blanket `git add .claude/` (which would miss root artifacts) nor `git add
    // .` (which would sweep unrelated WIP into the index). Naming each path is
    // index-independent and race-safe per rules/parallel-teammate-git-index-race.md.
    execFileSync('git', ['add', '--', ...claudePaths], { cwd, timeout: 5000, windowsHide: true });

    let diffSummary = '';
    try {
      diffSummary = execSync('git diff --cached --name-only', {
        encoding: 'utf8', cwd, timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
    } catch { /* ok */ }
    if (!diffSummary) {
      dbg('nothing staged after explicit-pathspec git add');
      return { committed: false, pushed: false, reason: 'no-changes' };
    }

    const stagedFiles = diffSummary.split('\n').filter(Boolean);
    const msg = buildCommitMessage(options);

    // Explicit pathspec commit (issue #404): commit ONLY the staged .claude/
    // files by naming them after `--`. This is index-independent — even if
    // unrelated non-.claude/ files are dirty (or were concurrently staged by
    // another process), the commit physically cannot include them. Matches the
    // kit's own parallel-teammate-git-index-race.md guidance.
    //   --no-verify --no-gpg-sign: TTY-less detached hook exception documented
    //   in skills/t1k-kit/references/cli-auto-update.md. Pinentry / GPG-SSH
    //   prompts would otherwise hang the background runner forever.
    execFileSync('git', ['commit', '-m', msg, '--no-verify', '--no-gpg-sign', '--', ...stagedFiles], {
      cwd, timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });

    console.log(`[t1k:auto-commit] Committed ${stagedFiles.length} .claude/ file(s)`);

    if (!pushEnabled) {
      return { committed: true, pushed: false, reason: 'committed', files: stagedFiles };
    }

    // Sibling auto-push step. Gated on options.pushEnabled (caller reads
    // features.autoPushKitSync and threads it through). Fail-open on any
    // push error — the commit is RETAINED so the user can `git push`
    // manually later. Never --force / --force-with-lease.
    return tryPush(cwd, stagedFiles);
  } catch (err) {
    dbg(`error: ${err && err.message}`);
    return { committed: false, pushed: false, reason: 'error' };
  }
}

/**
 * Push the just-committed change. Called only after `git commit` succeeded
 * AND `options.pushEnabled` was true. Returns the final result object.
 *
 * Behavior:
 *   - Detect upstream via `git rev-parse --abbrev-ref --symbolic-full-name @{u}`.
 *   - If upstream present → `git push` (no flags).
 *   - Otherwise → `git push -u origin HEAD` (set upstream on current branch).
 *   - On any error → log `[t1k:auto-push] push failed: <msg>` and return
 *     `{ committed:true, pushed:false, reason:'push-failed' }`. The commit
 *     is preserved — the runner does NOT attempt to revert.
 *
 * TTY-less constraints match the commit step: windowsHide, stdio piped/ignored,
 * timeout 30s (network deserves more headroom than the 10s commit).
 *
 * @param {string} cwd
 * @param {string[]} stagedFiles
 * @returns {{ committed: boolean, pushed: boolean, reason: string, files: string[] }}
 */
function tryPush(cwd, stagedFiles) {
  let upstream = '';
  try {
    upstream = execFileSync('git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch { upstream = ''; }

  let branchName = '';
  try {
    branchName = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
  } catch { branchName = 'HEAD'; }

  const pushArgs = upstream ? ['push'] : ['push', '-u', 'origin', 'HEAD'];

  try {
    execFileSync('git', pushArgs, {
      cwd, timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    console.log(`[t1k:auto-push] Pushed ${stagedFiles.length} commit(s) to ${branchName}`);
    return { committed: true, pushed: true, reason: 'pushed', files: stagedFiles };
  } catch (err) {
    const msg = (err && err.message) ? err.message.split('\n')[0] : 'unknown';
    console.log(`[t1k:auto-push] push failed: ${msg} — commit retained, push manually`);
    return { committed: true, pushed: false, reason: 'push-failed', files: stagedFiles };
  }
}

module.exports = {
  autoCommitUpdates,
  // SSOT for update-generated root artifacts — imported by t1k-update-runner.cjs
  // (deriveFilesChanged) so the runner records the same paths in filesChanged[].
  KIT_ROOT_ARTIFACTS,
  // Exported for unit tests only.
  _internal: { parsePorcelainPaths, isMidMergeOrRebase, buildCommitMessage, tryPush, isCommittablePath, DEFAULT_COMMIT_MESSAGE },
};
