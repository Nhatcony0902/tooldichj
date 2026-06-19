#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * validate-diagram-meta-schema.cjs — CI gate for .t1k-diagram-meta.json schema validity.
 *
 * Intended destination: theonekit-release-action/scripts/
 * Placed under .claude/hooks/ for development testing.
 *
 * Purpose:
 *   Validates .t1k-diagram-meta.json files found in any docs/diagrams/ directories.
 *   Schema requirements (from refresh-orchestrator.md §"Meta File Schema"):
 *     - timestamp: ISO8601 string
 *     - git_sha: string or null
 *     - adapters: array of strings
 *     - out_dir: non-empty string
 *     - t1k_preview_version: non-empty semver-like string
 *     - generated: object where each value has { sha256: 64-char hex, generatedAt: ISO8601 }
 *   Security: path traversal guard — no keys in generated with ".."
 *
 * Usage:
 *   node validate-diagram-meta-schema.cjs [--warn-only] [--dir <path>]
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

const ISO8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const META_FILENAME = '.t1k-diagram-meta.json';

// ── Argument parsing ───────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = argv.slice(2);
  let warnOnly = false;
  let searchDir = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--warn-only') {
      warnOnly = true;
    } else if (args[i] === '--dir' && args[i + 1]) {
      searchDir = args[i + 1];
      i++;
    }
  }

  return { warnOnly, searchDir };
}

// ── Find meta files ────────────────────────────────────────────────────────

function findMetaFiles(rootDir) {
  const found = [];

  // Scan recursively for docs/diagrams/.t1k-diagram-meta.json
  scanForMeta(rootDir, found, 0);

  return found;
}

function scanForMeta(dir, out, depth) {
  if (depth > 8) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.t1k-diagram-meta.json') continue;
    const full = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      scanForMeta(full, out, depth + 1);
    } else if (entry.isFile() && entry.name === META_FILENAME) {
      out.push(full);
    }
  }
}

// ── Schema validation ──────────────────────────────────────────────────────

function validateMetaFile(filePath) {
  const errors = [];

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return [{ field: '(parse)', message: `JSON parse error: ${err.message}` }];
  }

  // timestamp — ISO8601
  if (typeof data.timestamp !== 'string' || !ISO8601_RE.test(data.timestamp)) {
    errors.push({ field: 'timestamp', message: `Must be ISO8601 string, got: ${JSON.stringify(data.timestamp)}` });
  }

  // git_sha — string or null
  if (data.git_sha !== null && typeof data.git_sha !== 'string') {
    errors.push({ field: 'git_sha', message: `Must be string or null, got: ${typeof data.git_sha}` });
  }

  // adapters — array of strings
  if (!Array.isArray(data.adapters)) {
    errors.push({ field: 'adapters', message: 'Must be an array' });
  } else {
    for (let i = 0; i < data.adapters.length; i++) {
      if (typeof data.adapters[i] !== 'string') {
        errors.push({ field: `adapters[${i}]`, message: 'Each adapter must be a string' });
      }
    }
  }

  // out_dir — non-empty string
  if (typeof data.out_dir !== 'string' || data.out_dir.trim() === '') {
    errors.push({ field: 'out_dir', message: 'Must be a non-empty string' });
  }

  // t1k_preview_version — non-empty semver-like string
  if (typeof data.t1k_preview_version !== 'string' || data.t1k_preview_version.trim() === '') {
    errors.push({ field: 't1k_preview_version', message: 'Must be a non-empty string' });
  }

  // generated — object with per-file entries
  if (typeof data.generated !== 'object' || data.generated === null || Array.isArray(data.generated)) {
    errors.push({ field: 'generated', message: 'Must be an object' });
  } else {
    for (const [key, value] of Object.entries(data.generated)) {
      // Path traversal guard
      if (key.includes('..')) {
        errors.push({ field: `generated["${key}"]`, message: `Path traversal detected in key: "${key}"` });
        continue;
      }

      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        errors.push({ field: `generated["${key}"]`, message: 'Each generated entry must be an object' });
        continue;
      }

      // sha256 — 64-char hex
      if (typeof value.sha256 !== 'string' || !SHA256_RE.test(value.sha256)) {
        errors.push({ field: `generated["${key}"].sha256`, message: `Must be 64-char hex string, got: ${JSON.stringify(value.sha256)}` });
      }

      // generatedAt — ISO8601
      if (typeof value.generatedAt !== 'string' || !ISO8601_RE.test(value.generatedAt)) {
        errors.push({ field: `generated["${key}"].generatedAt`, message: `Must be ISO8601 string, got: ${JSON.stringify(value.generatedAt)}` });
      }
    }
  }

  return errors;
}

// ── Main ───────────────────────────────────────────────────────────────────

function main() {
  const { warnOnly, searchDir } = parseArgs(process.argv);
  const rootDir = searchDir ? path.resolve(searchDir) : process.cwd();

  let metaFiles;
  try {
    metaFiles = findMetaFiles(rootDir);
  } catch (err) {
    process.stderr.write(`[validate-diagram-meta-schema] INTERNAL ERROR: ${err.message}\n`);
    process.exit(EXIT_INTERNAL);
  }

  if (metaFiles.length === 0) {
    process.stdout.write('[validate-diagram-meta-schema] PASS — no .t1k-diagram-meta.json files found.\n');
    process.exit(EXIT_PASS);
  }

  const allErrors = [];

  for (const file of metaFiles) {
    const errors = validateMetaFile(file);
    for (const e of errors) {
      allErrors.push({ file, ...e });
    }
  }

  if (allErrors.length === 0) {
    process.stdout.write(`[validate-diagram-meta-schema] PASS — ${metaFiles.length} meta file(s) valid.\n`);
    process.exit(EXIT_PASS);
  }

  const level = warnOnly ? 'WARN' : 'ERROR';
  for (const e of allErrors) {
    process.stderr.write(`[validate-diagram-meta-schema] ${level}: ${e.file} — ${e.field}: ${e.message}\n`);
  }

  const summary = `[validate-diagram-meta-schema] ${allErrors.length} error(s) across ${metaFiles.length} file(s).`;
  if (warnOnly) {
    process.stderr.write(`${summary} (warn-only — not blocking)\n`);
    process.exit(EXIT_PASS);
  } else {
    process.stderr.write(`${summary} Fix before release.\n`);
    process.exit(EXIT_FAIL);
  }
}

main();
