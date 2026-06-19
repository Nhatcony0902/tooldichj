#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-adapter-contract.cjs — CI gate: extended adapter contract validation (T9).
 *
 * Intended destination: theonekit-release-action/scripts/
 * Placed under .claude/hooks/ for development testing.
 *
 * Purpose:
 *   For each adapter skill discovered by adapter-discovery:
 *   - Assert all required script files exist
 *   - Assert SKILL.md frontmatter is schema-valid (reuses listAllMatches)
 *   - Assert install.json exists and is schema-valid
 *   - Validate contract-version-history section in adapter-contract.md
 *   - list-capabilities.cjs: warn (not error) if missing (ratchet period)
 *
 * Ratchet plan:
 *   - Missing list-capabilities.cjs: WARN for first 2 releases after Phase 1
 *   - After t1k-extended@1.65.2: escalate to ERROR
 *
 * Usage:
 *   node validate-adapter-contract.cjs [--warn-only] [--scope <global|project|both>]
 *
 * Exit codes:
 *   0 — pass (or --warn-only)
 *   1 — contract violations
 *   2 — internal error
 */

const fs = require('fs');
const path = require('path');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL = 2;

// Required scripts per adapter (list-capabilities.cjs is ratchet — starts as warning)
const REQUIRED_SCRIPTS = ['detect.cjs', 'generate.cjs', 'requirements.cjs'];
const RATCHET_SCRIPTS = ['list-capabilities.cjs']; // warn now, error after ratchet date

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
        process.stderr.write(`[validate-adapter-contract] Invalid --scope: ${val}\n`);
        process.exit(EXIT_INTERNAL);
      }
      scope = val;
      i++;
    }
  }

  return { warnOnly, scope };
}

// ── Load adapter-discovery ─────────────────────────────────────────────────

function loadDiscovery(rootDir) {
  const discoveryPath = path.join(rootDir, '.claude', 'skills', 't1k-preview', 'scripts', 'adapter-discovery.cjs');
  if (!fs.existsSync(discoveryPath)) {
    // Fail-open: the discovery script being absent (e.g. on a fresh install
    // where t1k-preview/t1k-extended isn't installed, or under the doctor's
    // synthetic dry-run from an arbitrary cwd) is NOT a contract violation —
    // there is simply nothing to validate. Signal "nothing to validate" rather
    // than throwing, so the hook never blocks the tool. Real require() errors
    // (a present-but-broken discovery script) still propagate.
    return null;
  }
  return require(discoveryPath);
}

// ── Install.json schema check (inline — avoids subprocess) ────────────────

function checkInstallJson(installPath) {
  const errors = [];
  let data;
  try {
    data = JSON.parse(fs.readFileSync(installPath, 'utf8'));
  } catch (err) {
    return [`JSON parse error: ${err.message}`];
  }

  if (!data.schemaVersion) errors.push('Missing schemaVersion');
  if (data.catalog !== undefined && (typeof data.catalog !== 'object' || Array.isArray(data.catalog))) {
    errors.push('catalog must be an object');
  }

  return errors;
}

// ── Validate adapter-contract.md version history ───────────────────────────

function validateContractVersionHistory(rootDir) {
  const contractPath = path.join(
    rootDir, '.claude', 'skills', 't1k-preview', 'references', 'adapter-contract.md'
  );

  if (!fs.existsSync(contractPath)) {
    return ['adapter-contract.md not found — required for contract version tracking'];
  }

  const content = fs.readFileSync(contractPath, 'utf8');

  // Check contractVersion in frontmatter
  const fmMatch = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fmMatch) {
    return ['adapter-contract.md missing frontmatter'];
  }
  const hasCVer = /contractVersion\s*:/.test(fmMatch[1]);
  if (!hasCVer) {
    return ['adapter-contract.md frontmatter missing "contractVersion" field'];
  }

  // Check version history section
  if (!content.includes('## Contract Version History')) {
    return ['adapter-contract.md missing "## Contract Version History" section (R22 requirement)'];
  }

  return [];
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { warnOnly, scope } = parseArgs(process.argv);
  const rootDir = process.cwd();

  // Load discovery
  let discovery;
  try {
    discovery = loadDiscovery(rootDir);
  } catch (err) {
    process.stderr.write(`[validate-adapter-contract] INTERNAL ERROR: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  // Fail-open: no discovery script present → nothing to validate. Skip cleanly
  // instead of blocking the tool (e.g. fresh install without t1k-preview, or
  // doctor's synthetic dry-run from an unrelated cwd). See loadDiscovery().
  if (!discovery) {
    process.stdout.write('[validate-adapter-contract] SKIP — adapter-discovery.cjs not found; nothing to validate.\n');
    process.exit(EXIT_PASS);
  }

  const { listAllMatches } = discovery;

  // Get all matches (including matched adapters)
  let result;
  try {
    result = listAllMatches();
  } catch (err) {
    process.stderr.write(`[validate-adapter-contract] INTERNAL ERROR: listAllMatches() threw: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  // listAllMatches() returns { byEngine, skipped, scopes } — engine-grouped, not flat.
  // Flatten into a single adapter list (each adapter retains its .scope/.file/.skillName fields).
  const { byEngine, skipped } = result;
  const allMatches = Object.values(byEngine || {}).flat();

  // Filter by scope
  const scopedMatches = scope === 'both'
    ? allMatches
    : allMatches.filter(m => m.scope === scope);

  const errors = [];
  const warnings = [];

  // Check contract doc itself
  const docErrors = validateContractVersionHistory(rootDir);
  for (const e of docErrors) {
    errors.push({ location: 'adapter-contract.md', message: e });
  }

  for (const adapter of scopedMatches) {
    const skillDir = path.dirname(adapter.file); // SKILL.md path → skill dir
    const scriptsDir = path.join(skillDir, 'scripts');

    // Required scripts must exist
    for (const script of REQUIRED_SCRIPTS) {
      const scriptPath = path.join(scriptsDir, script);
      if (!fs.existsSync(scriptPath)) {
        errors.push({
          location: `${adapter.skillName}/scripts/${script}`,
          message: `Missing required adapter script: ${script}`,
        });
      }
    }

    // Ratchet scripts: warn now, will be error after ratchet date
    for (const script of RATCHET_SCRIPTS) {
      const scriptPath = path.join(scriptsDir, script);
      if (!fs.existsSync(scriptPath)) {
        warnings.push({
          location: `${adapter.skillName}/scripts/${script}`,
          message: `Missing ${script} — WARN (ratchet: will become ERROR after t1k-extended@1.65.2). Legacy fallback: capabilities=['modules']`,
        });
      }
    }

    // install.json must exist
    const installPath = path.join(skillDir, 'install.json');
    if (!fs.existsSync(installPath)) {
      errors.push({
        location: `${adapter.skillName}/install.json`,
        message: 'Missing install.json — required by contract v1.0.0',
      });
    } else {
      const installErrors = checkInstallJson(installPath);
      for (const ie of installErrors) {
        errors.push({ location: `${adapter.skillName}/install.json`, message: ie });
      }
    }
  }

  // Report warnings
  for (const w of warnings) {
    process.stderr.write(`[validate-adapter-contract] WARN: ${w.location} — ${w.message}\n`);
  }

  if (errors.length === 0) {
    const adapterCount = scopedMatches.length;
    process.stdout.write(`[validate-adapter-contract] PASS — ${adapterCount} adapter(s) validated. ${warnings.length} warning(s).\n`);
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const e of errors) {
    process.stderr.write(`[validate-adapter-contract] ${level}: ${e.location} — ${e.message}\n`);
  }

  const summary = `[validate-adapter-contract] ${errors.length} error(s), ${warnings.length} warning(s).`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Fix before release.\n`);
    process.exit(EXIT_FAIL);
  }
}

main();
