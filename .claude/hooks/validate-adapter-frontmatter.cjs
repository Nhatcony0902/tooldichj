#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-adapter-frontmatter.cjs — CI gate for adapter SKILL.md frontmatter coverage.
 *
 * Intended destination: theonekit-release-action/scripts/ (separate repo).
 * Placed here under .claude/hooks/ for development testing and local CI runs.
 * When theonekit-release-action is updated, copy this file to its scripts/ directory
 * and register it in t1k-quality-gates.yml.
 *
 * Purpose:
 *   For every skill directory whose name matches the adapter-candidate regex
 *   (/(^|-)(?:assembly|script|service)-graph$/), assert that SKILL.md has:
 *     A) a valid t1k-adapter block with required keys (engine, capabilities, priority), OR
 *     B) an explicit `t1k-adapter: false` opt-out.
 *   Fail (exit 1) on any candidate with neither. Warn-only mode available for ratchet period.
 *
 * Usage:
 *   node validate-adapter-frontmatter.cjs [--warn-only] [--scope <global|project|both>]
 *
 * Exit codes:
 *   0 — pass (or --warn-only)
 *   1 — one or more frontmatter errors
 *   2 — internal error (bad args, require failure)
 */

const path = require('path');

// ── Exit codes ─────────────────────────────────────────────────────────────

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL = 2;

// ── Candidate regex (must match adapter-contract.md) ──────────────────────

const CANDIDATE_REGEX = /(^|-)(?:assembly|script|service)-graph$/;

// ── Reason classifications ─────────────────────────────────────────────────

/** Reasons that indicate a definite frontmatter error — gate must fail. */
const ERROR_REASONS = new Set([
  'malformed-frontmatter',
  'no-frontmatter',
  'missing-engine',
  'capabilities-not-array',
  'missing-priority',
  'invalid-schema',
]);

/**
 * Reasons that indicate a candidate with no adapter block but also no opt-out.
 * Requires a filename check: if the filename matches CANDIDATE_REGEX → error;
 * otherwise it slipped through (non-candidate, unexpected).
 */
const MISSING_BLOCK_REASONS = new Set([
  'no-adapter-block',
]);

/** Reasons that are acceptable — gate should pass for these. */
const OK_REASONS = new Set([
  'explicit-opt-out',
  'skill-md-not-found', // cannot validate what isn't there — not gate's job
  'read-error',         // IO failure — not a frontmatter issue
  'detect-failed',      // runtime detection, not frontmatter
]);

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
      if (!['global', 'project', 'both'].includes(val)) {
        process.stderr.write(`[validate-adapter-frontmatter] Invalid --scope value: ${val}. Expected: global|project|both\n`);
        process.exit(EXIT_INTERNAL);
      }
      scope = val;
      i++;
    }
  }

  return { warnOnly, scope };
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { warnOnly, scope } = parseArgs(process.argv);

  // Load adapter-discovery — resolves relative to this script's location.
  // In release-action, this path will need to be adjusted to wherever
  // adapter-discovery.cjs is installed (e.g., via require from kit's node_modules).
  let listAllMatches;
  try {
    const discoveryPath = path.resolve(__dirname, '../skills/t1k-preview/scripts/adapter-discovery.cjs');
    ({ listAllMatches } = require(discoveryPath));
  } catch (err) {
    process.stderr.write(`[validate-adapter-frontmatter] INTERNAL ERROR: Cannot load adapter-discovery.cjs: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  let result;
  try {
    result = listAllMatches();
  } catch (err) {
    process.stderr.write(`[validate-adapter-frontmatter] INTERNAL ERROR: listAllMatches() threw: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  const { skipped } = result;

  // Filter skipped entries by requested scope
  const scopedSkipped = scope === 'both'
    ? skipped
    : skipped.filter(e => e.scope === scope);

  const issues = [];

  for (const entry of scopedSkipped) {
    if (OK_REASONS.has(entry.reason)) continue;

    if (ERROR_REASONS.has(entry.reason)) {
      issues.push({
        file: entry.file,
        skillName: entry.skillName,
        reason: entry.reason,
        hint: _fixHint(entry.reason),
        scope: entry.scope,
      });
      continue;
    }

    if (MISSING_BLOCK_REASONS.has(entry.reason)) {
      // Only flag as error if the skill name matches the candidate regex
      if (CANDIDATE_REGEX.test(entry.skillName)) {
        issues.push({
          file: entry.file,
          skillName: entry.skillName,
          reason: entry.reason,
          hint: 'Add a `t1k-adapter:` block to SKILL.md, or add `t1k-adapter: false` to opt out explicitly.',
          scope: entry.scope,
        });
      }
      // Non-candidate with no adapter block is not an error
    }
  }

  // Report
  if (issues.length === 0) {
    process.stdout.write('[validate-adapter-frontmatter] PASS — all adapter-candidate skills have valid frontmatter.\n');
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const issue of issues) {
    const out = warnOnly ? process.stderr : process.stderr;
    out.write(`[validate-adapter-frontmatter] ${level}: ${issue.skillName} (${issue.scope ?? 'unknown'}) — ${issue.reason}\n`);
    out.write(`  file: ${issue.file}\n`);
    out.write(`  fix:  ${issue.hint}\n`);
  }

  const summary = `[validate-adapter-frontmatter] ${issues.length} issue(s) found.`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only mode — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Fix the issues above before release.\n`);
    process.exit(EXIT_FAIL);
  }
}

// ── Fix hints ──────────────────────────────────────────────────────────────

function _fixHint(reason) {
  switch (reason) {
    case 'malformed-frontmatter':
      return 'Fix the YAML syntax in the frontmatter block (--- ... ---).';
    case 'no-frontmatter':
      return 'Add a frontmatter block (--- ... ---) to SKILL.md with `t1k-adapter:` or `t1k-adapter: false`.';
    case 'missing-engine':
      return 'Add `engine: <engine-name>` inside the `t1k-adapter:` block.';
    case 'capabilities-not-array':
      return 'Set `capabilities:` to a YAML array, e.g. `capabilities: [modules, classes]`.';
    case 'missing-priority':
      return 'Add `priority: <integer>` inside the `t1k-adapter:` block (e.g. `priority: 100`).';
    case 'invalid-schema':
      return 'Ensure `t1k-adapter:` is a mapping with `engine`, `capabilities`, and `priority` fields.';
    default:
      return 'See adapter-contract.md for the required SKILL.md frontmatter schema.';
  }
}

main();
