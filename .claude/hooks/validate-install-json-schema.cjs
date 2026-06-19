#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-install-json-schema.cjs — CI gate for install.json schema validity.
 *
 * Intended destination: theonekit-release-action/scripts/
 * Placed under .claude/hooks/ for development testing.
 *
 * Purpose:
 *   Validates all install.json files for adapter skills. Validates structure only
 *   (BLOCKER 1 resolution: does NOT validate method against a closed enum — open string).
 *
 * Validates:
 *   - schemaVersion present
 *   - catalog entries: handler, version (non-empty, NOT "RESEARCH_NEEDED" in release mode),
 *     verify (object with command), prerequisites (array)
 *   - presets: each tool references catalog entry
 *   - sha256 fields are 64-char hex when present
 *   - version != "latest" (BLOCKER 4: version pinning mandatory)
 *
 * Usage:
 *   node validate-install-json-schema.cjs [--warn-only] [--allow-research-needed]
 *
 * Exit codes:
 *   0 — pass (or --warn-only)
 *   1 — schema violations
 *   2 — internal error
 */

const fs = require('fs');
const path = require('path');

const EXIT_PASS = 0;
const EXIT_FAIL = 1;
const EXIT_INTERNAL = 2;

const SHA256_RE = /^[0-9a-f]{64}$/i;
const VERSION_BANNED = new Set(['latest', 'RESEARCH_NEEDED', '*']);

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let warnOnly = false;
  let allowResearchNeeded = false;

  for (const arg of args) {
    if (arg === '--warn-only') warnOnly = true;
    if (arg === '--allow-research-needed') allowResearchNeeded = true;
  }

  return { warnOnly, allowResearchNeeded };
}

// ── Find install.json files ────────────────────────────────────────────────

function findInstallJsonFiles(rootDir) {
  const found = [];
  const skillsDir = path.join(rootDir, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) return found;

  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const installPath = path.join(skillsDir, entry.name, 'install.json');
    if (fs.existsSync(installPath)) {
      found.push({ skillName: entry.name, file: installPath });
    }
  }

  return found;
}

// ── Schema validation ──────────────────────────────────────────────────────

function validateInstallJson(filePath, skillName, allowResearchNeeded) {
  const errors = [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return [{ field: '(parse)', message: `JSON parse error: ${err.message}` }];
  }

  // schemaVersion
  if (!data.schemaVersion) {
    errors.push({ field: 'schemaVersion', message: 'Missing required field "schemaVersion"' });
  }

  // catalog validation
  if (data.catalog !== undefined) {
    if (typeof data.catalog !== 'object' || Array.isArray(data.catalog)) {
      errors.push({ field: 'catalog', message: '"catalog" must be an object' });
    } else {
      for (const [toolName, entry] of Object.entries(data.catalog)) {
        const prefix = `catalog.${toolName}`;

        if (typeof entry.handler !== 'string' || entry.handler.trim() === '') {
          errors.push({ field: `${prefix}.handler`, message: 'handler must be a non-empty string (open enum — any method is valid)' });
        }

        if (typeof entry.version !== 'string' || entry.version.trim() === '') {
          errors.push({ field: `${prefix}.version`, message: 'version must be a non-empty string (BLOCKER 4: pin versions)' });
        } else if (entry.version === 'latest') {
          errors.push({ field: `${prefix}.version`, message: '"latest" is forbidden — pin to exact version (BLOCKER 4)' });
        } else if (!allowResearchNeeded && entry.version === 'RESEARCH_NEEDED') {
          errors.push({ field: `${prefix}.version`, message: '"RESEARCH_NEEDED" must be resolved before release (use --allow-research-needed for dev)' });
        }

        if (entry.verify !== undefined) {
          if (typeof entry.verify !== 'object' || Array.isArray(entry.verify)) {
            errors.push({ field: `${prefix}.verify`, message: 'verify must be an object' });
          } else if (typeof entry.verify.command !== 'string' || entry.verify.command.trim() === '') {
            errors.push({ field: `${prefix}.verify.command`, message: 'verify.command must be a non-empty string' });
          }
        }

        if (entry.prerequisites !== undefined && !Array.isArray(entry.prerequisites)) {
          errors.push({ field: `${prefix}.prerequisites`, message: 'prerequisites must be an array' });
        } else if (Array.isArray(entry.prerequisites)) {
          for (let idx = 0; idx < entry.prerequisites.length; idx++) {
            const prereq = entry.prerequisites[idx];
            if (typeof prereq.check !== 'string' || prereq.check.trim() === '') {
              errors.push({ field: `${prefix}.prerequisites[${idx}].check`, message: 'prerequisite.check must be a non-empty string' });
            }
          }
        }

        // sha256 validation — 64-char hex when present
        if (entry.sha256 !== undefined) {
          if (typeof entry.sha256 === 'string') {
            if (entry.sha256 !== 'RESEARCH_NEEDED' && !SHA256_RE.test(entry.sha256)) {
              errors.push({ field: `${prefix}.sha256`, message: `sha256 must be 64-char hex string, got: "${entry.sha256}"` });
            } else if (!allowResearchNeeded && entry.sha256 === 'RESEARCH_NEEDED') {
              errors.push({ field: `${prefix}.sha256`, message: '"RESEARCH_NEEDED" sha256 must be resolved before release' });
            }
          } else if (typeof entry.sha256 === 'object' && !Array.isArray(entry.sha256)) {
            // Per-platform sha256 map
            for (const [platform, hash] of Object.entries(entry.sha256)) {
              if (hash !== 'RESEARCH_NEEDED' && !SHA256_RE.test(hash)) {
                errors.push({ field: `${prefix}.sha256.${platform}`, message: `sha256 must be 64-char hex or "RESEARCH_NEEDED", got: "${hash}"` });
              } else if (!allowResearchNeeded && hash === 'RESEARCH_NEEDED') {
                errors.push({ field: `${prefix}.sha256.${platform}`, message: '"RESEARCH_NEEDED" sha256 must be resolved before release' });
              }
            }
          }
        }
      }
    }
  }

  // presets validation — each referenced tool must exist in catalog
  if (data.presets !== undefined) {
    if (typeof data.presets !== 'object' || Array.isArray(data.presets)) {
      errors.push({ field: 'presets', message: '"presets" must be an object' });
    } else if (data.catalog) {
      for (const [presetName, preset] of Object.entries(data.presets)) {
        if (!Array.isArray(preset.tools)) {
          errors.push({ field: `presets.${presetName}.tools`, message: 'preset.tools must be an array' });
          continue;
        }
        if (!preset.derivedAtRuntime) {
          for (const toolRef of preset.tools) {
            if (!data.catalog[toolRef]) {
              errors.push({ field: `presets.${presetName}.tools`, message: `tool "${toolRef}" not found in catalog` });
            }
          }
        }
      }
    }
  }

  return errors;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { warnOnly, allowResearchNeeded } = parseArgs(process.argv);
  const rootDir = process.cwd();

  let installFiles;
  try {
    installFiles = findInstallJsonFiles(rootDir);
  } catch (err) {
    process.stderr.write(`[validate-install-json-schema] INTERNAL ERROR: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  if (installFiles.length === 0) {
    process.stdout.write('[validate-install-json-schema] PASS — no install.json files found.\n');
    process.exit(EXIT_PASS);
  }

  const allErrors = [];

  for (const { skillName, file } of installFiles) {
    const errors = validateInstallJson(file, skillName, allowResearchNeeded);
    for (const e of errors) {
      allErrors.push({ file, skillName, ...e });
    }
  }

  if (allErrors.length === 0) {
    process.stdout.write(`[validate-install-json-schema] PASS — ${installFiles.length} install.json file(s) valid.\n`);
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const e of allErrors) {
    process.stderr.write(`[validate-install-json-schema] ${level}: ${e.skillName} — ${e.field}: ${e.message}\n`);
    process.stderr.write(`  file: ${e.file}\n`);
  }

  const summary = `[validate-install-json-schema] ${allErrors.length} error(s) across ${installFiles.length} file(s).`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Fix before release.\n`);
    process.exit(EXIT_FAIL);
  }
}

main();
