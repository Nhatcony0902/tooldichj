#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * privacy-guard.cjs - Block reading sensitive files unless user approves
 *
 * PreToolUse hook for Read/Glob/Grep tools.
 * Blocks: .env*, *.pem, *.key, id_rsa*, credentials*, secrets.yml
 * Exempts: .env.example, .env.sample, .env.template
 *
 * Approval flow:
 * 1. Claude tries Read ".env" → BLOCKED (exit 2)
 * 2. Claude asks user via AskUserQuestion
 * 3. If approved → Claude uses bash: cat ".env"
 *
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
'use strict';
try {
  const path = require('path');
  const crypto = require('crypto');
  const { parseHookStdin, SENSITIVE_PATTERNS, SAFE_PATTERNS } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');

  function isSafe(filePath) {
    if (!filePath) return true;
    const base = path.basename(filePath);
    return SAFE_PATTERNS.some(p => p.test(filePath) || p.test(base));
  }

  function isSensitive(filePath) {
    if (!filePath) return false;
    const base = path.basename(filePath);
    return SENSITIVE_PATTERNS.some(p => p.test(filePath) || p.test(base));
  }

  function extractFilePath(toolName, toolInput) {
    if (!toolInput) return null;
    if (toolName === 'Read' && toolInput.file_path) return toolInput.file_path;
    if (toolName === 'Glob' && toolInput.pattern) return toolInput.pattern;
    if (toolName === 'Grep' && toolInput.path) return toolInput.path;
    return null;
  }

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;

  if (!['Read', 'Glob', 'Grep'].includes(toolName)) process.exit(0);

  const timer = createHookTimer('privacy-guard', { tool: toolName });

  try {
    const filePath = extractFilePath(toolName, toolInput);
    if (!filePath) { timer.end({ outcome: 'skip', note: 'no-file-path' }); process.exit(0); }

    if (isSafe(filePath)) { timer.end({ outcome: 'allow' }); process.exit(0); }

    if (isSensitive(filePath)) {
      // Hash the path so no raw sensitive paths appear in telemetry logs
      const pathHash = crypto.createHash('sha256').update(filePath).digest('hex').slice(0, 16);
      logHook('privacy-guard', { decision: 'block', pathHash: pathHash, tool: toolName });
      timer.end({ outcome: 'blocked', blocked: 1 });
      console.error(`
\x1b[33mSECURITY BLOCK\x1b[0m: Sensitive file detected

  \x1b[33mFile:\x1b[0m ${filePath}
  \x1b[33mTool:\x1b[0m ${toolName}

  This file may contain secrets (API keys, passwords, tokens).

  \x1b[34mTo proceed:\x1b[0m Ask the user for permission using AskUserQuestion, then use:
    \x1b[32mbash: cat "${filePath}"\x1b[0m
  \x1b[31mIf denied:\x1b[0m Continue without reading this file.
  \x1b[90mTip: Use .env.example for documenting required variables.\x1b[0m
`);
      process.exit(2); // Block
    }

    timer.end({ outcome: 'allow' });
    process.exit(0); // Allow
  } catch (err) {
    logHookCrash('privacy-guard', err, { tool: toolName });
    timer.end({ outcome: 'crash' });
    process.exit(0); // fail-open
  }
} catch {
  process.exit(0); // Fail-open
}
