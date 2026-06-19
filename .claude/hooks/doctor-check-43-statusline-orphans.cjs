// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-43-statusline-orphans.cjs — Doctor check #43: statusline orphan detection.
 *
 * Complements check #42 (statusline wiring): #42 confirms the happy path
 * (statusline.cjs tracked with ownership=kit, settings.json wired), this check
 * confirms there are NO residual files from the pre-1.71.1 subfile layout.
 *
 * Specifically, after the statusline refactor reverted the subfile split, these
 * paths must NOT exist under .claude/hooks/lib/:
 *   - statusline-activity-renderers.cjs
 *   - statusline-render-modes.cjs
 *   - statusline-section-registry.cjs
 *   - statusline-session-cache.cjs
 *   - statusline-string-utils.cjs
 *   - statusline-version-section.cjs
 *   - t1k-config-utils.cjs          (only used by the deleted subfiles)
 *
 * Orphan tolerance: if user flipped ownership to "user" for any of these paths
 * (intentional retention), skip the orphan report for that path and emit an
 * INFO line noting the user override. Ownership is read from the same
 * metadata.json.installedFiles[] used by check #42.
 *
 * Deterministic invariant check — no policy, no network, no CLI spawns.
 * Fail-open on unexpected errors (matches existing doctor checks).
 *
 * Usage: node doctor-check-43-statusline-orphans.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

const { resolveClaudeDir } = require('./telemetry-utils.cjs');

const CHECK_ID = 43;
const CHECK_NAME = 'statusline-orphans';

const ORPHAN_PATHS = [
  'hooks/lib/statusline-activity-renderers.cjs',
  'hooks/lib/statusline-render-modes.cjs',
  'hooks/lib/statusline-section-registry.cjs',
  'hooks/lib/statusline-session-cache.cjs',
  'hooks/lib/statusline-string-utils.cjs',
  'hooks/lib/statusline-version-section.cjs',
  'hooks/lib/t1k-config-utils.cjs',
];

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
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

function ownershipOf(meta, relPath) {
  const list = meta && Array.isArray(meta.installedFiles) ? meta.installedFiles : null;
  if (!list) return null;
  for (const entry of list) {
    if (entry && typeof entry === 'object' && entry.path === relPath) {
      return typeof entry.ownership === 'string' ? entry.ownership : null;
    }
  }
  return null;
}

function run() {
  const claudeDir = resolveDir(process.argv[2]);
  if (!fs.existsSync(claudeDir)) {
    emit('SKIP', `.claude/ not found at ${claudeDir}`);
    process.exit(0);
  }

  const metadataPath = path.join(claudeDir, 'metadata.json');
  const meta = fs.existsSync(metadataPath) ? readJson(metadataPath) : null;

  const orphans = [];
  const userRetained = [];

  for (const rel of ORPHAN_PATHS) {
    const fullPath = path.join(claudeDir, rel);
    if (!fs.existsSync(fullPath)) continue;

    const ownership = meta && !meta._error ? ownershipOf(meta, rel) : null;
    if (ownership === 'user') {
      userRetained.push(rel);
    } else {
      orphans.push(rel);
    }
  }

  for (const rel of userRetained) {
    emit('INFO', `user-retained (ownership=user) — skipped: ${rel}`);
  }

  if (orphans.length === 0) {
    emit('PASS', `no orphan statusline subfiles (${userRetained.length} user-retained)`);
    process.exit(0);
  }

  emit('FAIL', `${orphans.length} orphan file(s) present — run \`t1k update\` or manually delete`);
  for (const rel of orphans) {
    process.stdout.write(`       - ${rel}\n`);
  }
  process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
}

try {
  run();
} catch (err) {
  emit('SKIP', `unexpected error: ${err.message}`);
  process.exit(0);
}
