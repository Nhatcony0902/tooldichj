#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * TheOneKit Hook Runner — Cross-platform hook bootstrapper with dedup
 *
 * Resolves the project root (git root or directory walk) and runs the
 * target hook script from the correct .claude/hooks/ location.
 *
 * Features:
 *   - Resolves project root even from subdirectories
 *   - Reads stdin (cross-platform, fd 0) and pipes to child hook
 *   - Auto-dedup: prevents double execution when installed at both global + project levels
 *   - Uses execFileSync to spawn hooks (stdin flows through correctly)
 *
 * Usage: node "$CLAUDE_PROJECT_DIR/.claude/hooks/hook-runner.cjs" <hook-name> [extra-args...]
 *
 * Source settings.json uses $CLAUDE_PROJECT_DIR (Claude Code env var, cross-platform).
 * The CLI's transformClaudePaths() converts to $HOME for global installs.
 */

const { execSync, execFileSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

/**
 * #310 — Resolve today's date string WITHOUT a relative `require()`.
 *
 * The error-telemetry paths below previously called
 * `require('./telemetry-utils.cjs').todayDateStr()`. A bare relative require
 * resolves against this module's __dirname, which can diverge from the physical
 * hooks dir under symlinked / global-only installs — throwing MODULE_NOT_FOUND
 * (Node CJS loader:1424) INSIDE the very handler meant to log a child-hook
 * failure. That is what stacked the `PostToolUse:Agent`/`TaskUpdate` red banners
 * (data-dependent: only real payloads pushed the child to a non-zero exit, which
 * then entered the handler and tripped the require).
 *
 * Resolution order:
 *   1. require telemetry-utils via the absolute hookDir path (same pattern the
 *      dedup/logger blocks already use), then call its todayDateStr().
 *   2. If that require fails for any reason, fall back to an inline ISO date.
 * Either way this helper NEVER throws — the error handler can always log.
 */
function resolveTodayDateStr(hookDir) {
  try {
    const utilsPath = path.join(hookDir, '.claude', 'hooks', 'telemetry-utils.cjs');
    if (fs.existsSync(utilsPath)) {
      const { todayDateStr } = require(utilsPath);
      if (typeof todayDateStr === 'function') return todayDateStr();
    }
  } catch { /* fall through to inline computation */ }
  return new Date().toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────
// A3.1 — Lifecycle hub (Phase A3 of Safety Addendum).
// Registry is loaded once per hook-runner invocation via loadLifecycleRegistry().
// The hub holds the subscriber map; emit() batches every event fired inside a
// single runner invocation between `[t1k:lc:batch start ...]` and `[t1k:lc:batch end ...]`
// stdout markers so downstream log parsers can scope per-run fan-out.
//
// Spec: plans/260422-1905-safety-addendum-implementation/phases/phase-A3.md §A3.1
// Sole-emitter gate: theonekit-release-action scripts/validate-lifecycle-emitter-sole-source.cjs
// Subscriber-file schema gate: scripts/validate-lifecycle-json.cjs (Gate #17).
// ─────────────────────────────────────────────────────────────────────────

const LIFECYCLE_CANONICAL_EVENTS = new Set([
  'preInstall',
  'postInstall',
  'preUpdate',
  'postUpdate',
  'rollback',
]);
const LIFECYCLE_REQUIRED_FIELDS = [
  ['event', 'string'],
  ['subscriberId', 'string'],
  ['modulePath', 'string'],
  ['priority', 'number'],
  ['idempotent', 'boolean'],
];

/** Internal handler map: event → [{ priority, handler, subscriberId }]. */
const lifecycleHandlers = Object.create(null);
/** Used to give each hook-runner invocation a unique batch id in its markers. */
const lifecycleRunId = crypto.randomBytes(4).toString('hex');
let lifecycleBatchOpen = false;
let lifecycleRegistryLoaded = false;

/**
 * Append one line of JSON to `<claudeDir>/telemetry/lifecycle-errors-YYYY-MM-DD.jsonl`.
 * Fail-open: any I/O error swallowed; lifecycle load never crashes the runner.
 */
function logLifecycleError(claudeDir, record) {
  try {
    if (!claudeDir) return;
    const telemetryDir = path.join(claudeDir, 'telemetry');
    if (!fs.existsSync(telemetryDir)) fs.mkdirSync(telemetryDir, { recursive: true });
    const dateStr = new Date().toISOString().slice(0, 10);
    const errFile = path.join(telemetryDir, `lifecycle-errors-${dateStr}.jsonl`);
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record }) + '\n';
    fs.appendFileSync(errFile, line, { mode: 0o600 });
    try { fs.chmodSync(errFile, 0o600); } catch { /* non-critical */ }
  } catch { /* never let telemetry failure affect hook execution */ }
}

/**
 * Validate a single registry entry against the schema. Returns null on success
 * or a string describing the first failure.
 */
function validateLifecycleEntry(entry, seenIds) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
    return `entry must be an object (got ${Array.isArray(entry) ? 'array' : typeof entry})`;
  }
  for (const [key, type] of LIFECYCLE_REQUIRED_FIELDS) {
    if (!(key in entry)) return `missing required field "${key}"`;
    if (typeof entry[key] !== type) return `field "${key}" must be ${type} (got ${typeof entry[key]})`;
  }
  if (!LIFECYCLE_CANONICAL_EVENTS.has(entry.event)) {
    return `event "${entry.event}" is not canonical (allowed: ${Array.from(LIFECYCLE_CANONICAL_EVENTS).join(', ')})`;
  }
  if (seenIds.has(entry.subscriberId)) {
    return `duplicate subscriberId "${entry.subscriberId}"`;
  }
  return null;
}

/**
 * Load and validate `.claude/lifecycle.json`, then eagerly `require()` every
 * subscriber's modulePath so it registers via `lifecycle.subscribe(...)` at
 * require-time. On ANY parse/require/validation failure, logs a JSONL line and
 * continues with a partially-loaded or empty registry — side-effect hooks MUST
 * still fire (the runner's main flow runs regardless).
 *
 * Idempotent: subsequent calls in the same process are no-ops.
 *
 * @param {string} claudeRoot absolute path to the `.claude/` dir
 */
function loadLifecycleRegistry(claudeRoot) {
  if (lifecycleRegistryLoaded) return;
  lifecycleRegistryLoaded = true;
  if (!claudeRoot) return;

  const lifecyclePath = path.join(claudeRoot, 'lifecycle.json');
  if (!fs.existsSync(lifecyclePath)) return; // opt-in — absence is not an error

  let raw, parsed;
  try {
    raw = fs.readFileSync(lifecyclePath, 'utf8');
  } catch (err) {
    logLifecycleError(claudeRoot, { phase: 'loadLifecycleRegistry', error: `read failed: ${err.message}`, stack: err.stack });
    return;
  }

  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    logLifecycleError(claudeRoot, { phase: 'loadLifecycleRegistry', error: `parse failed: ${err.message}`, stack: err.stack });
    return;
  }

  if (!Array.isArray(parsed)) {
    logLifecycleError(claudeRoot, { phase: 'loadLifecycleRegistry', error: `lifecycle.json must be array, got ${typeof parsed}` });
    return;
  }

  const seenIds = new Set();
  for (let i = 0; i < parsed.length; i++) {
    const entry = parsed[i];
    const validationError = validateLifecycleEntry(entry, seenIds);
    if (validationError) {
      logLifecycleError(claudeRoot, { phase: 'loadLifecycleRegistry', entryIndex: i, error: validationError });
      continue; // skip this entry but keep loading the rest
    }
    seenIds.add(entry.subscriberId);

    const absModule = path.join(claudeRoot, entry.modulePath);
    if (!fs.existsSync(absModule)) {
      logLifecycleError(claudeRoot, { phase: 'loadLifecycleRegistry', entryIndex: i, error: `modulePath not found: ${entry.modulePath}` });
      continue;
    }
    try {
      // A4.5 — subscriber API contract: a subscriber MUST export a function
      // (preferred) or a `register` method. The loader calls it with two args:
      //   - lifecycle  the hub API ({ subscribe, emit, finalize })
      //   - entry      this lifecycle.json registration entry, so the
      //                subscriber knows which event/subscriberId/priority to
      //                register for THIS particular registration
      //
      // Why two args: the loader requires the same modulePath once per entry
      // (Node caches the module). If the subscriber registered all events on
      // first call, each subsequent entry would re-register the same handlers
      // (5 entries × 5 events = 25 registrations). Passing `entry` lets the
      // subscriber register exactly one handler per call — the event from
      // THIS entry — so N entries produce N registrations regardless of cache.
      //
      // Modules that don't export either form are no-ops (legacy/global
      // pattern is no longer sanctioned; would throw because `lifecycle` is
      // not in the subscriber's scope).
      const subModule = require(absModule);
      if (typeof subModule === 'function') {
        subModule(lifecycle, entry);
      } else if (subModule && typeof subModule.register === 'function') {
        subModule.register(lifecycle, entry);
      }
    } catch (err) {
      logLifecycleError(claudeRoot, {
        phase: 'loadLifecycleRegistry',
        entryIndex: i,
        error: `require failed: ${err.message}`,
        stack: err.stack,
      });
    }
  }
}

/**
 * Register a handler for a lifecycle event. Public API exported by hook-runner.
 * Handlers fire in priority-ascending order within an event; two handlers with
 * the same priority fire in registration order (stable).
 */
function lifecycleSubscribe(event, handler, options = {}) {
  if (typeof event !== 'string' || !LIFECYCLE_CANONICAL_EVENTS.has(event)) {
    throw new Error(`lifecycle.subscribe: unknown event "${event}"`);
  }
  if (typeof handler !== 'function') {
    throw new Error(`lifecycle.subscribe: handler must be a function (got ${typeof handler})`);
  }
  if (!lifecycleHandlers[event]) lifecycleHandlers[event] = [];
  lifecycleHandlers[event].push({
    priority: typeof options.priority === 'number' ? options.priority : 100,
    subscriberId: typeof options.subscriberId === 'string' ? options.subscriberId : 'anonymous',
    handler,
  });
  lifecycleHandlers[event].sort((a, b) => a.priority - b.priority);
}

/**
 * Fan an event out to every registered handler, wrapped in
 *   `[t1k:lc:batch start id=<run-id>]` / `[t1k:lc:batch end id=<run-id>]`
 * markers so log parsers can scope per-runner fan-out.
 *
 * Sole-emitter contract: ONLY this function emits `[t1k:lc:*]` markers. Every
 * other hook must call lifecycleSubscribe to react. Gate #16 enforces this
 * statically.
 *
 * Handler errors are logged and swallowed — one bad subscriber never blocks
 * another subscriber from firing.
 */
function lifecycleEmit(event, payload) {
  if (!LIFECYCLE_CANONICAL_EVENTS.has(event)) {
    throw new Error(`lifecycle.emit: unknown event "${event}"`);
  }
  if (!lifecycleBatchOpen) {
    process.stdout.write(`[t1k:lc:batch start id=${lifecycleRunId}]\n`);
    lifecycleBatchOpen = true;
  }
  process.stdout.write(`[t1k:lc:${event} id=${lifecycleRunId}]\n`);
  const subs = lifecycleHandlers[event] || [];
  for (const { handler, subscriberId } of subs) {
    try {
      handler(payload);
    } catch (err) {
      logLifecycleError(null, { phase: 'lifecycleEmit', event, subscriberId, error: err.message, stack: err.stack });
    }
  }
}

/** Called before the runner exits so the closing batch marker always emits. */
function lifecycleFinalize() {
  if (lifecycleBatchOpen) {
    process.stdout.write(`[t1k:lc:batch end id=${lifecycleRunId}]\n`);
    lifecycleBatchOpen = false;
  }
}

const lifecycle = {
  emit: lifecycleEmit,
  subscribe: lifecycleSubscribe,
  finalize: lifecycleFinalize,
};

/**
 * A1.4 — CI environment detection (B6).
 * When running under CI, migration/auto-update machinery must no-op to keep
 * the tree clean (no writes under ~/.claude/ or CWD). See Safety Addendum §18.2 B6.
 */
function isCiEnvironment() {
  return process.env.CI === 'true'
    || process.env.CI === '1'
    || !!process.env.GITHUB_ACTIONS
    || !!process.env.ARC_RUNNER;
}

/**
 * A1.1 / B13 — Migration lock path (global-only; lives at ~/.claude/.migration.lock
 * unconditionally per docs/global-only-mode.md §"Migration scope").
 */
function resolveMigrationLockPath() {
  return path.join(os.homedir(), '.claude', '.migration.lock');
}

/**
 * A1.1 — Read migration lock (fail-open: any error → null).
 * Returns { pid, ts, phase } or null.
 */
function readMigrationLock() {
  try {
    const lockPath = resolveMigrationLockPath();
    if (!fs.existsSync(lockPath)) return null;
    const raw = fs.readFileSync(lockPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.phase === 'string') return parsed;
    return null;
  } catch {
    return null;
  }
}

/**
 * Find where hook .cjs files live (may differ from project root in global-only mode).
 * Strategy: __dirname walk first (most reliable), then CWD walk.
 */
function findHookDir() {
  // __dirname is always correct for .cjs files — hook-runner.cjs lives in .claude/hooks/
  const fromDirname = path.resolve(__dirname, '..', '..');
  if (fs.existsSync(path.join(fromDirname, '.claude', 'hooks'))) {
    return fromDirname;
  }
  return process.cwd();
}

/**
 * Find the user's actual project root.
 * Strategy: git rev-parse first (unconditional — no .claude/ check),
 * then CWD as fallback for non-git directories.
 */
function findProjectRoot() {
  // Strategy 1: git rev-parse (works in any subdirectory of a git repo)
  try {
    const gitRoot = execSync('git rev-parse --show-toplevel', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
      windowsHide: true
    }).trim();
    if (gitRoot) return gitRoot;
  } catch {}
  // Strategy 2: CWD (non-git directory)
  return process.cwd();
}

// Main
const hookName = process.argv[2];
if (!hookName) {
  // No sub-hook to dispatch. The only caller that omits the hook-name argv is the
  // doctor's hook-runtime dry-run (it pipes a payload but passes no argv) — that's a
  // no-op, not an error, so exit 0 and stay dry-run VALIDATED (the gateway loaded its
  // requires + lifecycle cleanly) instead of needing a skip marker. Real invocations
  // always pass a hook name via settings.json (#503).
  process.exit(0);
}

// A1.4 — CI environment noop (B6): skip migration/lock/auto-update machinery
// and let the child hook run normally in a sandboxed env that prevents writes
// to ~/.claude. Emit a one-line marker for telemetry.
const _isCi = isCiEnvironment();
if (_isCi) {
  process.stderr.write('[t1k:ci] CI environment — migration skipped\n');
}

// A1.1 — Migration-lock respect (B2): if a migration is mid-rename, pause hooks.
// Only the two rename phases are sensitive; acquire/release phases allow hooks.
// Skipped under CI (migrations never run there).
if (!_isCi) {
  const _lock = readMigrationLock();
  const _sensitivePhases = new Set(['rename-step-1-complete', 'rename-step-2-complete']);
  if (_lock && _sensitivePhases.has(_lock.phase)) {
    process.stdout.write('[t1k:migration] in progress — hooks paused\n');
    process.exit(0);
  }
}

const hookDir = findHookDir();
const projectRoot = findProjectRoot();
const hookPath = path.join(hookDir, '.claude', 'hooks', `${hookName}.cjs`);

if (!fs.existsSync(hookPath)) {
  // Silent exit — hook may not exist in all kits
  process.exit(0);
}

// A3.1 — Load the lifecycle subscriber registry (no-op if .claude/lifecycle.json absent).
// Errors are logged to .claude/telemetry/lifecycle-errors-*.jsonl; the runner never crashes.
const _claudeRoot = path.join(hookDir, '.claude');
loadLifecycleRegistry(_claudeRoot);

// A4.2 — Lifecycle event detection runs ONLY at SessionStart. Detection compares
// the previous-session state snapshot against the current metadata.json + reads
// the CLI's pending marker, then fans events out via lifecycle.emit().
// Wrapped in try/catch with fail-open contract — a detection bug must never
// break Claude Code session startup. The detect lib is optional infrastructure
// (presence-gated): kits that haven't installed `lib/lifecycle-detect.cjs` yet
// silently skip detection without writing telemetry noise. Spec: phase-A4.md §A4.2.
if (hookName === 'SessionStart') {
  const _detectLibPath = path.join(__dirname, 'lib', 'lifecycle-detect.cjs');
  if (fs.existsSync(_detectLibPath)) {
    try {
      const detectLib = require(_detectLibPath);
      const _stageRoot = detectLib.stagingRoot();
      const _logErr = (record) => logLifecycleError(_claudeRoot, record);
      const _pending = detectLib.readPendingMarker(_stageRoot, _logErr);
      const _prev = detectLib.readPreviousState(_claudeRoot, _logErr);
      const _curr = detectLib.readCurrentState(_claudeRoot, _logErr);
      const _events = detectLib.detectLifecycleEvents(_prev, _curr, _pending, _claudeRoot, _logErr);
      for (const _ev of _events) {
        try {
          lifecycle.emit(_ev.type, _ev.payload);
        } catch (err) {
          logLifecycleError(_claudeRoot, {
            phase: 'lifecycleEmit-from-detect',
            event: _ev.type,
            error: err.message,
          });
        }
      }
      detectLib.writeCurrentState(_claudeRoot, _curr, _logErr);
    } catch (err) {
      logLifecycleError(_claudeRoot, {
        phase: 'lifecycle-detect',
        error: err.message,
        stack: err.stack,
      });
    }
  }
}

// Read stdin cross-platform (fd 0 works on Linux, macOS, AND Windows)
let stdin = '';
try {
  stdin = fs.readFileSync(0, 'utf8');
} catch {
  // No stdin available (e.g., some SessionStart/Stop hooks) — proceed with empty
}

// Dedup guard: prevent double execution when hook is registered in both global + project settings
// Claude Code fires hooks from both levels additively — first invocation creates lock, second exits
let _dedupHash = '';
let _isDuplicate = false;
try {
  const utilsPath = path.join(hookDir, '.claude', 'hooks', 'telemetry-utils.cjs');
  if (fs.existsSync(utilsPath)) {
    const { dedupGuard } = require(utilsPath);
    const result = dedupGuard(hookName, stdin);
    // Log AFTER the dedup decision — never before (logging itself must not affect dedup)
    try {
      const loggerPath = path.join(hookDir, '.claude', 'hooks', 'hook-logger.cjs');
      if (fs.existsSync(loggerPath)) {
        const { logHook } = require(loggerPath);
        // Compute a short hash for log correlation (same logic as dedupGuard internally)
        const crypto = require('crypto');
        _dedupHash = crypto.createHash('md5').update(hookName + (stdin || '')).digest('hex').slice(0, 8);
        _isDuplicate = !!result;
        logHook('hook-runner', { hookName: hookName, dedup: _isDuplicate ? 'duplicate' : 'first', dedupHash: _dedupHash });
      }
    } catch { /* fail-silent — log errors must never affect hook execution */ }
    if (result) {
      process.exit(0); // duplicate — already ran from the other settings level
    }
  }
} catch {
  // telemetry-utils.cjs not found or dedupGuard failed — proceed without dedup (fail-open)
}

// SessionStart hooks may do network I/O (kit updates, MCP health checks);
// give them 30s. All other hooks keep the default 10s.
const isSessionStart = hookName === 'SessionStart';

// Use spawnSync (not execFileSync) so we capture stderr on BOTH success and failure paths.
// With execFileSync + stdio[2]='pipe', child stderr is only available via err.stderr in the
// catch block — on success it is silently consumed. spawnSync always populates result.stderr.
// stdout stays 'inherit' so hook stdout reaches Claude Code UI unchanged.
const spawnResult = spawnSync(process.execPath, [hookPath, ...process.argv.slice(3)], {
  input: stdin,
  stdio: ['pipe', 'inherit', 'pipe'],
  timeout: isSessionStart ? 30000 : 10000,
  cwd: projectRoot,
  windowsHide: true,
  env: {
    ...process.env,
    T1K_HOOK_DIR: hookDir,
    T1K_PROJECT_ROOT: projectRoot,
  },
});

// Always re-emit child stderr so Claude Code UI sees hook warnings/debug on success too.
const rawStderr = (spawnResult.stderr || Buffer.alloc(0)).toString('utf8');
if (rawStderr.length > 0) process.stderr.write(rawStderr);

const exitCode = spawnResult.status !== null ? spawnResult.status : (spawnResult.signal ? 1 : 0);

if (spawnResult.error) {
  // spawnSync itself failed (e.g. ENOENT for node binary, ETIMEDOUT) — treat as non-fatal.
  try {
    const telemetryDir = path.join(hookDir, '.claude', 'telemetry');
    if (!fs.existsSync(telemetryDir)) fs.mkdirSync(telemetryDir, { recursive: true });
    const date = resolveTodayDateStr(hookDir);
    const errFile = path.join(telemetryDir, `hook-errors-${date}.jsonl`);
    const entry = {
      ts: new Date().toISOString(),
      hook: hookName,
      error: (spawnResult.error.message || 'spawn failed').substring(0, 200),
      stderr: rawStderr.substring(0, 2000),
      exitCode: exitCode,
      timeout: spawnResult.error.code === 'ETIMEDOUT',
    };
    fs.appendFileSync(errFile, JSON.stringify(entry) + '\n');
    process.stderr.write(`[t1k:hook-error] ${hookName} spawn-failed: ${(spawnResult.error.message || 'unknown').substring(0, 100)}\n`);
  } catch { /* telemetry logging failed — truly give up */ }
} else if (exitCode === 2) {
  // Exit code 2 = intentional block (PreToolUse security hooks). Propagate immediately.
  // Child stderr (the block-reason message) was already re-emitted above.
  process.exit(2);
} else if (exitCode !== 0) {
  // Non-zero, non-block exit: parse for MODULE_NOT_FOUND, log telemetry, then fail-open.

  // Parse "Cannot find module '<path>'" from Node CJS loader output (loader:1424 banner pattern).
  // Matches both single-quoted and double-quoted variants emitted by different Node versions.
  let missingModule = null;
  const moduleMatch = rawStderr.match(/Cannot find module ['"]([^'"]+)['"]/);
  if (moduleMatch) missingModule = moduleMatch[1];

  // Emit a structured diagnostic line surfacing the missing module name.
  // This replaces the bare `node:internal/modules/cjs/loader:1424` banner that was
  // previously invisible in the Claude Code UI (issue #310).
  if (missingModule) {
    process.stderr.write(
      `[t1k:hook-module-not-found] hook=${hookName} missing=${JSON.stringify(missingModule)} ` +
      `hookPath=${JSON.stringify(hookPath)} cwd=${JSON.stringify(projectRoot)}\n`
    );
  }

  // Log to hook-errors telemetry and hook-logger for /t1k:watzup visibility.
  try {
    const telemetryDir = path.join(hookDir, '.claude', 'telemetry');
    if (!fs.existsSync(telemetryDir)) fs.mkdirSync(telemetryDir, { recursive: true });
    const date = resolveTodayDateStr(hookDir);
    const errFile = path.join(telemetryDir, `hook-errors-${date}.jsonl`);
    // Expanded from 300 → 2000 chars so the full Node loader banner is preserved.
    const stderrSnippet = rawStderr.substring(0, 2000);
    const entry = {
      ts: new Date().toISOString(),
      hook: hookName,
      error: `exit ${exitCode}`,
      stderr: stderrSnippet,
      missingModule: missingModule || undefined,
      exitCode: exitCode,
      timeout: spawnResult.signal === 'SIGTERM',
    };
    fs.appendFileSync(errFile, JSON.stringify(entry) + '\n');

    // Use hook-logger logHookCrash if available for richer structured telemetry.
    try {
      const loggerPath = path.join(hookDir, '.claude', 'hooks', 'hook-logger.cjs');
      if (fs.existsSync(loggerPath)) {
        const { logHookCrash } = require(loggerPath);
        logHookCrash(hookName, new Error(`exit ${exitCode}`), {
          missingModule: missingModule || undefined,
          hookPath: hookPath,
          stderr: stderrSnippet,
          exitCode: exitCode,
        });
      }
    } catch { /* hook-logger unavailable — raw JSONL telemetry above is the fallback */ }

    process.stderr.write(
      `[t1k:hook-error] ${hookName} exit=${exitCode}` +
      (missingModule ? ` MODULE_NOT_FOUND=${missingModule}` : '') +
      `\n`
    );
  } catch { /* telemetry logging itself failed — truly give up */ }
}

lifecycleFinalize();
process.exit(0);
