#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-diagram-install-cross-platform.cjs — CI gate for cross-platform correctness.
 *
 * Intended destination: theonekit-release-action/scripts/
 * Placed under .claude/hooks/ for development testing.
 *
 * Purpose:
 *   Scan hook .cjs files and skill scripts for banned platform-specific patterns
 *   that break Windows or macOS compatibility:
 *     - /dev/stdin usage
 *     - 2>/dev/null shell redirects
 *     - Hardcoded /tmp paths
 *     - execSync/execFileSync/spawn without windowsHide: true
 *
 * Usage:
 *   node validate-diagram-install-cross-platform.cjs [--warn-only] [--scope <hooks|skills|both>]
 *
 * Exit codes:
 *   0 — pass (or --warn-only)
 *   1 — violations found
 *   2 — internal error
 */

const fs = require('fs');
const path = require('path');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL = 2;

// ── Banned patterns ────────────────────────────────────────────────────────

const BANNED_PATTERNS = [
  {
    id: 'dev-stdin',
    regex: /\/dev\/stdin/,
    message: 'Use fs.readFileSync(0, "utf8") instead of ' + '/dev' + '/stdin (cross-platform)',
  },
  {
    id: 'dev-null-redirect',
    regex: /2>\/dev\/null/,
    message: 'Use { stdio: [\'pipe\', \'pipe\', \'ignore\'] } instead of ' + '2>' + '/dev/null',
  },
  {
    id: 'hardcoded-tmp',
    regex: /['"]\s*\/tmp\//,
    message: 'Use os.tmpdir() instead of hardcoded /tmp/',
  },
  {
    id: 'string-path-concat',
    regex: /['"`][^'"`]*\/[^'"`]*['"`]\s*\+\s*['"`][^'"`]*['"`]/,
    message: 'Use path.join() for path construction instead of string concatenation with /',
  },
  {
    id: 'exec-no-windows-hide',
    regex: /execSync\s*\(|execFileSync\s*\(|spawnSync\s*\(/,
    message: 'execSync/execFileSync/spawnSync calls should use windowsHide: true option',
    requiresCheck: 'windowsHide',
  },
];

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let warnOnly = false;
  let scope = 'both';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--warn-only') {
      warnOnly = true;
    } else if (args[i] === '--scope' && args[i + 1]) {
      const val = args[i + 1];
      if (!['hooks', 'skills', 'both'].includes(val)) {
        process.stderr.write(`[validate-diagram-install-cross-platform] Invalid --scope: ${val}\n`);
        process.exit(EXIT_INTERNAL);
      }
      scope = val;
      i++;
    }
  }

  return { warnOnly, scope };
}

// ── File collection ────────────────────────────────────────────────────────

function collectFiles(rootDir, scope) {
  const files = [];
  const hooksDir = path.join(rootDir, '.claude', 'hooks');
  const skillsScriptsDir = path.join(rootDir, '.claude', 'skills', 't1k-preview', 'scripts');

  if ((scope === 'hooks' || scope === 'both') && fs.existsSync(hooksDir)) {
    for (const f of fs.readdirSync(hooksDir)) {
      if (f.endsWith('.cjs')) {
        files.push({ file: path.join(hooksDir, f), type: 'hook' });
      }
    }
  }

  if ((scope === 'skills' || scope === 'both') && fs.existsSync(skillsScriptsDir)) {
    collectCjsRecursive(skillsScriptsDir, files, 'skill-script', 0);
  }

  return files;
}

function collectCjsRecursive(dir, out, type, depth) {
  if (depth > 5) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCjsRecursive(full, out, type, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.cjs') && !entry.name.endsWith('.test.cjs')) {
      out.push({ file: full, type });
    }
  }
}

// ── Scan a single file ─────────────────────────────────────────────────────

function scanFile(filePath) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return [{ line: 0, patternId: 'read-error', message: `Cannot read file: ${err.message}` }];
  }

  const violations = [];
  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Skip comment-only lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    for (const pat of BANNED_PATTERNS) {
      if (!pat.regex.test(line)) continue;

      // For exec patterns, check if windowsHide is on the same or adjacent lines
      if (pat.requiresCheck === 'windowsHide') {
        const context = lines.slice(Math.max(0, i), Math.min(lines.length, i + 6)).join('\n');
        if (/windowsHide\s*:\s*true/.test(context)) continue;
      }

      violations.push({ line: lineNum, patternId: pat.id, message: pat.message });
    }
  }

  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  // Dry-run / wrong-context safety (#503): this is a CLI linter, not a Claude Code
  // hook. The doctor's hook-runtime dry-run still invokes it with a synthetic
  // PreToolUse payload ({ tool_name:"Read", ... }). Recognize that and no-op fast
  // (exit 0) so it stays dry-run VALIDATED without scanning the repo for an event
  // that isn't a real linter invocation. Real CI runs pass argv flags + no payload.
  try {
    if (!process.stdin.isTTY) {
      const dryRunRaw = fs.readFileSync(0, 'utf8');
      if (dryRunRaw && JSON.parse(dryRunRaw).tool_name) process.exit(EXIT_PASS);
    }
  } catch { /* no/invalid stdin payload → real CLI/CI invocation, continue */ }
  const { warnOnly, scope } = parseArgs(process.argv);
  const rootDir = process.cwd();

  let fileEntries;
  try {
    fileEntries = collectFiles(rootDir, scope);
  } catch (err) {
    process.stderr.write(`[validate-diagram-install-cross-platform] INTERNAL ERROR: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  if (fileEntries.length === 0) {
    process.stdout.write('[validate-diagram-install-cross-platform] PASS — no .cjs files found to scan.\n');
    process.exit(EXIT_PASS);
  }

  const allViolations = [];

  for (const { file, type } of fileEntries) {
    const viols = scanFile(file);
    for (const v of viols) {
      allViolations.push({ file, type, ...v });
    }
  }

  if (allViolations.length === 0) {
    process.stdout.write(`[validate-diagram-install-cross-platform] PASS — ${fileEntries.length} file(s) scanned, no violations.\n`);
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const v of allViolations) {
    process.stderr.write(`[validate-diagram-install-cross-platform] ${level}: ${v.file}:${v.line} [${v.patternId}]\n`);
    process.stderr.write(`  ${v.message}\n`);
  }

  const summary = `[validate-diagram-install-cross-platform] ${allViolations.length} violation(s) in ${fileEntries.length} file(s).`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Fix before release.\n`);
    process.exit(EXIT_FAIL);
  }
}

main();
