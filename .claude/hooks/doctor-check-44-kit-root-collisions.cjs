// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-44-kit-root-collisions.cjs — Doctor check #44: kit-root collision detection.
 *
 * Companion to release-action gate #11 (verify-no-kit-root-collisions.cjs),
 * but runs against the LIVE installed state under `~/.claude/` instead of
 * source. Detects filename collisions across installed kits that the release-
 * action flatten step's kit-prefix rename would have prevented.
 *
 * Targets (files that must be uniquely scoped per kit):
 *   - .claude/hooks/<basename>          → expect {kit-short}-<basename> for non-core
 *   - .claude/agents/<basename>         → expect {kit-short}-<basename> or {kit-short}-{module}-<basename>
 *   - .claude/skills/<skill-name>/*     → skill dirs themselves are unprefixed; files inside are scoped
 *
 * Exempt (by plan A2.4): lifecycle.json, canonical-files.json — these use
 * additive merge patterns, not filename uniqueness.
 *
 * Detection logic:
 *   1. Read metadata.json → installedKits[] (if present) to know which kits claim files.
 *   2. For each entry in metadata.json → installedFiles[], track the (kit, path) pair.
 *   3. Any two entries sharing the same path-with-null-kit-prefix but different kits → collision.
 *
 * Emits:
 *   [t1k:doctor:kit-root-collisions status=ok|warn|fail count=N]
 *
 * Exit codes:
 *   0 — no collisions (OK) or single-kit install (SKIP)
 *   1 — collisions detected (FAIL)
 *
 * Usage:
 *   node doctor-check-44-kit-root-collisions.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

const { resolveClaudeDir } = require('./telemetry-utils.cjs');

const CHECK_ID = 44;
const CHECK_NAME = 'kit-root-collisions';

const EXEMPT_BASENAMES = new Set([
  'lifecycle.json',
  'canonical-files.json',
]);

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
}

function marker(status, count) {
  process.stdout.write(`[t1k:doctor:kit-root-collisions status=${status} count=${count}]\n`);
}

function resolveDir(argvPath) {
  if (argvPath) return argvPath;
  const resolved = resolveClaudeDir();
  return resolved ? resolved.claudeDir : path.join(process.cwd(), '.claude');
}

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    return { _error: err.message };
  }
}

function run() {
  const claudeDir = resolveDir(process.argv[2]);
  if (!fs.existsSync(claudeDir)) {
    emit('SKIP', `.claude/ not found at ${claudeDir}`);
    marker('ok', 0);
    process.exit(0);
  }

  const metadataPath = path.join(claudeDir, 'metadata.json');
  if (!fs.existsSync(metadataPath)) {
    emit('SKIP', 'metadata.json not found — cannot infer installed kits');
    marker('ok', 0);
    process.exit(0);
  }

  const meta = readJson(metadataPath);
  if (meta._error) {
    emit('WARN', `metadata.json unreadable: ${meta._error}`);
    marker('warn', 0);
    process.exit(0);
  }

  const installed = Array.isArray(meta.installedFiles) ? meta.installedFiles : [];
  if (installed.length === 0) {
    emit('SKIP', 'installedFiles[] empty');
    marker('ok', 0);
    process.exit(0);
  }

  // Build (basename → [{kit, path}]) map; if one basename maps to 2+ kits, collision.
  const byBasename = new Map();
  for (const entry of installed) {
    if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') continue;
    const basename = path.basename(entry.path);
    if (EXEMPT_BASENAMES.has(basename)) continue;
    const kit = typeof entry.kit === 'string' ? entry.kit : 'unknown';
    if (!byBasename.has(basename)) byBasename.set(basename, []);
    byBasename.get(basename).push({ kit, path: entry.path });
  }

  const collisions = [];
  for (const [basename, entries] of byBasename) {
    const kits = new Set(entries.map((e) => e.kit));
    if (kits.size > 1) {
      collisions.push({ basename, entries });
    }
  }

  if (collisions.length === 0) {
    emit('OK', `no kit-root collisions across ${byBasename.size} filename(s)`);
    marker('ok', 0);
    process.exit(0);
  }

  emit('FAIL', `${collisions.length} collision(s) detected`);
  for (const c of collisions) {
    const kits = c.entries.map((e) => `${e.kit}:${e.path}`).join(', ');
    emit('FAIL', `  ${c.basename} → ${kits}`);
  }
  emit('FAIL', 'Fix by reinstalling affected kits via the CLI (which applies kit-prefix rename).');
  marker('fail', collisions.length);
  process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
}

run();
