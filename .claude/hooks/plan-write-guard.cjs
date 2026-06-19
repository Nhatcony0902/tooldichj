#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * plan-write-guard.cjs — Block Write/Edit/MultiEdit outside plans/** when /t1k:plan is active
 *
 * PreToolUse hook for Write, Edit, MultiEdit tools.
 * Only acts when the transcript tail shows /t1k:plan as the most recent Skill call.
 * Allows any write to <projectRoot>/plans/** and blocks all other paths.
 *
 * Fail-open: any crash or parse error → exit 0 (allow). Matches the convention of
 * privacy-guard.cjs and secret-guard.cjs.
 *
 * Cross-platform: path.join, path.resolve, path.relative, path.sep — no hardcoded /.
 * No /dev/stdin, no 2>/dev/null, no bash subshells.
 */
'use strict';
try {
  const path = require('path');
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  const { isPlanContextActive } = require('./lib/plan-context-detector.cjs');

  const WATCHED_TOOLS = ['Write', 'Edit', 'MultiEdit'];

  /**
   * Extract the target file path(s) from tool input.
   * Write and Edit both use `file_path`. MultiEdit uses `file_path` for a single
   * target file (the edits array is nested within).
   * @param {string} toolName
   * @param {object|null} toolInput
   * @returns {string[]}
   */
  function extractPaths(toolName, toolInput) {
    if (!toolInput) return [];
    if (toolName === 'Write' || toolName === 'Edit' || toolName === 'MultiEdit') {
      return toolInput.file_path ? [toolInput.file_path] : [];
    }
    return [];
  }

  /**
   * Return true iff absPath is strictly inside <projectRoot>/plans/.
   * Rejects path-traversal attempts (plans/../src/foo.ts) by checking that
   * path.relative(plansDir, absPath) does not start with '..' and is not absolute.
   * @param {string} absPath - Already-resolved absolute path
   * @param {string} projectRoot - Absolute project root
   * @returns {boolean}
   */
  function isAllowedPath(absPath, projectRoot) {
    const plansDir = path.join(projectRoot, 'plans');
    const rel = path.relative(plansDir, absPath);
    // rel must be non-empty, not start with '..', and not be absolute
    // (empty rel would mean absPath === plansDir — writing the directory itself, also disallowed)
    return rel.length > 0 && !rel.startsWith('..') && !path.isAbsolute(rel);
  }

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const {
    tool_name: toolName,
    tool_input: toolInput,
    transcript_path: transcriptPath,
    cwd,
  } = hookData;

  if (!WATCHED_TOOLS.includes(toolName)) process.exit(0);

  const timer = createHookTimer('plan-write-guard', { tool: toolName });

  try {
    // Gate 1 — only act when /t1k:plan skill is active
    if (!isPlanContextActive(transcriptPath)) {
      timer.end({ outcome: 'skip', note: 'not-plan-context' });
      process.exit(0);
    }

    // Gate 2 — extract target paths
    const projectRoot = process.env.T1K_PROJECT_ROOT || cwd || process.cwd();
    const targets = extractPaths(toolName, toolInput);
    if (targets.length === 0) {
      timer.end({ outcome: 'skip', note: 'no-path' });
      process.exit(0);
    }

    // Gate 3 — validate against plans/** allowlist
    const violations = [];
    for (const t of targets) {
      const abs = path.isAbsolute(t) ? t : path.resolve(projectRoot, t);
      if (!isAllowedPath(abs, projectRoot)) {
        violations.push(t);
      }
    }

    if (violations.length > 0) {
      logHook('plan-write-guard', { decision: 'block', tool: toolName, count: violations.length });
      timer.end({ outcome: 'blocked', blocked: violations.length });
      console.error(
        '\n\x1b[31mPLAN WRITE BLOCKED\x1b[0m: /t1k:plan can only write to plans/**\n\n' +
        violations.map(v => `  \x1b[31m\u2717\x1b[0m ${v}`).join('\n') + '\n\n' +
        '  \x1b[34mWhat to do:\x1b[0m Planning is read-only outside plans/.\n' +
        '  To implement this change, finish the plan, then run:\n' +
        '    \x1b[32m/t1k:cook {plan-path}\x1b[0m\n'
      );
      process.exit(2);
    }

    timer.end({ outcome: 'allow' });
    process.exit(0);
  } catch (err) {
    logHookCrash('plan-write-guard', err, { tool: toolName });
    timer.end({ outcome: 'crash' });
    process.exit(0); // fail-open
  }
} catch {
  process.exit(0); // Fail-open outer catch
}
