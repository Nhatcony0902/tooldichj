#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * check-kit-updates.cjs — Auto-update installed kits/modules at session start.
 *
 * PRIMARY PATH: Detect updates → spawn `t1k update --yes` (CLI handles everything:
 *   extraction, deletions, ownership, metadata, both global + project scopes).
 * FALLBACK PATH: If CLI binary not found, do manual gh download + extractZip.
 *
 * Cooldown: a per-scope ~1h cache (lib/update-check-cache.cjs) honors GitHub's
 *   60/h anonymous rate limit. Scopes are independent (core#449) — a global
 *   update's cooldown never suppresses the local (project) check, or vice-versa.
 *   Opt-out: features.autoUpdate: false.
 * Self-update guard: skips repos matching CWD's git remote.
 * Coordination: writes marker so check-cli-updates.cjs can skip redundant work.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, execFileSync } = require('child_process');
const { extractZip } = require('./module-manifest-helpers.cjs');
const { T1K } = require('./telemetry-utils.cjs');
const { isInstallLockHeld, spawnT1kUpdateDetached } = require('./lib/t1k-update-spawn.cjs');
const { autoCommitUpdates } = require('./lib/auto-commit-helper.cjs');
const updateCheckCache = require('./lib/update-check-cache.cjs');

function isMajorBump(local, remote) {
  return Number(remote.split('.')[0]) > Number((local || '0').split('.')[0]);
}

/**
 * Major-bump detection for modular kits using per-module manifest versions.
 * Modular release tags use format `modules-YYYYMMDD-HHMM` (no dots), so tag-based
 * semver splitting returns NaN. This function compares actual module semver versions
 * from the manifest instead of the release tag.
 *
 * @param {Object} remoteManifest — map of moduleName → { version, ... }
 * @param {Object} localModules   — metadata.installedModules map
 * @returns {boolean}
 */
function isMajorBumpFromManifest(remoteManifest, localModules) {
  for (const [modName, remoteEntry] of Object.entries(remoteManifest || {})) {
    const localEntry = localModules ? localModules[modName] : null;
    if (!localEntry) continue; // new module — not a major bump
    const remoteMajor = Number((remoteEntry.version || '0').split('.')[0]);
    const localMajor = Number((localEntry.version || '0').split('.')[0]);
    if (!isNaN(remoteMajor) && !isNaN(localMajor) && remoteMajor > localMajor) return true;
  }
  return false;
}

/**
 * Fix relative .claude/ paths in global ~/.claude/settings.json.
 * Transforms "node .claude/..." → "node \"$HOME/.claude/...\"" (or %USERPROFILE% on Windows).
 * Idempotent, fail-open. Only touches global settings — never project-level.
 */
function fixGlobalSettingsPaths(home) {
  const settingsPath = path.join(home, '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) return;

  let raw;
  try { raw = fs.readFileSync(settingsPath, 'utf8'); } catch { return; }

  if (!/(node\s+)(?:\.\/)?(\.claude\/)/.test(raw)) return;
  if (/\$HOME\/\.claude\//.test(raw) || /%USERPROFILE%/.test(raw)) return;

  let settings;
  try { settings = JSON.parse(raw); } catch { return; }

  const prefix = process.platform === 'win32' ? '$USERPROFILE' : '$HOME';
  let fixCount = 0;

  function fixCommand(cmd) {
    if (!cmd || !cmd.includes('.claude/')) return cmd;
    if (/\$HOME|%USERPROFILE%|\$CLAUDE_PROJECT_DIR|%CLAUDE_PROJECT_DIR%/.test(cmd)) return cmd;
    const fixed = cmd.replace(
      /(node\s+)(?:\.\/)?(\.claude\/\S+)/,
      `$1"${prefix}/$2"`
    );
    if (fixed !== cmd) fixCount++;
    return fixed;
  }

  if (settings.hooks) {
    for (const entries of Object.values(settings.hooks)) {
      if (!Array.isArray(entries)) continue;
      for (const entry of entries) {
        if (entry.command) entry.command = fixCommand(entry.command);
        if (Array.isArray(entry.hooks)) {
          for (const hook of entry.hooks) {
            if (hook.command) hook.command = fixCommand(hook.command);
          }
        }
      }
    }
  }

  if (settings.statusLine?.command) {
    settings.statusLine.command = fixCommand(settings.statusLine.command);
  }

  if (fixCount === 0) return;

  try {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
    console.log(`[t1k:settings-repair] Fixed ${fixCount} relative path(s) in global settings.json`);
  } catch { /* fail-open */ }
}

/**
 * Find the t1k CLI binary on PATH.
 * Returns the path to the binary, or null if not found.
 */
function findCliBinary() {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const lines = execFileSync(cmd, ['t1k'], { encoding: 'utf8', timeout: 3000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
      .split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (process.platform === 'win32') {
      // Prefer Windows-executable shims; bare POSIX shebang files (no extension)
      // cannot be invoked via spawn() without shell:true and return ENOENT.
      const exts = ['.cmd', '.exe', '.bat'];
      return lines.find(p => exts.some(e => p.toLowerCase().endsWith(e))) || lines[0] || null;
    }
    return lines[0] || null;
  } catch { return null; }
}

/**
 * Write coordination marker so check-cli-updates.cjs knows we already
 * spawned `t1k update --yes` (which handles CLI + content).
 */
function writeUpdateMarker() {
  try {
    const markerDir = path.join(os.tmpdir(), 't1k-update');
    fs.mkdirSync(markerDir, { recursive: true });
    fs.writeFileSync(path.join(markerDir, 'spawned'), new Date().toISOString());
  } catch { /* ok */ }
}

// Prev-run failure window: banner suppresses status older than this. Matches
// typical "one session per day" cadence — older failures are stale noise.
const PREV_STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * Read .kit-update.status (written by t1k-update-runner.cjs) and, if the
 * previous background run FAILED and is still fresh (<24h), print a
 * PREV RUN FAILED banner before we decide whether to re-spawn.
 *
 * Fail-open: any read/parse error silently returns without a banner.
 *
 * @param {string} home   resolved $HOME path
 * @param {string} logPath path to .kit-update.log (for the banner's "see X" hint)
 */
function maybePrintPrevRunFailed(home, logPath) {
  if (!home) return;
  const statusFile = path.join(home, '.claude', T1K.PATHS.UPDATE_STATUS);
  if (!fs.existsSync(statusFile)) return;

  let status;
  try { status = JSON.parse(fs.readFileSync(statusFile, 'utf8')); }
  catch { return; }

  if (!status || typeof status.exitCode !== 'number') return;
  if (status.exitCode === 0) return; // last run succeeded — nothing to report

  const ts = Date.parse(status.ts || '');
  if (!Number.isFinite(ts)) return;
  const age = Date.now() - ts;
  if (age < 0 || age > PREV_STATUS_MAX_AGE_MS) return; // stale → ignore

  const tail = String(status.stderrTail || '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
  console.log(`${T1K.TAGS.UPDATE_FAILED} PREV RUN FAILED (exit=${status.exitCode}): ${tail || 'no stderr captured'} — see ${logPath}`);
}

(async () => {
  try {
    // Dry-run / wrong-event safety (#503): this is a SessionStart hook. The doctor's
    // hook-runtime dry-run invokes every hook with a synthetic PreToolUse payload
    // ({ tool_name:"Read", ... }). Recognize a tool-event payload and no-op fast — the
    // hook stays dry-run VALIDATED (it loads, reads stdin, exits 0) instead of skipped,
    // while doing zero network work for an event that isn't ours. Real SessionStart
    // payloads carry no `tool_name`.
    try {
      if (!process.stdin.isTTY) {
        const dryRunRaw = fs.readFileSync(0, 'utf8');
        if (dryRunRaw && JSON.parse(dryRunRaw).tool_name) process.exit(0);
      }
    } catch { /* no/invalid stdin payload → real SessionStart invocation, continue */ }
    const cwd = process.cwd();
    const { resolveClaudeDir, isT1KMetadata, readFeatureFlag } = require('./telemetry-utils.cjs');
    const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
    const resolved = resolveClaudeDir();
    if (!resolved) process.exit(0);
    const { claudeDir, isGlobalOnly, home } = resolved;
    const timer = createHookTimer('check-kit-updates');

    // Always fix global settings paths (fast, idempotent, no network)
    fixGlobalSettingsPaths(home);

    // Surface prev-run failure BEFORE we decide to re-spawn. Runs every session
    // until the status file is cleared (by a successful run) or ages out (>24h).
    // Uses $HOME/.claude/ even in project-scoped installs — the runner writes
    // there unconditionally so the banner has a single read location.
    {
      const bannerLogDir = home ? path.join(home, '.claude') : claudeDir;
      maybePrintPrevRunFailed(home, path.join(bannerLogDir, T1K.PATHS.UPDATE_LOG));
    }

    // Check opt-out flag
    if (readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_UPDATE, true) === false) process.exit(0);

    // Phase 03 (260418-1942-t1k-ecosystem-fixes): read autoCommitKitSync once;
    // default ON (flipped 2026-05-11) — features.autoCommitKitSync: true ships
    // in t1k-config-core.json so the in-code default here stays false and the
    // JSON drives the actual value. Sibling autoPushKitSync gates the optional
    // post-commit `git push` (default ON, same JSON-driven pattern).
    const autoCommitFlag = readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_COMMIT_KIT_SYNC, false);
    const autoPushFlag = readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_PUSH_KIT_SYNC, false);

    // Next-session delivery for the CLI-spawned path. When the previous
    // background `t1k update --yes` SUCCEEDED and changed `.claude/` files
    // in cwd, attempt an auto-commit using `filesChanged[]` as the scope-
    // safety gate (expectedFiles). Manual-fallback path handles its own
    // commit later in this session. Fail-open on any read/parse error.
    if (autoCommitFlag && !isGlobalOnly && home) {
      try {
        const statusFile = path.join(home, '.claude', T1K.PATHS.UPDATE_STATUS);
        if (fs.existsSync(statusFile)) {
          const status = JSON.parse(fs.readFileSync(statusFile, 'utf8'));
          if (status && status.exitCode === 0 && Array.isArray(status.filesChanged) && status.filesChanged.length > 0) {
            const { autoCommitUpdates: helper } = require('./lib/auto-commit-helper.cjs');
            helper(cwd, {
              flagEnabled: true,
              pushEnabled: autoPushFlag,
              expectedFiles: status.filesChanged,
              kits: Array.isArray(status.kits) ? status.kits : [],
            });
          }
        }
      } catch { /* fail-open */ }
    }

    // Dry-run: skip all network calls — exposes branching for CI tests
    const noop = process.env[T1K.ENV.KIT_UPDATE_NOOP] === '1';

    const metadataPath = path.join(claudeDir, T1K.METADATA_FILE);
    if (!fs.existsSync(metadataPath)) process.exit(0);
    let metadata;
    try { metadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { process.exit(0); }
    if (!isT1KMetadata(metadata)) process.exit(0);

    // Self-update guard: skip repos matching CWD's git remote
    let cwdRemotes = '';
    try { cwdRemotes = execSync('git remote -v', { encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'] }); } catch { /* ok */ }

    // ── Discover all repos to check ──────────────────────────────────────────
    // repoMap covers the LOCAL scope (claudeDir resolved earlier).
    // globalRepoMap covers the GLOBAL scope ($HOME/.claude/) when it exists
    // as a SEPARATE installation from local. This is the case core#372
    // identified: cwd may be a consumer project (local) AND $HOME/.claude/
    // may have additional kits installed globally (e.g., model-router).
    // Without this dual-discovery, the hook silently misses global updates
    // when local has no pending updates.
    const repoMap = new Map();
    const globalRepoMap = new Map();

    function addRepos(meta, target, scope) {
      for (const [name, entry] of Object.entries(meta.installedModules || {})) {
        if (!entry.repository) continue;
        // Self-update guard: exact match on repo slug (not substring)
        if (cwdRemotes.split(/\s+/).some(w => w.includes('/' + entry.repository + '.git') || w.endsWith('/' + entry.repository))) continue;
        // Skip if already in local repoMap to avoid duplicate work (local wins)
        if (scope === 'global' && repoMap.has(entry.repository)) continue;
        if (!target.has(entry.repository)) target.set(entry.repository, { modules: [], isModular: true });
        target.get(entry.repository).modules.push({ name, version: (entry.version || '0.0.0').replace(/^v/, '') });
      }
    }

    addRepos(metadata, repoMap, 'local');

    for (const cf of fs.readdirSync(claudeDir).filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'))) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(claudeDir, cf), 'utf8'));
        const repo = config.repos?.primary;
        if (!repo || cwdRemotes.includes(repo) || repoMap.has(repo)) continue;
        const localVersion = (metadata.version || '0.0.0').replace(/^v/, '');
        repoMap.set(repo, { modules: [], isModular: false, localKitVersion: localVersion });
      } catch { /* skip */ }
    }

    // Discover global scope when it is a SEPARATE installation from local
    // (i.e., resolved claudeDir is NOT already the global one). Closes the
    // detection-layer half of core#372: previously hasUpdates was computed
    // from local-only, so if only global had pending updates the hook bailed
    // at the !hasUpdates exit below — before reaching the spawn block.
    let globalClaudeDir = null;
    let globalMetadataPath = null;
    if (home && !isGlobalOnly) {
      const candidate = path.join(home, T1K.CLAUDE_DIR);
      if (candidate !== claudeDir && fs.existsSync(candidate)) {
        globalClaudeDir = candidate;
        globalMetadataPath = path.join(candidate, T1K.METADATA_FILE);
        if (fs.existsSync(globalMetadataPath)) {
          try {
            const globalMetadata = JSON.parse(fs.readFileSync(globalMetadataPath, 'utf8'));
            if (isT1KMetadata(globalMetadata)) {
              addRepos(globalMetadata, globalRepoMap, 'global');
              for (const cf of fs.readdirSync(globalClaudeDir).filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'))) {
                try {
                  const config = JSON.parse(fs.readFileSync(path.join(globalClaudeDir, cf), 'utf8'));
                  const repo = config.repos?.primary;
                  if (!repo || cwdRemotes.includes(repo) || repoMap.has(repo) || globalRepoMap.has(repo)) continue;
                  const localVersion = (globalMetadata.version || '0.0.0').replace(/^v/, '');
                  globalRepoMap.set(repo, { modules: [], isModular: false, localKitVersion: localVersion });
                } catch { /* skip */ }
              }
            }
          } catch { /* fail-open: missing/malformed global metadata is non-fatal */ }
        }
      }
    }

    if (repoMap.size === 0 && globalRepoMap.size === 0) { process.exit(0); }

    // ── Per-scope cooldown keys (core#449) ───────────────────────────────────
    // The kits cooldown was a single shared 'kits' slot, so a GLOBAL update
    // success suppressed the next LOCAL (project) session's check for up to 1h
    // — starving project kits while global stayed current. Key the cooldown per
    // scope instead:
    //   - repoMap is the GLOBAL scope when this is a global-only session
    //     (cwd=$HOME); otherwise it is the LOCAL project scope (namespaced by
    //     claudeDir so distinct consumer projects don't suppress each other).
    //   - globalRepoMap (when populated) is always the separate global install.
    const repoMapScopeKey = isGlobalOnly
      ? updateCheckCache.kitsScopeKey('global')
      : updateCheckCache.kitsScopeKey('local', claudeDir);
    const globalScopeKey = updateCheckCache.kitsScopeKey('global');

    // Death-spiral defense: honor GitHub's 60/h anonymous rate limit across the
    // 50-user fleet — but evaluate the cooldown PER SCOPE so one scope's recent
    // success never blocks the other's discovery + spawn. Bypassed in noop mode.
    let runRepoMap = repoMap.size > 0;
    let runGlobalMap = globalRepoMap.size > 0;
    if (!noop) {
      runRepoMap = runRepoMap && updateCheckCache.shouldRun(repoMapScopeKey);
      runGlobalMap = runGlobalMap && updateCheckCache.shouldRun(globalScopeKey);
      if (!runRepoMap && !runGlobalMap) {
        timer.end({ outcome: 'cache-hit', repos: repoMap.size });
        process.exit(0);
      }
    }

    const allowMajor = readFeatureFlag(claudeDir, T1K.FEATURES.AUTO_UPDATE_MAJOR, true) !== false;

    if (noop) {
      for (const [repo, info] of repoMap) {
        const kind = info.isModular ? `modular (${info.modules.length} modules)` : `flat (v${info.localKitVersion})`;
        console.log(`[t1k:noop] would check ${repo} — ${kind} — allowMajor=${allowMajor} — scope=local`);
      }
      for (const [repo, info] of globalRepoMap) {
        const kind = info.isModular ? `modular (${info.modules.length} modules)` : `flat (v${info.localKitVersion})`;
        console.log(`[t1k:noop] would check ${repo} — ${kind} — allowMajor=${allowMajor} — scope=global`);
      }
      timer.end({ outcome: 'noop', repos: repoMap.size + globalRepoMap.size, allowMajor });
      process.exit(0);
    }

    // ── Check each repo for updates ──────────────────────────────────────────
    // Per-scope hasUpdates so the spawn block can skip scopes that have no
    // pending work — avoids unnecessary CLI invocations (each spawn writes
    // a separator to .kit-update.log).
    let localHasUpdates = false;
    let globalHasUpdates = false;
    let hasMajorBlocked = false;
    let repoMapAnyOk = false;
    let globalMapAnyOk = false;

    // Returns { anyUpdate, anyOk } per scope so the cooldown can be recorded
    // independently for each (core#449) — a global success must not stamp the
    // local scope's slot, or vice-versa.
    function checkScope(map) {
      let anyUpdate = false;
      let anyOk = false;
      for (const [repo, info] of map) {
        try {
          const result = info.isModular && info.modules.length > 0
            ? checkModularRepoVersions(repo, info.modules, allowMajor)
            : checkKitRepoVersions(repo, info.localKitVersion, allowMajor);
          if (result === 'update') anyUpdate = true;
          if (result === 'major-blocked') hasMajorBlocked = true;
          anyOk = true;
        } catch { /* skip repo, retry next session */ }
      }
      return { anyUpdate, anyOk };
    }

    // Only network-check the scope(s) not currently in cooldown.
    if (runRepoMap) {
      const r = checkScope(repoMap);
      localHasUpdates = r.anyUpdate;
      repoMapAnyOk = r.anyOk;
    }
    if (runGlobalMap) {
      const r = checkScope(globalRepoMap);
      globalHasUpdates = r.anyUpdate;
      globalMapAnyOk = r.anyOk;
    }
    const hasUpdates = localHasUpdates || globalHasUpdates;

    // Record cache outcome PER SCOPE: a successful network round-trip → success;
    // every check threw → failure (drives the backoff curve). Only record the
    // scopes we actually checked this run so an in-cooldown scope is untouched.
    if (!noop) {
      if (runRepoMap) {
        if (repoMapAnyOk) updateCheckCache.recordSuccess(repoMapScopeKey);
        else updateCheckCache.recordFailure(repoMapScopeKey);
      }
      if (runGlobalMap) {
        if (globalMapAnyOk) updateCheckCache.recordSuccess(globalScopeKey);
        else updateCheckCache.recordFailure(globalScopeKey);
      }
    }

    if (!hasUpdates) {
      logHook('check-kit-updates', { repos: repoMap.size, outcome: 'up-to-date' });
      timer.end({ outcome: 'up-to-date', repos: repoMap.size });
      process.exit(0);
    }

    // ── PRIMARY PATH: delegate to CLI ────────────────────────────────────────
    const cliBinary = findCliBinary();

    if (cliBinary) {
      // Lock guard: if another session is currently running `t1k update`, skip spawn.
      if (isInstallLockHeld()) {
        console.log('[t1k:update] update in progress by peer session — skipping spawn');
        logHook('check-kit-updates', { repos: repoMap.size, cli: true, outcome: 'lock-held' });
        timer.end({ outcome: 'lock-held', repos: repoMap.size });
        process.exit(0);
      }

      const logDir = home ? path.join(home, '.claude') : claudeDir;
      const logPath = path.join(logDir, T1K.PATHS.UPDATE_LOG);

      // Append session separator to log before spawning
      try { fs.appendFileSync(logPath, `\n===== [${new Date().toISOString()}] Auto-update via CLI =====\n`); } catch { /* ok */ }

      // Don't pass --modules here: the CLI reads installedModules from metadata
      // and handles per-kit module filtering internally. Passing all module names
      // from all kits causes MODULE_NOT_FOUND errors when the CLI picks one kit
      // and validates cross-kit module names against that kit's registry.

      // Coordination marker path — written BEFORE spawn so check-cli-updates.cjs
      // skips the redundant CLI-only update even if this process crashes.
      const markerTmp = path.join(os.tmpdir(), 't1k-update', 'spawned');

      // Use `modules update` (NOT bare `update`) — bare `update` only refreshes
      // ONE kit (cli#214 silent partial-update bug). `modules update` iterates
      // every installed module. Closes core#370.
      //
      // Dual-scope spawn (closes core#372) — `t1k modules update` is CWD-scoped:
      // it only updates modules under the current `.claude/`. A consumer project
      // session running this hook from project cwd would leave $HOME/.claude/
      // global modules drifting. Spawn local IFF local has pending updates;
      // spawn global IFF global has pending updates AND global is a separate
      // installation. Skipping no-op scopes avoids log spam.
      const cliArgs = ['modules', 'update', '--yes'];
      const wantLocalSpawn = localHasUpdates;
      const wantGlobalSpawn = !!(globalHasUpdates && globalClaudeDir);

      let localResult = null;
      let globalResult = null;

      if (wantLocalSpawn) {
        localResult = spawnT1kUpdateDetached({
          binary: cliBinary,
          args: cliArgs,
          logLabel: logPath,
          markerTmp,
          cwd,
        });
      }

      if (wantGlobalSpawn) {
        // Annotate log with a scope separator so both runs are distinguishable
        // when the next session reads .kit-update.log.
        try { fs.appendFileSync(logPath, `\n----- [${new Date().toISOString()}] Auto-update (global scope, cwd=${home}) -----\n`); } catch { /* ok */ }
        globalResult = spawnT1kUpdateDetached({
          binary: cliBinary,
          args: cliArgs,
          logLabel: logPath,
          // Coordination marker — write IFF local spawn was skipped, so
          // check-cli-updates.cjs still sees a spawn-in-flight marker.
          markerTmp: wantLocalSpawn ? undefined : markerTmp,
          cwd: home,
        });
      }

      const localOk = wantLocalSpawn ? localResult.spawned : true;
      const globalOk = wantGlobalSpawn ? globalResult.spawned : true;

      if (localOk && globalOk) {
        // SUCCESS branch uses T1K.TAGS.UPDATE. The spawn handles are released;
        // the background runner wrapper persists exit codes to .kit-update.status
        // for the NEXT session's PREV RUN FAILED banner. With two detached
        // spawns the status file reflects whichever runner finishes LAST; the
        // log file captures stderr from BOTH runs (append mode).
        const scopeParts = [];
        if (wantLocalSpawn) scopeParts.push('local');
        if (wantGlobalSpawn) scopeParts.push('global');
        const scopeLabel = scopeParts.join('+') || 'noop';
        console.log(`${T1K.TAGS.UPDATE} Spawned 't1k modules update --yes' in background [${scopeLabel}] (log: ${logPath})`);
      } else {
        // FAILURE branch uses T1K.TAGS.UPDATE_FAILED — the tag contract lets
        // log parsers distinguish spawn-level failures from successful spawns
        // (whose child may still exit non-zero — caught by the prev-status path).
        const localErr = (wantLocalSpawn && !localOk && localResult.error && localResult.error.message) || (localOk ? '' : 'unknown');
        const globalErr = (wantGlobalSpawn && !globalOk && globalResult.error && globalResult.error.message) || (globalOk ? '' : 'unknown');
        const parts = [];
        if (wantLocalSpawn && !localOk) parts.push(`local=${localErr}`);
        if (wantGlobalSpawn && !globalOk) parts.push(`global=${globalErr}`);
        console.log(`${T1K.TAGS.UPDATE_FAILED} FAILED to spawn auto-update: ${parts.join(' ')} — see ${logPath}`);
        // Spawn failed — fall through to manual extraction for the LOCAL scope
        // only. The manual fallback path operates on a single extraction root;
        // covering the global scope here would require a refactor of manualFallback.
        // Acceptable gap: CLI-missing + global-drift is a narrow edge case.
        if (wantLocalSpawn && !localOk) {
          manualFallback(repoMap, metadata, metadataPath, claudeDir, isGlobalOnly ? home : cwd, isGlobalOnly, allowMajor, autoCommitFlag, autoPushFlag);
        }
      }
    } else {
      // ── FALLBACK: manual extraction (no CLI binary on PATH) ────────────────
      manualFallback(repoMap, metadata, metadataPath, claudeDir, isGlobalOnly ? home : cwd, isGlobalOnly, allowMajor, autoCommitFlag, autoPushFlag);
    }

    logHook('check-kit-updates', { repos: repoMap.size, cli: !!cliBinary });
    timer.end({ outcome: cliBinary ? 'cli-delegated' : 'manual-fallback', repos: repoMap.size });
    process.exit(0);
  } catch (err) {
    try { require('./hook-logger.cjs').logHookCrash('check-kit-updates', err); } catch { /* ok */ }
    process.exit(0); // fail-open
  }
})();

// ── Version check helpers (no extraction — just detect if updates available) ─

/**
 * Check modular repo versions. Returns 'update', 'major-blocked', or 'up-to-date'.
 */
function checkModularRepoVersions(repo, modules, allowMajor) {
  let manifest;
  let manifestFromTag = false;
  try {
    const raw = execFileSync('gh', ['release', 'download', '--repo', repo, '--pattern', 'manifest.json', '--output', '-'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const parsed = JSON.parse(raw);
    manifest = parsed.modules || parsed;
  } catch {
    try {
      // Fallback: manifest.json not available. For modular tags like `modules-20260416-1800`,
      // we can't determine per-module versions — must assume an update is available.
      // We mark this as tag-derived so version comparison uses tag presence (not semver match).
      const rel = JSON.parse(execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName,publishedAt'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
      const tag = rel.tagName.replace(/^v/, '');
      // For tag-derived manifests, use the tag as-is. The version comparison below will
      // detect mismatch (tag !== local semver) and trigger an update, which is correct —
      // when we can't read the manifest, we should update to get the real versions.
      manifest = Object.fromEntries(modules.map(m => [m.name, { version: tag }]));
      manifestFromTag = true;
    } catch { return 'up-to-date'; }
  }

  // Build localModules map for isMajorBumpFromManifest (keyed by module name, entry has .version)
  const localModules = Object.fromEntries(modules.map(m => [m.name, { version: m.version }]));

  let result = 'up-to-date';
  for (const { name, version: local } of modules) {
    const remote = (manifest[name]?.version || '').replace(/^v/, '');
    if (!remote || remote === local) continue;

    // Use manifest-based major bump detection for modular kits; tag-derived manifests skip
    // major detection (non-semver tags would produce NaN and always return false anyway).
    const isMajor = manifestFromTag
      ? false
      : isMajorBumpFromManifest({ [name]: manifest[name] }, { [name]: localModules[name] });

    if (isMajor && !allowMajor) {
      console.log(`${T1K.TAGS.KIT_MAJOR} ${name} ${local} → ${remote} (major). Run 't1k update' manually.`);
      result = 'major-blocked';
      continue;
    }
    console.log(`[t1k:available] ${name} ${local} → ${remote}`);
    result = 'update';
  }
  return result;
}

/**
 * Check kit-level repo version. Returns 'update', 'major-blocked', or 'up-to-date'.
 */
function checkKitRepoVersions(repo, localVersion, allowMajor) {
  if (!localVersion || localVersion === '0.0.0-source' || localVersion === '0.0.0') return 'up-to-date';

  const rel = JSON.parse(execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  const remote = rel.tagName.replace(/^v/, '');
  if (remote === localVersion) return 'up-to-date';

  const kitName = repo.split('/').pop();

  if (isMajorBump(localVersion, remote) && !allowMajor) {
    console.log(`${T1K.TAGS.KIT_MAJOR} ${kitName} ${localVersion} → ${remote} (major). Run 't1k update' manually.`);
    return 'major-blocked';
  }

  console.log(`[t1k:available] ${kitName} ${localVersion} → ${remote}`);
  return 'update';
}

// ── Manual fallback (when CLI binary not on PATH) ────────────────────────────

function readMetadata(metadataPath) {
  try { return JSON.parse(fs.readFileSync(metadataPath, 'utf8')); } catch { return null; }
}

function writeMetadata(metadataPath, data) {
  try { fs.writeFileSync(metadataPath, JSON.stringify(data, null, 2) + '\n'); } catch { /* ok */ }
}

function processDeletions(deletions, claudeDir) {
  if (!Array.isArray(deletions) || deletions.length === 0) return;
  let count = 0;
  for (const pattern of deletions) {
    if (!pattern || typeof pattern !== 'string') continue;
    const fullPath = path.join(claudeDir, pattern);
    if (!fullPath.startsWith(claudeDir + path.sep) && fullPath !== claudeDir) continue;
    if (pattern.includes('*')) {
      try {
        const dir = path.join(claudeDir, path.dirname(pattern));
        if (!fs.existsSync(dir)) continue;
        if (path.basename(pattern) === '**') { fs.rmSync(dir, { recursive: true, force: true }); count++; }
      } catch { /* skip */ }
    } else {
      try {
        if (fs.existsSync(fullPath)) {
          const stat = fs.lstatSync(fullPath);
          if (stat.isDirectory()) { fs.rmSync(fullPath, { recursive: true, force: true }); }
          else { fs.unlinkSync(fullPath); }
          count++;
          try {
            const parent = path.dirname(fullPath);
            if (parent !== claudeDir && fs.existsSync(parent) && fs.readdirSync(parent).length === 0) fs.rmdirSync(parent);
          } catch { /* ok */ }
        }
      } catch { /* skip */ }
    }
  }
  if (count > 0) console.log(`[t1k:cleanup] Removed ${count} deprecated file(s)`);
}

/**
 * Manual fallback: extract ZIPs + process deletions + (opt-in) auto-commit + (opt-in) auto-push.
 * Used when `t1k` CLI binary is not on PATH.
 *
 * Auto-commit is gated on `features.autoCommitKitSync` (default ON since 2026-05-11);
 * auto-push is gated on `features.autoPushKitSync` (default ON, runs only when commit
 * succeeded). Kit short names are derived from repoMap keys for the commit message.
 */
function manualFallback(repoMap, metadata, metadataPath, claudeDir, extractionRoot, isGlobalOnly, allowMajor, flagEnabled, pushEnabled) {
  for (const [repo, info] of repoMap) {
    try {
      if (info.isModular && info.modules.length > 0) {
        manualModularUpdate(repo, info.modules, metadata, metadataPath, claudeDir, extractionRoot, allowMajor);
      } else {
        manualKitUpdate(repo, info.localKitVersion, metadata, metadataPath, claudeDir, extractionRoot, allowMajor);
      }
    } catch { /* skip repo */ }
  }

  if (!isGlobalOnly) {
    const kits = Array.from(repoMap.keys()).map(r => r.split('/').pop());
    autoCommitUpdates(process.cwd(), { flagEnabled, pushEnabled, kits });
  }
}

function manualModularUpdate(repo, modules, metadata, metadataPath, claudeDir, cwd, allowMajor) {
  let manifest;
  let manifestFromTag = false;
  try {
    const raw = execFileSync('gh', ['release', 'download', '--repo', repo, '--pattern', 'manifest.json', '--output', '-'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    const parsed = JSON.parse(raw);
    manifest = parsed.modules || parsed;
  } catch {
    try {
      // Fallback: tag-derived manifest. Modular tags like `modules-20260416-1800` are not semver.
      // The tag won't match local semver, so this correctly triggers an update attempt.
      const rel = JSON.parse(execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName,publishedAt'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
      const tag = rel.tagName.replace(/^v/, '');
      manifest = Object.fromEntries(modules.map(m => [m.name, { version: tag }]));
      manifestFromTag = true;
    } catch { return; }
  }

  for (const { name, version: local } of modules) {
    const remote = (manifest[name]?.version || '').replace(/^v/, '');
    if (!remote || remote === local) continue;
    // Use manifest-based major bump detection; tag-derived manifests skip major detection.
    const isMajor = manifestFromTag
      ? false
      : isMajorBumpFromManifest({ [name]: manifest[name] }, { [name]: { version: local } });
    if (isMajor && !allowMajor) continue;

    try {
      const oldManifestPath = path.join(claudeDir, 'modules', name, '.t1k-manifest.json');
      let oldFiles = [];
      try { oldFiles = JSON.parse(fs.readFileSync(oldManifestPath, 'utf8')).files || []; } catch { /* ok */ }

      // Use exact asset name from manifest when available to avoid glob collision
      // (e.g. "dots-*.zip" could match "dots-core-1.0.0.zip" and "dots-ai-1.0.0.zip")
      const assetName = manifest[name]?.asset;
      const pattern = assetName || `${name}-${remote}.zip`;
      const tmpZip = path.join(claudeDir, `.${name}-update.zip`);
      execFileSync('gh', ['release', 'download', '--repo', repo, '--pattern', pattern, '--output', tmpZip, '--clobber'], { timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      extractZip(tmpZip, cwd);
      try { fs.unlinkSync(tmpZip); } catch { /* ok */ }

      let newFiles = [];
      try { newFiles = JSON.parse(fs.readFileSync(oldManifestPath, 'utf8')).files || []; } catch { /* ok */ }
      const newSet = new Set(newFiles);
      for (const f of oldFiles) {
        if (!newSet.has(f)) { try { fs.rmSync(path.join(claudeDir, f), { recursive: true, force: true }); } catch { /* ok */ } }
      }

      const m = readMetadata(metadataPath);
      if (m?.installedModules?.[name]) { m.installedModules[name].version = remote; writeMetadata(metadataPath, m); }
      console.log(`${T1K.TAGS.KIT_UPDATED} ${name} ${local} → ${remote}`);
    } catch { /* retry next session */ }
  }
}

function manualKitUpdate(repo, localVersion, metadata, metadataPath, claudeDir, cwd, allowMajor) {
  if (!localVersion || localVersion === '0.0.0-source' || localVersion === '0.0.0') return;

  const rel = JSON.parse(execFileSync('gh', ['release', 'view', '--repo', repo, '--json', 'tagName,assets'], { encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }));
  const remote = rel.tagName.replace(/^v/, '');
  if (remote === localVersion) return;
  if (isMajorBump(localVersion, remote) && !allowMajor) return;

  if (rel.assets?.find(a => a.name.endsWith('.zip'))) {
    const kitName = repo.split('/').pop();
    const tmpZip = path.join(claudeDir, `.${kitName}-update.zip`);
    execFileSync('gh', ['release', 'download', '--repo', repo, '--pattern', '*.zip', '--output', tmpZip, '--clobber'], { timeout: 30000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    extractZip(tmpZip, cwd);
    try { fs.unlinkSync(tmpZip); } catch { /* ok */ }
    const m = readMetadata(metadataPath);
    if (m) {
      m.version = remote;
      writeMetadata(metadataPath, m);
      processDeletions(m.deletions, claudeDir);
    }
    console.log(`${T1K.TAGS.KIT_UPDATED} ${kitName} ${localVersion} → ${remote}`);
  }
}

// autoCommitUpdates() moved to ./lib/auto-commit-helper.cjs (Phase 03 of
// 260418-1942-t1k-ecosystem-fixes). Flag-gated on features.autoCommitKitSync
// (default OFF) so behavior is unchanged for existing users.
