#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * secret-guard.cjs - Block git operations that would commit sensitive files
 *
 * PreToolUse hook for Bash tool.
 * Hard-blocks:
 *   - git add of sensitive files (.env*, *.pem, *.key, credentials*)
 *   - git add -A / git add . when sensitive files exist in working tree
 *   - git commit when sensitive files are staged
 *   - git push when sensitive files are staged (final gate)
 *
 * No approval flow — must unstage manually. This is a hard security gate.
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
'use strict';
try {
  const { execSync } = require('child_process');
  const path = require('path');
  const { parseHookStdin, SENSITIVE_PATTERNS, SAFE_PATTERNS } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');

  function isSensitiveFile(filePath) {
    if (!filePath) return false;
    const base = path.basename(filePath);
    if (SAFE_PATTERNS.some(p => p.test(base))) return false;
    return SENSITIVE_PATTERNS.some(p => p.test(base));
  }

  function runGitCmd(args) {
    try {
      return execSync(args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 5000 })
        .trim().split('\n').filter(Boolean);
    } catch { return []; }
  }

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;
  if (toolName !== 'Bash' || !toolInput?.command) process.exit(0);

  const cmd = toolInput.command.trim();
  const timer = createHookTimer('secret-guard', { tool: toolName });

  try {
    // === Check 1: git add of sensitive files directly ===
    const gitAddMatch = cmd.match(/git\s+add\s+(.+)/);
    if (gitAddMatch) {
      const args = gitAddMatch[1].trim();

      if (args === '-A' || args === '.' || args === '--all') {
        const sensitiveUntracked = runGitCmd('git ls-files --others --exclude-standard').filter(isSensitiveFile);
        const sensitiveModified = runGitCmd('git diff --name-only').filter(isSensitiveFile);
        const allSensitive = [...new Set([...sensitiveUntracked, ...sensitiveModified])];

        if (allSensitive.length > 0) {
          logHook('secret-guard', { decision: 'block', pattern: 'git-add-all', blocked: allSensitive.length });
          timer.end({ outcome: 'blocked', blocked: allSensitive.length });
          console.error(`\n\x1b[31mSECURITY BLOCK\x1b[0m: "${cmd}" would stage sensitive files:\n\n${allSensitive.map(f => `  \x1b[31m✗\x1b[0m ${f}`).join('\n')}\n\n  \x1b[34mFix:\x1b[0m Stage specific files instead of using "${args}":\n    git add file1.ts file2.ts\n\n  \x1b[90mOr add these to .gitignore first.\x1b[0m\n`);
          process.exit(2);
        }
      }

      const files = args.split(/\s+/).filter(f => !f.startsWith('-'));
      const sensitiveFiles = files.filter(isSensitiveFile);
      if (sensitiveFiles.length > 0) {
        logHook('secret-guard', { decision: 'block', pattern: 'git-add-direct', blocked: sensitiveFiles.length });
        timer.end({ outcome: 'blocked', blocked: sensitiveFiles.length });
        console.error(`\n\x1b[31mSECURITY BLOCK\x1b[0m: Cannot stage sensitive files:\n\n${sensitiveFiles.map(f => `  \x1b[31m✗\x1b[0m ${f}`).join('\n')}\n\n  These files may contain secrets and must not be committed.\n  \x1b[34mFix:\x1b[0m Add them to .gitignore or use .env.example for templates.\n`);
        process.exit(2);
      }
    }

    // === Check 2: git commit — verify no sensitive files are staged ===
    if (/git\s+commit/.test(cmd)) {
      const sensitiveStaged = runGitCmd('git diff --cached --name-only').filter(isSensitiveFile);
      if (sensitiveStaged.length > 0) {
        logHook('secret-guard', { decision: 'block', pattern: 'git-commit-staged', blocked: sensitiveStaged.length });
        timer.end({ outcome: 'blocked', blocked: sensitiveStaged.length });
        console.error(`\n\x1b[31mSECURITY BLOCK\x1b[0m: Sensitive files are staged for commit:\n\n${sensitiveStaged.map(f => `  \x1b[31m✗\x1b[0m ${f}`).join('\n')}\n\n  \x1b[34mFix:\x1b[0m Unstage them first:\n${sensitiveStaged.map(f => `    git reset HEAD "${f}"`).join('\n')}\n`);
        process.exit(2);
      }
    }

    // === Check 3: git push — final gate, check staged files ===
    if (/git\s+push/.test(cmd)) {
      const sensitiveStaged = runGitCmd('git diff --cached --name-only').filter(isSensitiveFile);
      if (sensitiveStaged.length > 0) {
        logHook('secret-guard', { decision: 'block', pattern: 'git-push-staged', blocked: sensitiveStaged.length });
        timer.end({ outcome: 'blocked', blocked: sensitiveStaged.length });
        console.error(`\n\x1b[31mSECURITY BLOCK\x1b[0m: Cannot push — sensitive files are staged:\n\n${sensitiveStaged.map(f => `  \x1b[31m✗\x1b[0m ${f}`).join('\n')}\n\n  \x1b[34mFix:\x1b[0m Unstage and reset before pushing.\n`);
        process.exit(2);
      }
    }

    timer.end({ outcome: 'allow' });
    process.exit(0); // Allow
  } catch (err) {
    logHookCrash('secret-guard', err, { tool: toolName });
    timer.end({ outcome: 'crash' });
    process.exit(0); // fail-open
  }
} catch {
  process.exit(0); // Fail-open
}
