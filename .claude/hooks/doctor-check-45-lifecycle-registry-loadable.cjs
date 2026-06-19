// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-45-lifecycle-registry-loadable.cjs — Doctor check #45.
 *
 * Per phase-A4.md §A4.6: validates that every entry in `.claude/lifecycle.json`
 * is actually loadable at runtime. Catches drift between the canonical
 * vocabulary, the registry schema, and the subscriber files on disk.
 *
 * Companion to release-action gate #17 (validate-lifecycle-json.cjs) which
 * checks SHAPE pre-merge. This check runs against the LIVE installed state
 * and additionally checks WIRING — the loader contract from A4.5:
 *   subscriber MUST `module.exports` a function (or have a `.register`
 *   method) that the loader will call with `(lifecycle, entry)`.
 *
 * Validation per registry entry:
 *   1. event is in the canonical 5-event set
 *   2. modulePath file exists on disk
 *   3. require()-ing the modulePath does NOT throw
 *   4. exported value is a function OR has a `.register` function method
 *
 * Emits:
 *   [t1k:doctor:lifecycle-registry-loadable status=ok|warn|fail count=N]
 *
 * Exit codes:
 *   0 — all entries valid (OK), or registry empty (SKIP), or registry absent (SKIP)
 *   1 — at least one entry fails validation (FAIL)
 *
 * Usage:
 *   node doctor-check-45-lifecycle-registry-loadable.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

const CHECK_ID = 45;
const CHECK_NAME = 'lifecycle-registry-loadable';

const CANONICAL_EVENTS = new Set([
  'preInstall',
  'postInstall',
  'preUpdate',
  'postUpdate',
  'rollback',
]);

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
}

function marker(status, count) {
  process.stdout.write(`[t1k:doctor:lifecycle-registry-loadable status=${status} count=${count}]\n`);
}

function resolveClaudeDir() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  // Default: walk up from __dirname to find .claude
  const fromDirname = path.resolve(__dirname, '..');
  if (path.basename(fromDirname) === '.claude') return fromDirname;
  // Fallback: cwd-relative
  const fromCwd = path.join(process.cwd(), '.claude');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return null;
}

function validateEntry(entry, claudeDir, index) {
  const errors = [];
  if (!entry || typeof entry !== 'object') {
    return [`entry #${index}: not an object`];
  }
  if (!CANONICAL_EVENTS.has(entry.event)) {
    errors.push(`entry #${index} (${entry.subscriberId || 'no-id'}): event "${entry.event}" not in canonical set`);
  }
  if (typeof entry.modulePath !== 'string' || entry.modulePath.length === 0) {
    errors.push(`entry #${index} (${entry.subscriberId || 'no-id'}): modulePath missing or empty`);
    return errors;
  }
  const absPath = path.join(claudeDir, entry.modulePath);
  if (!fs.existsSync(absPath)) {
    errors.push(`entry #${index} (${entry.subscriberId}): modulePath not found: ${entry.modulePath}`);
    return errors;
  }
  // Try require()ing the module — must not throw.
  let mod;
  try {
    // Bust require cache so a previous run can't mask a real failure here
    delete require.cache[require.resolve(absPath)];
    mod = require(absPath);
  } catch (err) {
    errors.push(`entry #${index} (${entry.subscriberId}): require failed — ${err.message}`);
    return errors;
  }
  // Verify the loader contract: function OR { register: function }
  const hasFunctionExport = typeof mod === 'function';
  const hasRegisterMethod = mod && typeof mod === 'object' && typeof mod.register === 'function';
  if (!hasFunctionExport && !hasRegisterMethod) {
    errors.push(
      `entry #${index} (${entry.subscriberId}): module ${entry.modulePath} does not export a function ` +
      `nor a .register method — A4.5 loader contract requires module.exports = function(lifecycle, entry) {...}`
    );
  }
  return errors;
}

function run() {
  const claudeDir = resolveClaudeDir();
  if (!claudeDir) {
    emit('SKIP', 'no .claude/ directory resolvable');
    marker('skip', 0);
    process.exit(0);
  }
  const lifecyclePath = path.join(claudeDir, 'lifecycle.json');
  if (!fs.existsSync(lifecyclePath)) {
    emit('SKIP', 'no lifecycle.json — registry is opt-in');
    marker('skip', 0);
    process.exit(0);
  }
  let raw;
  try {
    raw = fs.readFileSync(lifecyclePath, 'utf8');
  } catch (err) {
    emit('FAIL', `cannot read lifecycle.json: ${err.message}`);
    marker('fail', 1);
    process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    emit('FAIL', `lifecycle.json parse error: ${err.message}`);
    emit('FAIL', 'Fix the JSON syntax — also caught pre-merge by release-action gate #17.');
    marker('fail', 1);
    process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
  }
  if (!Array.isArray(parsed)) {
    emit('FAIL', `lifecycle.json must be an array, got ${typeof parsed}`);
    marker('fail', 1);
    process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
  }
  if (parsed.length === 0) {
    emit('OK', 'registry is empty (seed state) — nothing to validate');
    marker('ok', 0);
    process.exit(0);
  }

  const allErrors = [];
  for (let i = 0; i < parsed.length; i++) {
    allErrors.push(...validateEntry(parsed[i], claudeDir, i));
  }

  if (allErrors.length === 0) {
    emit('OK', `${parsed.length} entries — all loadable + match canonical event set + satisfy loader contract`);
    marker('ok', parsed.length);
    process.exit(0);
  }

  emit('FAIL', `${allErrors.length} validation error(s) across ${parsed.length} registry entries:`);
  for (const err of allErrors) {
    emit('FAIL', `  - ${err}`);
  }
  emit('FAIL', 'Fix subscriber files or update lifecycle.json. Loader contract: docs/lifecycle-events.md §"Subscriber API contract".');
  marker('fail', allErrors.length);
  process.exit(1); // gate:exit-1-allowed (doctor-check; ambient failure logged, never blocks)
}

run();
