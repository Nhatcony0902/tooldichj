#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-no-hardcoded-adapters.cjs — CI gate: Rule 6 — no hardcoded engine maps.
 *
 * Intended destination: theonekit-release-action/scripts/
 * Placed under .claude/hooks/ for development testing.
 *
 * Purpose:
 *   Blocks release if core source introduces hardcoded engine/adapter maps.
 *   The engine-token set is DERIVED at gate-run time from fixtures — never hardcoded
 *   in this file (H7 resolution from red-team-review.md §H7).
 *
 * Engine-token discovery order:
 *   1. Scan scripts/fixtures/adapters/ dirs for SKILL.md t1k-adapter.engine values.
 *   2. Scan scripts/fixtures/adapters/ dirs for install.json engine values.
 *   3. Read known-engines-seed.json (seed for released engines without fixtures yet).
 *
 * Scanned targets: .claude/ tree, all .cjs files (excluding install-handlers/, fixtures/, tests/)
 *
 * Usage:
 *   node validate-no-hardcoded-adapters.cjs [--warn-only] [--fixtures-dir <path>]
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

// Min engine-set size to require a multi-engine match (avoids false positives on single names)
const MIN_MATCH_COUNT = 2;

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let warnOnly = false;
  let fixturesDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--warn-only') {
      warnOnly = true;
    } else if (args[i] === '--fixtures-dir' && args[i + 1]) {
      fixturesDir = args[i + 1];
      i++;
    }
  }

  return { warnOnly, fixturesDir };
}

// ── Engine-token discovery ─────────────────────────────────────────────────

/**
 * Extract t1k-adapter.engine value from SKILL.md frontmatter.
 * Minimal parser — only needs to find `engine:` inside `t1k-adapter:` block.
 */
function extractEngineFromSkillMd(filePath) {
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!fmMatch) return null;
    const block = fmMatch[1];
    // Find t1k-adapter block then engine line within it
    const adapterMatch = block.match(/^t1k-adapter:\s*\n((?:[ \t]+.+\n?)*)/m);
    if (!adapterMatch) return null;
    const engineMatch = adapterMatch[1].match(/engine:\s*(\S+)/);
    return engineMatch ? engineMatch[1].trim() : null;
  } catch {
    return null;
  }
}

/**
 * Extract engine value from install.json.
 */
function extractEngineFromInstallJson(filePath) {
  try {
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return data.engine || null;
  } catch {
    return null;
  }
}

/**
 * Build engine-token set from fixtures and seed file.
 * Never hardcodes engine names inside this function.
 */
function discoverEngineTokens(rootDir, fixturesDir) {
  const tokens = new Set();

  // 1. Scan adapter fixtures directory
  const adaptFixturesDir = fixturesDir
    ? path.resolve(fixturesDir)
    : path.join(rootDir, 'scripts', 'fixtures', 'adapters');

  if (fs.existsSync(adaptFixturesDir)) {
    for (const entry of fs.readdirSync(adaptFixturesDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const adapterDir = path.join(adaptFixturesDir, entry.name);

      const skillMdPath = path.join(adapterDir, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        const engine = extractEngineFromSkillMd(skillMdPath);
        if (engine) tokens.add(engine);
      }

      const installJsonPath = path.join(adapterDir, 'install.json');
      if (fs.existsSync(installJsonPath)) {
        const engine = extractEngineFromInstallJson(installJsonPath);
        if (engine) tokens.add(engine);
      }
    }
  }

  // 2. Also scan t1k-preview skill for any installed adapter fixtures
  const previewScriptsFixtures = path.join(
    rootDir, '.claude', 'skills', 't1k-preview', 'scripts', 'fixtures', 'adapters'
  );
  if (fs.existsSync(previewScriptsFixtures)) {
    for (const entry of fs.readdirSync(previewScriptsFixtures, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const adapterDir = path.join(previewScriptsFixtures, entry.name);
      const skillMd = path.join(adapterDir, 'SKILL.md');
      if (fs.existsSync(skillMd)) {
        const engine = extractEngineFromSkillMd(skillMd);
        if (engine) tokens.add(engine);
      }
    }
  }

  // 3. Read seed file (migration aid for engines released before fixtures existed)
  const seedPath = path.join(rootDir, 'scripts', 'known-engines-seed.json');
  if (fs.existsSync(seedPath)) {
    try {
      const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
      if (Array.isArray(seed.engines)) {
        for (const e of seed.engines) tokens.add(e);
      }
    } catch {
      // Seed read failure is non-fatal — tokens from fixtures are still valid
    }
  }

  // Fallback: if no tokens discovered, check install.json presets as last resort
  if (tokens.size === 0) {
    const coreInstall = path.join(rootDir, '.claude', 'skills', 't1k-preview', 'install.json');
    if (fs.existsSync(coreInstall)) {
      try {
        const data = JSON.parse(fs.readFileSync(coreInstall, 'utf8'));
        if (data.presets) {
          for (const key of Object.keys(data.presets)) {
            // Only add keys that look like engine names (not generic like 'full', 'minimal')
            if (!['full', 'minimal', 'designer'].includes(key)) {
              tokens.add(key);
            }
          }
        }
      } catch {
        // ignore
      }
    }
  }

  return tokens;
}

// ── Allow-list ─────────────────────────────────────────────────────────────

/**
 * Returns true if the file path should be excluded from scanning.
 */
function isAllowListed(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  const allowPatterns = [
    '/install-handlers/',   // legitimate named-handler registry
    '/__tests__/',
    '/scripts/fixtures/',
    '.test.cjs',
    '.spec.cjs',
    '/known-engines-seed.json',
    // The gate script itself is allowed by location (runs only from release-action)
  ];
  return allowPatterns.some(p => normalized.includes(p));
}

// ── File collection ────────────────────────────────────────────────────────

function collectCjsFiles(dir, out, depth) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectCjsFiles(full, out, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith('.cjs')) {
      if (!isAllowListed(full)) out.push(full);
    }
  }
}

// ── Scan a single file ─────────────────────────────────────────────────────

/**
 * Checks for hardcoded engine maps: object literals or arrays with ≥MIN_MATCH_COUNT engine tokens.
 * Also checks for `engine === 'unity'` style conditional branches.
 */
function scanFile(filePath, engineTokens) {
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return [];
  }

  if (engineTokens.size < MIN_MATCH_COUNT) return []; // not enough tokens to detect maps

  const violations = [];
  const lines = content.split('\n');
  const tokenArray = [...engineTokens];

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    const line = lines[i];

    // Skip comment lines
    const trimmed = line.trimStart();
    if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) continue;

    // Check: engine === '<token>' conditional branch
    for (const token of tokenArray) {
      const condPattern = new RegExp(`engine\\s*===?\\s*['"\`]${token}['"\`]`);
      if (condPattern.test(line)) {
        violations.push({
          line: lineNum,
          rule: 'engine-conditional',
          detail: `Hardcoded engine conditional: engine === '${token}'. Use adapter-discovery pattern instead.`,
        });
        break; // one violation per line
      }
    }

    // Check: object literal with ≥2 engine-token keys: { unity: ..., cocos: ... }
    const matchedObjectKeys = tokenArray.filter(t => {
      const kp = new RegExp(`['"\`]?${t}['"\`]?\\s*:`);
      return kp.test(line);
    });
    if (matchedObjectKeys.length >= MIN_MATCH_COUNT) {
      violations.push({
        line: lineNum,
        rule: 'hardcoded-engine-object',
        detail: `Object literal has ${matchedObjectKeys.length} engine keys: [${matchedObjectKeys.join(', ')}]. Use data-driven discovery.`,
      });
    }

    // Check: array literal with ≥2 engine tokens: ['unity', 'cocos']
    const matchedArrayItems = tokenArray.filter(t => {
      const ap = new RegExp(`['"\`]${t}['"\`]`);
      return ap.test(line);
    });
    if (matchedArrayItems.length >= MIN_MATCH_COUNT) {
      // Only flag if it looks like an array literal (not just prose)
      if (/\[/.test(line)) {
        violations.push({
          line: lineNum,
          rule: 'hardcoded-engine-array',
          detail: `Array literal has ${matchedArrayItems.length} engine tokens: [${matchedArrayItems.join(', ')}]. Derive at runtime from discovery.`,
        });
      }
    }
  }

  return violations;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { warnOnly, fixturesDir } = parseArgs(process.argv);
  const rootDir = process.cwd();

  let engineTokens;
  try {
    engineTokens = discoverEngineTokens(rootDir, fixturesDir);
  } catch (err) {
    process.stderr.write(`[validate-no-hardcoded-adapters] INTERNAL ERROR discovering tokens: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  if (engineTokens.size === 0) {
    process.stdout.write('[validate-no-hardcoded-adapters] SKIP — no engine tokens discoverable from fixtures or seed. Add fixtures to enable this gate.\n');
    process.exit(EXIT_PASS);
  }

  process.stdout.write(`[validate-no-hardcoded-adapters] Discovered ${engineTokens.size} engine tokens: [${[...engineTokens].join(', ')}]\n`);

  const claudeDir = path.join(rootDir, '.claude');
  if (!fs.existsSync(claudeDir)) {
    process.stdout.write('[validate-no-hardcoded-adapters] PASS — no .claude directory to scan.\n');
    process.exit(EXIT_PASS);
  }

  const files = [];
  collectCjsFiles(claudeDir, files, 0);

  if (files.length === 0) {
    process.stdout.write('[validate-no-hardcoded-adapters] PASS — no .cjs files to scan.\n');
    process.exit(EXIT_PASS);
  }

  const allViolations = [];

  for (const file of files) {
    const viols = scanFile(file, engineTokens);
    for (const v of viols) {
      allViolations.push({ file, ...v });
    }
  }

  if (allViolations.length === 0) {
    process.stdout.write(`[validate-no-hardcoded-adapters] PASS — ${files.length} file(s) scanned, no hardcoded engine maps.\n`);
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const v of allViolations) {
    process.stderr.write(`[validate-no-hardcoded-adapters] ${level}: ${v.file}:${v.line} [${v.rule}]\n`);
    process.stderr.write(`  ${v.detail}\n`);
  }

  const summary = `[validate-no-hardcoded-adapters] ${allViolations.length} violation(s) found.`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Rule 6: use adapter-discovery, not hardcoded maps.\n`);
    process.exit(EXIT_FAIL);
  }
}

main();
