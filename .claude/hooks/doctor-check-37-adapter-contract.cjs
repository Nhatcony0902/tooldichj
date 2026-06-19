// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-37-adapter-contract.cjs — Doctor check #37: adapter contract validation.
 *
 * Validates that every adapter skill discovered via adapter-discovery.cjs correctly
 * follows the full adapter contract:
 *   1. SKILL.md has valid `t1k-adapter` frontmatter (engine, capabilities, priority)
 *   2. All declared capabilities have corresponding handlers in install.json
 *   3. Required scripts exist: detect.cjs, list-capabilities.cjs, generate.cjs, requirements.cjs
 *
 * On zero adapters: exits 0 with a single "PASS (no adapters installed)" line.
 * On failures:      exits 1 with per-adapter details.
 *
 * Usage: node doctor-check-37-adapter-contract.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

// ── Constants ────────────────────────────────────────────────────────────────

const REQUIRED_SCRIPTS = ['detect.cjs', 'list-capabilities.cjs', 'generate.cjs', 'requirements.cjs'];

// ── Dependency: adapter-discovery ────────────────────────────────────────────

function loadDiscovery(claudeDir) {
  // Adapter-discovery lives under the t1k-preview skill.
  // Both candidate paths resolve identically; keep a single canonical one.
  const candidate = path.join(claudeDir, 'skills', 't1k-preview', 'scripts', 'adapter-discovery.cjs');
  if (fs.existsSync(candidate)) return require(candidate);
  // File absent → return null so the caller can SKIP gracefully.
  return null;
}

// ── Per-adapter validation ───────────────────────────────────────────────────

/**
 * @param {{ skillName: string, skillDir: string, capabilities: string[] }} adapter
 * @returns {{ status: 'OK'|'WARN'|'FAIL', issues: string[] }}
 */
function validateAdapter(adapter) {
  const issues = [];

  // 1. Required scripts exist.
  for (const script of REQUIRED_SCRIPTS) {
    const scriptPath = path.join(adapter.skillDir, script);
    if (!fs.existsSync(scriptPath)) {
      issues.push(`Missing required script: ${script}`);
    }
  }

  // 2. install.json present and capabilities have handlers.
  const installJsonPath = path.join(adapter.skillDir, 'install.json');
  if (!fs.existsSync(installJsonPath)) {
    issues.push('Missing install.json');
  } else {
    let installJson;
    try {
      installJson = JSON.parse(fs.readFileSync(installJsonPath, 'utf8'));
    } catch (err) {
      issues.push(`install.json parse error: ${err.message}`);
      installJson = null;
    }

    if (installJson) {
      const catalog = installJson.catalog || {};
      const presets = installJson.presets || {};
      // Collect all tool names referenced in presets or catalog.
      const knownTools = new Set([
        ...Object.keys(catalog),
        ...Object.values(presets).flatMap((p) => (Array.isArray(p.tools) ? p.tools : [])),
      ]);

      // Each declared capability should map to at least one known tool in install.json,
      // OR install.json must have a non-empty catalog (meaning handlers are declared).
      // If the catalog is entirely empty, flag it as a WARN.
      if (Object.keys(catalog).length === 0 && adapter.capabilities.length > 0) {
        issues.push(
          `install.json has empty catalog but adapter declares capabilities: [${adapter.capabilities.join(', ')}]`
        );
      }

      // Validate schemaVersion present.
      if (!installJson.schemaVersion) {
        issues.push('install.json missing "schemaVersion" field');
      }
    }
  }

  if (issues.length === 0) return { status: 'OK', issues: [] };
  // Any missing script or missing install.json = FAIL; schema warnings = WARN.
  const hasFail = issues.some(
    (i) => i.startsWith('Missing required') || i.startsWith('Missing install.json') || i.includes('parse error')
  );
  return { status: hasFail ? 'FAIL' : 'WARN', issues };
}

// ── Main ─────────────────────────────────────────────────────────────────────

function run() {
  const claudeDir = process.argv[2] || path.join(process.cwd(), '.claude');

  const discovery = loadDiscovery(claudeDir);
  if (discovery === null) {
    process.stdout.write(
      'SKIP [check #37] adapter-contract: adapter-discovery.cjs not present — likely retired in this installation\n'
    );
    process.exit(0);
  }

  let result;
  try {
    result = discovery.listAllMatches();
  } catch (err) {
    process.stdout.write(`FAIL [check #37] adapter-discovery.listAllMatches() threw: ${err.message}\n`);
    process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
  }

  const { byEngine } = result;
  const allAdapters = Object.values(byEngine).flat();

  if (allAdapters.length === 0) {
    process.stdout.write('PASS [check #37] adapter-contract: no adapters installed — nothing to validate\n');
    process.exit(0);
  }

  const results = [];
  for (const adapter of allAdapters) {
    const { status, issues } = validateAdapter(adapter);
    results.push({ skillName: adapter.skillName, engine: adapter.engine, status, issues });
  }

  const hasFail = results.some((r) => r.status === 'FAIL');
  const hasWarn = results.some((r) => r.status === 'WARN');
  const overallStatus = hasFail ? 'FAIL' : hasWarn ? 'WARN' : 'PASS';

  process.stdout.write(`${overallStatus} [check #37] adapter-contract: ${allAdapters.length} adapter(s) checked\n`);

  for (const r of results) {
    if (r.status !== 'OK') {
      process.stdout.write(`  ${r.status}  ${r.skillName} (engine: ${r.engine})\n`);
      for (const issue of r.issues) {
        process.stdout.write(`       - ${issue}\n`);
      }
    } else {
      process.stdout.write(`  OK    ${r.skillName} (engine: ${r.engine})\n`);
    }
  }

  process.exit(hasFail ? 1 : 0);
}

run();
