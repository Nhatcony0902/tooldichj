// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-utils.cjs - Shared utilities for telemetry hooks
 *
 * DRY: centralizes telemetry opt-out check used by all telemetry hooks.
 * Standalone — no external dependencies. Ships with theonekit-core.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { execFileSync } = require('child_process');

/**
 * Extract module names from metadata, with filesystem fallback for v3 schema.
 *
 * Priority order:
 *  1. `meta.installedModules` or `meta.modules` (legacy v2 array, v3 object) — if present
 *  2. Filesystem scan of `<claudeDir>/modules/*\/module.json` — when meta lacks legacy keys
 *
 * The fallback covers v3 schema (`{ kits: { <kit>: { files: [] } } }`) where neither
 * `installedModules` nor `modules` exist at top level, and `getModuleNames(meta)` would
 * otherwise return `[]` even when modules are installed on disk (#157, #158).
 *
 * @param {{ installedModules?: object, modules?: object|string[] }} meta
 * @param {string} [claudeDir] Optional .claude/ root for filesystem scan; auto-resolved if omitted
 * @returns {string[]} module names
 */
function getModuleNames(meta, claudeDir) {
  const mods = meta?.installedModules || meta?.modules;
  if (mods) {
    return Array.isArray(mods) ? mods : Object.keys(mods);
  }
  return _scanModulesDir(claudeDir).map(e => e.name);
}

/**
 * Extract module entries with versions, with filesystem fallback for v3 schema.
 *
 * Same priority order as `getModuleNames` — meta first, filesystem second. The filesystem
 * fallback reads each `modules/<name>/module.json` to extract the `version` field.
 *
 * @param {{ installedModules?: object, modules?: object|string[] }} meta
 * @param {string} [claudeDir] Optional .claude/ root for filesystem scan; auto-resolved if omitted
 * @returns {{ name: string, version: string|null }[]}
 */
function getModuleEntries(meta, claudeDir) {
  const mods = meta?.installedModules || meta?.modules;
  if (mods) {
    if (Array.isArray(mods)) {
      return mods.map(name => ({ name, version: null }));
    }
    return Object.entries(mods).map(([name, entry]) =>
      typeof entry === 'object' ? { name, version: entry.version || null } : { name, version: null }
    );
  }
  return _scanModulesDir(claudeDir);
}

/**
 * @private
 * Scan `<claudeDir>/modules/` for installed modules (each subdir with a valid
 * `module.json` counts). Returns `{ name, version }` entries.
 *
 * When `claudeDir` is omitted, resolves via `resolveClaudeDir()`. Returns `[]` on any error
 * — callers treat absence as "no modules detected" and must not throw.
 */
function _scanModulesDir(claudeDir) {
  try {
    const dir = claudeDir || resolveClaudeDir();
    if (!dir) return [];
    const modulesRoot = path.join(dir, 'modules');
    if (!fs.existsSync(modulesRoot)) return [];
    return fs.readdirSync(modulesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => {
        const modJsonPath = path.join(modulesRoot, e.name, 'module.json');
        if (!fs.existsSync(modJsonPath)) return null;
        try {
          const mod = JSON.parse(fs.readFileSync(modJsonPath, 'utf8'));
          return { name: e.name, version: mod.version || null };
        } catch {
          return { name: e.name, version: null };
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @private
 * Pick the most relevant kit name from metadata, skipping phantom entries.
 * A phantom entry is one where `files` is undefined or an empty array —
 * written by `t1k init` when it was interrupted before file extraction.
 * SSOT for project-detector.cjs's framework derivation (#R1 — was duplicated).
 * @param {object} meta - Parsed .claude/metadata.json
 * @returns {string} kit name or 'core' as fallback
 */
function _pickFramework(meta) {
  if (meta.kitName) return meta.kitName;
  const kits = meta.kits || {};
  // Filter out phantom entries: files must be a non-empty array
  const populated = Object.entries(kits)
    .filter(([, k]) => k && Array.isArray(k.files) && k.files.length > 0)
    .sort((a, b) => (b[1].installedAt || '1970-01-01').localeCompare(a[1].installedAt || '1970-01-01'));
  if (populated.length > 0) return populated[0][0];
  return meta.name || 'core';
}

/**
 * Detect a project's type + framework from filesystem signals under `projectDir`.
 *
 * SSOT for project-detector.cjs and check-mcp-health.cjs's appliesWhen gate. The
 * detection is parameterized on `projectDir` (NOT cwd-bound) so it can run against
 * a resolved project root from any hook context. `packageManager` is detected too
 * (project-detector.cjs emits it) but not returned in the public shape — the gate
 * only needs projectType + framework.
 *
 * @param {string} projectDir absolute path to probe (typically cwd)
 * @returns {{ projectType: string, framework: string, packageManager: string }}
 *          Fail-open: returns { projectType:'unknown', framework:'', packageManager:'' } on any error.
 */
function detectProjectType(projectDir) {
  const result = { projectType: 'unknown', framework: '', packageManager: '' };
  try {
    const base = projectDir || process.cwd();
    const exists = (p) => fs.existsSync(path.join(base, p));
    const readJson = (p) => { try { return JSON.parse(fs.readFileSync(path.join(base, p), 'utf8')); } catch { return null; } };

    // TheOneKit project
    if (exists('.claude/metadata.json')) {
      const meta = readJson('.claude/metadata.json');
      if (meta) {
        result.projectType = 'theonekit';
        result.framework = _pickFramework(meta);
      }
    }
    // Unity
    else if (exists('Assets') && exists('ProjectSettings')) { result.projectType = 'unity'; result.framework = 'Unity'; }
    // Cocos
    else if (exists('assets') && (exists('project.json') || exists('settings/project.json'))) { result.projectType = 'cocos'; result.framework = 'Cocos Creator'; }
    // React Native
    else if (exists('app.json') && (exists('metro.config.js') || exists('metro.config.cjs'))) { result.projectType = 'react-native'; result.framework = exists('.expo') ? 'Expo' : 'React Native CLI'; }
    // Node.js
    else if (exists('package.json')) {
      result.projectType = 'node';
      const pkg = readJson('package.json');
      if (pkg) {
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps['next']) result.framework = 'Next.js';
        else if (deps['nuxt']) result.framework = 'Nuxt';
        else if (deps['@nestjs/core']) result.framework = 'NestJS';
        else if (deps['express']) result.framework = 'Express';
        else if (deps['react']) result.framework = 'React';
        else if (deps['vue']) result.framework = 'Vue';
      }
      result.packageManager = exists('pnpm-lock.yaml') ? 'pnpm' : exists('yarn.lock') ? 'yarn' : 'npm';
    }
    // Python
    else if (exists('pyproject.toml') || exists('requirements.txt')) {
      result.projectType = 'python';
      if (exists('manage.py')) result.framework = 'Django';
    }
    // Go
    else if (exists('go.mod')) { result.projectType = 'go'; }
    // Rust
    else if (exists('Cargo.toml')) { result.projectType = 'rust'; }
    // .NET
    else if (fs.readdirSync(base).some(f => f.endsWith('.csproj') || f.endsWith('.sln'))) { result.projectType = 'dotnet'; }
    // Docker
    else if (exists('Dockerfile') || exists('docker-compose.yml')) { result.projectType = 'containerized'; }
    // Configuration-only (like theonekit-core without metadata)
    else if (exists('.claude') && !exists('src') && !exists('package.json')) { result.projectType = 'configuration'; }
  } catch { /* fail-open — keep the 'unknown' defaults */ }
  return result;
}

/**
 * Parse hook stdin: read fd 0, parse JSON, return object or null.
 * Replaces the async `for await (const chunk of process.stdin)` pattern.
 * Cross-platform: works on Linux, macOS, and Windows.
 * @returns {object|null} parsed JSON or null on failure
 */
function parseHookStdin() {
  try {
    const raw = fs.readFileSync(0, 'utf8').trim();
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * Sensitive file patterns — SSOT for privacy-guard.cjs and secret-guard.cjs.
 * Covers env files, SSL/TLS, SSH keys, cloud credentials, CI/CD, databases,
 * package manager secrets, Terraform state, and IDE secrets.
 */
const SENSITIVE_PATTERNS = [
  // Env files
  /^\.env$/, /^\.env\./, /\/\.env$/, /\/\.env\./,
  /credentials/i, /secrets?\.ya?ml$/i,
  // SSL/TLS & Certificates
  /\.pem$/, /\.key$/, /\.crt$/, /\.p12$/, /\.pfx$/, /\.jks$/, /\.keystore$/, /\.truststore$/,
  // SSH keys
  /id_rsa/, /id_ed25519/, /id_ecdsa/, /known_hosts$/,
  // Service accounts
  /serviceaccount.*\.json$/i,
  // AWS
  /\.aws\/credentials$/, /\.aws\/config$/, /aws-exports\.js$/,
  // GCP
  /application_default_credentials\.json$/, /\/\.gcp\//,
  // Azure
  /\.azure\/accessTokens\.json$/, /\.azure\/azureProfile\.json$/,
  // Docker
  /\.docker\/config\.json$/, /\.dockerconfigjson$/,
  // Kubernetes
  /kubeconfig$/, /-secret\.ya?ml$/,
  // CI/CD
  /\.circleci\/config\.yml$/, /\.travis\.yml$/,
  // Databases
  /\.pgpass$/, /\.my\.cnf$/, /mongod\.conf$/,
  // Package managers
  /\.npmrc$/, /\.pypirc$/, /\.gem\/credentials$/,
  // Terraform
  /terraform\.tfstate$/, /terraform\.tfvars$/,
  // IDE
  /\.idea\/dataSources\.xml$/,
  // General
  /htpasswd$/, /\.netrc$/,
];

/**
 * Secret token patterns — SSOT for content-redaction across sanitizer hooks.
 * Used by lib/kit-error-sanitizer.cjs (SECRET_PATTERNS) to strip tokens from
 * error payloads, lesson markers, and stack traces before fingerprinting.
 * Each entry: { re: RegExp (with /g flag), replace: string }
 */
const SECRET_TOKEN_PATTERNS = [
  // Slack tokens (bot, app, legacy)
  { re: /xox[abp]-[A-Za-z0-9_-]{20,}/g, replace: 'xox-***' },
  // Anthropic API keys
  { re: /sk-ant-[A-Za-z0-9_-]{20,}/g, replace: 'sk-ant-***' },
];

/** Safe patterns — exempt from sensitive file checks */
const SAFE_PATTERNS = [
  /\.example$/i, /\.sample$/i, /\.template$/i, /\.schema$/i,
  /node_modules/, /\.claude\//,
];

/**
 * Today's date as YYYYMMDD string, for date-stamped telemetry filenames.
 * @returns {string}
 */
// Memoized at module load so cache-prefix consumers get a byte-stable value
// across calls within one process. Phase 02 (architecture-review): a midnight
// crossing within a single session pays at most one stale prefix on the next
// turn — same as today's worst case. Per-event timestamps that DO need live
// time use `new Date().toISOString()` directly at the call site.
const TODAY_DATE_STR = new Date().toISOString().slice(0, 10).replace(/-/g, '');
function todayDateStr() {
  return TODAY_DATE_STR;
}

// ── Shared constants (single source of truth for all telemetry hooks) ──
const T1K = {
  CLAUDE_DIR: '.claude',
  METADATA_FILE: 'metadata.json',
  CONFIG_PREFIX: 't1k-config-',
  ACTIVATION_PREFIX: 't1k-activation-',
  ROUTING_PREFIX: 't1k-routing-',
  SKILLS_DIR: 'skills',
  STATE_FILE: '.prompt-state.json',
  GH_TOKEN_CACHE: '.gh-token-cache',
  USAGE_PREFIX: 'usage-',
  ERRORS_PREFIX: 'errors-',
  TELEMETRY_DIR: 'telemetry',
  // Teammate marker queue: per-teammate JSONL staged in tmpdir, drained by
  // parent's Stop hook. Filename pattern:
  //   <prefix><sessionKey>-<agentName>.jsonl
  // sessionKey is a stable hash of the project root so parent + all teammates
  // resolve to the same correlation key regardless of CLAUDE_SESSION_ID
  // diverging across subagent processes. See lesson-collector.cjs §teammate-capture
  // and docs/lesson-collector-teammate-capture.md.
  TEAMMATE_QUEUE_PREFIX: 't1k-teammate-markers-',
  TEAMMATE_QUEUE_SUFFIX: '.jsonl',
  // Feature flag names — referenced by readFeatureFlag() and by kit maintainers
  // to toggle behavior in t1k-config-*.json. All flags are under `features.*`.
  FEATURES: {
    AUTO_UPDATE: 'autoUpdate',
    AUTO_UPDATE_MAJOR: 'autoUpdateMajor',
    AUTO_ISSUE_SUBMISSION: 'autoIssueSubmission',
    TELEMETRY: 'telemetry',
    EXECUTION_TRACE: 'executionTrace',
    HOOK_LOGGING: 'hookLogging',
    // Phase 03 of 260418-1942-t1k-ecosystem-fixes. Default ON (flipped from
    // OFF on 2026-05-11 for the ~50-user internal fleet). When enabled,
    // check-kit-updates.cjs auto-commits `.claude/` changes produced by the
    // auto-update pipeline. See docs in skills/t1k-kit/references/cli-auto-update.md.
    AUTO_COMMIT_KIT_SYNC: 'autoCommitKitSync',
    // Sibling to AUTO_COMMIT_KIT_SYNC. When both flags are on, the auto-commit
    // helper runs `git push` after the commit succeeds — pushes to the current
    // branch's upstream (or `git push -u origin HEAD` if no upstream is set).
    // Never --force. Fail-open: a push failure logs but retains the commit.
    AUTO_PUSH_KIT_SYNC: 'autoPushKitSync',
  },
  // Log tags emitted by hooks and parsed by AI per skills/t1k-kit/references/cli-auto-update.md
  // and skills/t1k-fix/references/error-recovery.md. Tags are the stable contract — do NOT
  // change spelling without updating all rule docs that match on them.
  TAGS: {
    CLI_UPDATE: '[t1k:cli-update]',
    CLI_MAJOR: '[t1k:cli-major]',
    KIT_UPDATED: '[t1k:updated]',
    KIT_MAJOR: '[t1k:major-update]',
    AUTO_COMMIT: '[t1k:auto-commit]',
    AUTO_PUSH: '[t1k:auto-push]',
    SETTINGS_REPAIR: '[t1k:settings-repair]',
    // Auto-update banner tag contract (Phase 02 of 260418-1942-t1k-ecosystem-fixes).
    // UPDATE         — emitted when spawn succeeded (prev-run status may still report failure)
    // UPDATE_FAILED  — emitted when spawn itself failed OR when prev-run status reports exitCode !== 0
    // Log parsers MUST distinguish outcomes by tag alone; never mix.
    UPDATE: '[t1k:update]',
    UPDATE_FAILED: '[t1k:update-failed]',
  },
  // Paths (relative to the $HOME/.claude dir) for artifacts produced by the auto-update
  // pipeline. Single source of truth for both the runner (writer) and session-start
  // hooks (readers). Kept in T1K constants so file-name changes never require a grep.
  PATHS: {
    UPDATE_STATUS: '.kit-update.status',
    UPDATE_LOG: '.kit-update.log',
  },
  // Dry-run env vars used by CI tests to exercise branching without side effects
  ENV: {
    CLI_UPDATE_NOOP: 'T1K_CLI_UPDATE_NOOP',
    KIT_UPDATE_NOOP: 'T1K_KIT_UPDATE_NOOP',
    AUTO_ISSUE_DRY_RUN: 'T1K_AUTO_ISSUE_DRY_RUN',
  },
};

/**
 * Check if telemetry is disabled via t1k-config-core.json.
 * Returns true if telemetry is enabled (or config unreadable — fail-open).
 */
function isTelemetryEnabled() {
  const configPath = path.join(findProjectRoot(), '.claude', 't1k-config-core.json');
  if (!fs.existsSync(configPath)) return true; // No config = enabled (fail-open)
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return !(config.features && config.features.telemetry === false);
  } catch {
    return true; // Config unreadable = enabled (fail-open)
  }
}

/**
 * Find the project root directory for filesystem operations (telemetry writes, etc.).
 *
 * Delegates to resolveProjectDir() so T1K-shape verification is applied — CK-shape
 * metadata and stub `.claude/` directories are skipped during walk-up. In pure
 * global-only mode (no T1K metadata anywhere in the tree), falls back to CWD.
 *
 * @returns {string} absolute path to project root
 */
function findProjectRoot() {
  const resolved = resolveProjectDir();
  if (resolved.t1kDir) return path.dirname(resolved.t1kDir);
  return process.cwd();
}

/**
 * Ensure .claude/telemetry/ directory exists. Returns the path.
 * Uses findProjectRoot() instead of CWD for correct resolution.
 */
function ensureTelemetryDir() {
  const projectRoot = findProjectRoot();
  const dir = path.join(projectRoot, T1K.CLAUDE_DIR, T1K.TELEMETRY_DIR);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Dedup guard: prevents the same hook from executing twice for the same event
 * WITHIN THE SAME SESSION. Concurrent sessions MUST NOT block each other
 * (H2 remediation — see plans/reports/260422-1248-self-assembling-kit-architecture.md §18.3).
 *
 * Used by hook-runner.cjs to auto-dedup all project-level hooks against global hooks.
 *
 * Mechanism: MD5 hash of hookName + (CLAUDE_SESSION_ID || pid) + stdin →
 * lock file in OS temp dir. Entropy from the session ID / pid guarantees
 * two parallel sessions with identical stdin produce different lock files.
 * First call creates lock → returns false (proceed).
 * Second call within 3s with same session+stdin finds lock → returns true (skip).
 * Locks auto-cleaned after 5 seconds.
 *
 * @param {string} hookName - Hook identifier (e.g., 'prompt-telemetry')
 * @param {string} stdinContent - Full stdin content from Claude Code
 * @returns {boolean} true if duplicate (should skip), false if first invocation
 */
function dedupGuard(hookName, stdinContent) {
  try {
    const sessionEntropy = process.env.CLAUDE_SESSION_ID || String(process.pid);
    const stdinHash = crypto.createHash('md5')
      .update(stdinContent || '')
      .digest('hex').slice(0, 16);
    const lockDir = path.join(os.tmpdir(), 't1k-dedup');
    if (!fs.existsSync(lockDir)) fs.mkdirSync(lockDir, { recursive: true });
    // Lock filename: {hookName}-{sessionId|pid}-{md5(stdin).slice(0,16)}.lock
    // Sanitize hookName + sessionEntropy (strip path separators) so the filename
    // stays a single atom regardless of caller input.
    const safeHook = String(hookName).replace(/[^a-zA-Z0-9_.-]/g, '_');
    const safeSession = sessionEntropy.replace(/[^a-zA-Z0-9_.-]/g, '_');
    const lockPath = path.join(lockDir, `${safeHook}-${safeSession}-${stdinHash}.lock`);
    if (fs.existsSync(lockPath)) {
      const lockAge = Date.now() - fs.statSync(lockPath).mtimeMs;
      if (lockAge < 3000) return true; // duplicate within 3s window
    }
    fs.writeFileSync(lockPath, '1');
    // Lazy cleanup: remove locks older than 5 seconds
    try {
      for (const f of fs.readdirSync(lockDir)) {
        const fp = path.join(lockDir, f);
        if (Date.now() - fs.statSync(fp).mtimeMs > 5000) fs.unlinkSync(fp);
      }
    } catch { /* cleanup failure is non-critical */ }
    return false;
  } catch {
    return false; // fail-open
  }
}

/**
 * Emit a telemetry warning to stderr, but only once per session per reason.
 * Writes a marker file so the same warning doesn't repeat on every prompt.
 *
 * @param {string} reason - Short key like 'no-gh', 'no-auth', 'scope-missing', 'auth-failed'
 * @param {string} message - Human-readable message
 */
function warnOnce(reason, message) {
  try {
    const dir = ensureTelemetryDir();
    const markerPath = path.join(dir, `.warned-${reason}`);
    if (fs.existsSync(markerPath)) return; // Already warned this session
    fs.writeFileSync(markerPath, '1');
    process.stderr.write(`[t1k:telemetry-warn] ${message}\n`);
  } catch { /* non-critical */ }
}

/**
 * Check if gh CLI has the required read:org scope for telemetry.
 * Returns true if scope is present, false if missing or unknown.
 * Caches result per session via marker file.
 */
function checkGhOrgScope() {
  try {
    // gh auth status outputs to stderr — capture both stdout and stderr
    const result = execFileSync('gh', ['auth', 'status', '-h', 'github.com'], {
      timeout: 5000,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    // Check stdout (some gh versions) + try stderr via error
    if (result && result.includes('read:org')) return true;
    return false;
  } catch (err) {
    // gh auth status exits non-zero but puts scope info in stderr
    const stderr = err.stderr || '';
    const stdout = err.stdout || '';
    if ((stderr + stdout).includes('read:org')) return true;
    return false;
  }
}

/**
 * User home directory for cross-platform $HOME / %USERPROFILE% resolution.
 * @returns {string} home dir, or '' if neither env var set
 */
function getHomeDir() {
  return process.env.HOME || process.env.USERPROFILE || '';
}

/**
 * Walk up from `startDir` looking for a `.claude/` directory matching `predicate(claudeDir)`.
 * Bounded by `maxDepth` levels and the filesystem root. Used by `resolveClaudeDir` and
 * `resolveProjectDir` to share walk logic with different acceptance rules.
 *
 * @param {(claudeDir: string) => boolean} predicate Returns true when claudeDir is acceptable
 * @param {string} [startDir=process.cwd()]
 * @param {number} [maxDepth=20]
 * @returns {{ claudeDir: string, projectDir: string }|null}
 */
function walkUpForClaudeDir(predicate, startDir = process.cwd(), maxDepth = 20) {
  let dir = startDir;
  const fsRoot = path.parse(dir).root;
  for (let depth = 0; depth < maxDepth && dir; depth++) {
    const claudeDir = path.join(dir, T1K.CLAUDE_DIR);
    if (predicate(claudeDir)) return { claudeDir, projectDir: dir };
    if (dir === fsRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Resolve the .claude/ directory, with global-only mode awareness.
 * Walks up from CWD looking for .claude/ with metadata.json or settings.json.
 * Falls back to ~/.claude/ (global-only mode).
 * Returns { claudeDir, isGlobalOnly, home } or null if no .claude/ found anywhere.
 */
function resolveClaudeDir() {
  const home = getHomeDir();
  // Priority 0: T1K_HOOK_DIR — hook-runner.cjs sets this from __dirname, always correct.
  // Fixes #14: when project is a subdir of a git repo, CWD-based walk-up lands on
  // $HOME/.claude/ instead of the project .claude/.
  const hookDir = process.env.T1K_HOOK_DIR;
  if (hookDir) {
    const candidate = path.join(hookDir, T1K.CLAUDE_DIR);
    if (fs.existsSync(path.join(candidate, T1K.METADATA_FILE)) ||
        fs.existsSync(path.join(candidate, 'settings.json'))) {
      return { claudeDir: candidate, isGlobalOnly: false, home };
    }
  }
  const found = walkUpForClaudeDir((claudeDir) =>
    fs.existsSync(path.join(claudeDir, T1K.METADATA_FILE)) ||
    fs.existsSync(path.join(claudeDir, 'settings.json'))
  );
  if (found) return { claudeDir: found.claudeDir, isGlobalOnly: false, home };
  const globalClaudeDir = home ? path.join(home, T1K.CLAUDE_DIR) : '';
  if (globalClaudeDir && fs.existsSync(globalClaudeDir)) {
    return { claudeDir: globalClaudeDir, isGlobalOnly: true, home };
  }
  return null;
}

/**
 * Read static telemetry context: project, kit, versions, modules.
 * Shared between prompt-telemetry.cjs and prompt-telemetry-flush.cjs.
 * Cached per session in a temp file (60s TTL) to avoid repeated git spawns.
 * @param {string} projectRoot - resolved project root
 * @returns {{ project, kit, hookVersion, cliVersion, installedModules, installedKits }}
 */
function readTelemetryContext(projectRoot) {
  // Check session cache first (avoids 3+ git spawns per prompt)
  const CONTEXT_CACHE_TTL_MS = 60000;
  const cacheKey = crypto.createHash('md5').update(projectRoot).digest('hex').slice(0, 8);
  const cachePath = path.join(os.tmpdir(), `t1k-ctx-${cacheKey}.json`);
  try {
    if (fs.existsSync(cachePath)) {
      const stat = fs.statSync(cachePath);
      if (Date.now() - stat.mtimeMs < CONTEXT_CACHE_TTL_MS) {
        return JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      }
    }
  } catch { /* cache miss — compute fresh */ }

  const result = _computeTelemetryContext(projectRoot);

  // Write cache (fail-open)
  try { fs.writeFileSync(cachePath, JSON.stringify(result)); } catch {}
  return result;
}

/** @private Compute telemetry context (expensive — git spawns + file reads). */
function _computeTelemetryContext(projectRoot) {
  const claudeDir = path.join(projectRoot, '.claude');
  const metaPath = path.join(claudeDir, T1K.METADATA_FILE);
  let project = null, kit = null, hookVersion = null, cliVersion = null;
  let installedModules = [], installedKits = {};

  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      kit = meta.name || meta.kitName || null;
      hookVersion = meta.version || null;
      installedModules = getModuleEntries(meta, claudeDir);
      if (meta.kits) {
        for (const [k, v] of Object.entries(meta.kits)) {
          installedKits[k] = typeof v === 'object' ? (v.version || null) : v;
        }
      }
    } catch {}
  }

  // SoT: hook version is read from .claude/metadata.json only.
  // No git-tag fallback — that leaks unrelated repo tags (wrangler, etc.) into telemetry.
  // When metadata is missing or has the "1.0.0" placeholder, surface null and let the
  // dashboard classify the install as "unknown" so users see a clear upgrade signal.
  if (hookVersion === '1.0.0') hookVersion = null;

  // Read config fragments for kit name + installed kits discovery
  // Config fragments use either `kitName` (core: "theonekit-core") or `kit` (engine: "unity")
  try {
    for (const f of fs.readdirSync(claudeDir).filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'))) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        const fragKit = c.kitName || c.kit || null;
        if (!kit && fragKit) kit = fragKit;
        if (fragKit) {
          const kn = fragKit.replace(/^theonekit-/, '');
          if (!installedKits[kn]) installedKits[kn] = hookVersion || 'unknown';
        }
      } catch {}
    }
  } catch {}
  project = deriveProjectName(projectRoot);

  // cliVersion: read from global metadata only. No git-tag fallback (homedir is not a git repo).
  try {
    const globalMetaPath = path.join(os.homedir(), T1K.CLAUDE_DIR, T1K.METADATA_FILE);
    if (globalMetaPath !== metaPath && fs.existsSync(globalMetaPath)) {
      cliVersion = JSON.parse(fs.readFileSync(globalMetaPath, 'utf8')).version || null;
    }
  } catch {}
  if (cliVersion === '1.0.0') cliVersion = null;

  // Git branch
  let gitBranch = null;
  try {
    gitBranch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
      encoding: 'utf8', timeout: 3000, cwd: projectRoot,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || null;
  } catch {}

  return { project, kit, hookVersion, cliVersion, installedModules, installedKits, gitBranch };
}

/**
 * Read telemetry endpoint from config or environment.
 * @param {string} projectRoot
 * @returns {string|null}
 */
function readTelemetryEndpoint(projectRoot) {
  if (process.env.T1K_TELEMETRY_ENDPOINT) return process.env.T1K_TELEMETRY_ENDPOINT;
  const configPath = path.join(projectRoot, '.claude', 't1k-config-core.json');
  if (!fs.existsSync(configPath)) return null;
  try {
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    return config.telemetry?.cloud?.endpoint || null;
  } catch { return null; }
}

/**
 * Get GitHub token for telemetry auth. Caches per session (30min TTL).
 * @param {string} telemetryDir - path to .claude/telemetry/
 * @returns {string|null} token or null
 */
function getGhToken(telemetryDir) {
  const tokenCachePath = path.join(telemetryDir, T1K.GH_TOKEN_CACHE);
  const TOKEN_MAX_AGE_MS = 30 * 60 * 1000;
  if (fs.existsSync(tokenCachePath)) {
    const stat = fs.statSync(tokenCachePath);
    if (Date.now() - stat.mtimeMs < TOKEN_MAX_AGE_MS) {
      return fs.readFileSync(tokenCachePath, 'utf8').trim() || null;
    }
  }
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      timeout: 5000, encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    if (token) fs.writeFileSync(tokenCachePath, token, { mode: 0o600 });
    return token || null;
  } catch { return null; }
}

/**
 * Emit one telemetry event to the /ingest endpoint — the SINGLE transport path
 * for every kit (core hooks AND non-core kits via telemetry-emit.cjs). Resolves
 * endpoint + auth token through the existing helpers, POSTs with the mandatory
 * `Authorization: Bearer` header, and is strictly fail-open: never throws, never
 * blocks the caller, returns a status object instead.
 *
 * SSOT contract: callers own the PAYLOAD shape (event `type` + fields); this owns
 * the WIRE (endpoint, auth header, timeout, fail-open). The /ingest endpoint
 * rejects un-authed POSTs with 401, so routing every emitter through here is what
 * prevents per-caller auth drift (the class of bug that silently dropped
 * model-router delegation events — they POSTed without the Bearer header).
 *
 * @param {object} payload Event payload (should include a `type`); JSON-serialized.
 * @param {object} [opts]
 * @param {string} [opts.endpoint]     Pre-resolved endpoint (skips config read).
 * @param {string} [opts.ghToken]      Pre-resolved token (skips gh lookup).
 * @param {string} [opts.projectRoot]  Root for endpoint/token resolution (default: findProjectRoot()).
 * @param {string} [opts.telemetryDir] Dir holding the gh-token cache (default: <root>/.claude/telemetry).
 * @param {number} [opts.timeoutMs=3000]
 * @returns {Promise<{ok:boolean, status?:number, skipped?:string}>} Never rejects.
 */
async function emitTelemetryEvent(payload, opts = {}) {
  try {
    if (!isTelemetryEnabled()) return { ok: false, skipped: 'disabled' };
    const projectRoot = opts.projectRoot || findProjectRoot() || process.cwd();
    const endpoint = opts.endpoint || readTelemetryEndpoint(projectRoot);
    if (!endpoint) return { ok: false, skipped: 'no-endpoint' };
    let ghToken = opts.ghToken;
    if (!ghToken) {
      const telemetryDir = opts.telemetryDir || path.join(projectRoot, '.claude', 'telemetry');
      try { fs.mkdirSync(telemetryDir, { recursive: true }); } catch { /* ok */ }
      ghToken = getGhToken(telemetryDir);
    }
    if (!ghToken) return { ok: false, skipped: 'no-token' };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 3000);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ghToken}` },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      return { ok: !!res && res.ok, status: res ? res.status : undefined };
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return { ok: false, skipped: 'error' };
  }
}

/**
 * Count errors logged after a given timestamp from JSONL error files.
 * @param {string} telemetryDir
 * @param {number} afterTimestamp - epoch ms
 * @returns {number}
 */
function countErrorsSince(telemetryDir, afterTimestamp) {
  const date = todayDateStr();
  const errFile = path.join(telemetryDir, `errors-${date}.jsonl`);
  if (!fs.existsSync(errFile)) return 0;
  let count = 0;
  for (const line of fs.readFileSync(errFile, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      if (new Date(JSON.parse(line).ts).getTime() > afterTimestamp) count++;
    } catch { /* skip */ }
  }
  return count;
}

/**
 * Verify that a parsed metadata.json object is T1K-shape (not ClaudeKit or other frameworks).
 *
 * A metadata object is T1K-shape if ANY of these hold:
 *   - Has `installedModules` key (schemaVersion 3, module-first architecture)
 *   - Has `modules` (array or object) AND `schemaVersion === 2` (v2 legacy)
 *   - `name` starts with `theonekit-` (any schema)
 *   - `kitName` starts with `theonekit-` (v1 legacy, pre-module)
 *
 * Rejects CK shape (`kits.engineer` or any `kits.*` without T1K markers) and
 * any object that lacks all of the above markers.
 *
 * @param {object|null|undefined} meta Parsed metadata.json content
 * @returns {boolean}
 */
function isT1KMetadata(meta) {
  if (!meta || typeof meta !== 'object') return false;
  if (meta.installedModules && typeof meta.installedModules === 'object') return true;
  if (meta.schemaVersion === 2 && (Array.isArray(meta.modules) || typeof meta.modules === 'object')) return true;
  if (typeof meta.name === 'string' && meta.name.startsWith('theonekit-')) return true;
  if (typeof meta.kitName === 'string' && meta.kitName.startsWith('theonekit-')) return true;
  return false;
}

/**
 * Derive a project name for telemetry attribution.
 * Priority: git remote origin URL basename (auth-stripped) → cwd basename → 'unknown'.
 * Never logs or returns a full path — only a basename (PII-safe).
 *
 * @param {string} [cwd=process.cwd()] Directory to derive from
 * @returns {string} project name (basename)
 */
function deriveProjectName(cwd = process.cwd()) {
  try {
    const remote = execFileSync('git', ['remote', 'get-url', 'origin'], {
      encoding: 'utf8', timeout: 3000, cwd,
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    // Strip auth: https://token@github.com/... → https://github.com/...
    const stripped = remote.replace(/https?:\/\/[^@\s]+@/, 'https://');
    const match = stripped.match(/\/([^/]+?)(?:\.git)?$/);
    if (match && match[1]) return match[1];
  } catch { /* no git remote */ }
  return path.basename(cwd) || 'unknown';
}

let _resolveProjectDirCache = null;
let _resolveProjectDirCacheKey = null;

/**
 * Build the return shape with a lazy `projectName` getter.
 * `deriveProjectName()` spawns git (~50–200ms); many callers only need `t1kDir`.
 * Deferring the spawn avoids paying that cost on every hook invocation.
 */
function _buildResolution({ nameDir, t1kDir, globalOnly, source }) {
  let _name;
  return {
    get projectName() {
      if (_name === undefined) _name = deriveProjectName(nameDir);
      return _name;
    },
    t1kDir,
    globalOnly,
    source,
  };
}

/**
 * Resolve the T1K project context for the current session.
 *
 * Resolution order:
 *   1. env `CLAUDE_PROJECT_DIR` — only trusted if the target has T1K-shape metadata
 *   2. Walk up from CWD (bounded) for .claude/metadata.json with T1K-shape.
 *      Skips stubs (no metadata) and non-T1K metadata (e.g., CK `kits.engineer`).
 *   3. Global-only fallback: ~/.claude/ if it exists.
 *
 * Env var is not blindly trusted — non-T1K harnesses may set CLAUDE_PROJECT_DIR
 * at their own root. Target must contain T1K-shape metadata.
 *
 * @returns {{
 *   projectName: string,    // lazy — computed on first access (spawns git)
 *   t1kDir: string|null,
 *   globalOnly: boolean,
 *   source: 'env'|'walk'|'global-fallback'
 * }}
 */
function resolveProjectDir() {
  const cwd = process.cwd();
  if (_resolveProjectDirCache && _resolveProjectDirCacheKey === cwd) {
    return _resolveProjectDirCache;
  }

  let result = null;

  // Priority 0: T1K_HOOK_DIR — set by hook-runner.cjs from __dirname, always correct.
  // Fixes #14: when project lives in a subdir of a git repo, hook-runner spawns children
  // with cwd=git-root (no .claude/), causing walk-up to reach $HOME/.claude/ instead.
  const hookDir = process.env.T1K_HOOK_DIR;
  if (hookDir && _claudeDirHasT1KMetadata(path.join(hookDir, T1K.CLAUDE_DIR))) {
    result = _buildResolution({
      nameDir: hookDir,
      t1kDir: path.join(hookDir, T1K.CLAUDE_DIR),
      globalOnly: false,
      source: 'env',
    });
  }

  const envDir = process.env.CLAUDE_PROJECT_DIR;
  if (!result && envDir && _claudeDirHasT1KMetadata(path.join(envDir, T1K.CLAUDE_DIR))) {
    result = _buildResolution({
      nameDir: envDir,
      t1kDir: path.join(envDir, T1K.CLAUDE_DIR),
      globalOnly: false,
      source: 'env',
    });
  }

  if (!result) {
    const found = walkUpForClaudeDir(_claudeDirHasT1KMetadata, cwd);
    if (found) {
      result = _buildResolution({
        nameDir: found.projectDir,
        t1kDir: found.claudeDir,
        globalOnly: false,
        source: 'walk',
      });
    }
  }

  if (!result) {
    const home = getHomeDir();
    const globalDir = home ? path.join(home, T1K.CLAUDE_DIR) : '';
    result = _buildResolution({
      nameDir: cwd,
      t1kDir: globalDir && fs.existsSync(globalDir) ? globalDir : null,
      globalOnly: true,
      source: 'global-fallback',
    });
  }

  _resolveProjectDirCache = result;
  _resolveProjectDirCacheKey = cwd;
  return result;
}

/** Predicate: claudeDir contains a T1K-shape metadata.json. */
function _claudeDirHasT1KMetadata(claudeDir) {
  try {
    const raw = fs.readFileSync(path.join(claudeDir, T1K.METADATA_FILE), 'utf8');
    return isT1KMetadata(JSON.parse(raw));
  } catch { return false; }
}

/**
 * Read activated skills since a given timestamp from usage JSONL.
 * @param {string} telemetryDir
 * @param {number} afterTimestamp - epoch ms
 * @returns {string[]}
 */
function readActivatedSkillsSince(telemetryDir, afterTimestamp) {
  const date = todayDateStr();
  const usageFile = path.join(telemetryDir, `usage-${date}.jsonl`);
  if (!fs.existsSync(usageFile)) return [];
  const skills = new Set();
  for (const line of fs.readFileSync(usageFile, 'utf8').trim().split('\n').filter(Boolean)) {
    try {
      const entry = JSON.parse(line);
      const name = entry.skill || entry.name;
      if (new Date(entry.ts).getTime() > afterTimestamp && name) skills.add(name);
    } catch { /* skip */ }
  }
  return [...skills];
}

/**
 * Read a boolean feature flag from any t1k-config-*.json fragment.
 *
 * Behavior:
 *   - Scans ALL t1k-config-*.json fragments under claudeDir
 *   - ANY fragment explicitly setting the flag to `false` wins (opt-out wins)
 *   - ANY fragment explicitly setting the flag to `true` forces true (opt-in wins)
 *   - If no fragment sets it, returns `defaultValue`
 *
 * Use this for any cross-kit feature flag: autoUpdate, autoUpdateMajor,
 * telemetry, executionTrace, autoIssueSubmission, etc. Core owns the flag
 * machinery — every kit just ships its preference in its own fragment.
 *
 * @param {string} claudeDir - absolute path to the .claude/ directory
 * @param {string} flagName - e.g. 'autoUpdateMajor'
 * @param {boolean} defaultValue - value when no fragment specifies the flag
 * @returns {boolean}
 */
function readFeatureFlag(claudeDir, flagName, defaultValue) {
  let seenExplicit = false;
  let explicitValue = defaultValue;
  try {
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const cf of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(claudeDir, cf), 'utf8'));
        const v = c.features?.[flagName];
        if (v === false) return false; // opt-out always wins
        if (v === true) { seenExplicit = true; explicitValue = true; }
      } catch { /* skip unreadable fragment */ }
    }
  } catch { /* no claudeDir or unreadable */ }
  return seenExplicit ? explicitValue : defaultValue;
}

/**
 * Detect whether the current hook process is running in a teammate / sub-agent
 * context (as opposed to the main session's Stop hook).
 *
 * Used by lesson-collector.cjs to branch: teammates stage markers to /tmp for
 * parent merge (#272), main agent drains those queues into the canonical
 * pending-skill-updates.jsonl with full dedup + rate-limit.
 *
 * Signals checked, in order:
 *   1. hookData.hook_event_name === 'SubagentStop' (canonical, set by Claude Code)
 *   2. process.env.CLAUDE_TEAM_NAME (Agent Teams backend, if exposed)
 *   3. hookData.agent_type is a non-empty string (only present in SubagentStop payload)
 *
 * @param {object|null} hookData parsed Stop / SubagentStop stdin payload
 * @returns {boolean}
 */
function isTeammateContext(hookData) {
  if (hookData && hookData.hook_event_name === 'SubagentStop') return true;
  if (process.env.CLAUDE_TEAM_NAME) return true;
  if (hookData && typeof hookData.agent_type === 'string' && hookData.agent_type) return true;
  return false;
}

/**
 * Compute a stable per-session correlation key for cross-process teammate
 * marker staging. Both parent and teammate processes derive the same key from
 * the project root (CLAUDE_PROJECT_DIR or findProjectRoot()).
 *
 * Why not CLAUDE_SESSION_ID: subagents may inherit a different session id
 * from the harness, breaking parent↔teammate correlation. Project root is
 * stable across the same logical session.
 *
 * @returns {string} 16-char hex md5
 */
function computeTeammateSessionKey() {
  const root = process.env.CLAUDE_PROJECT_DIR || findProjectRoot() || process.cwd();
  return crypto.createHash('md5').update(String(root)).digest('hex').slice(0, 16);
}

/**
 * Build the teammate marker queue path for a given session key + agent name.
 * Filename pattern: <tmpdir>/<TEAMMATE_QUEUE_PREFIX><sessionKey>-<safeAgentName>.jsonl
 *
 * Agent names are sanitized (only [A-Za-z0-9_.-] allowed, max 64 chars) so
 * caller-supplied strings cannot escape tmpdir.
 *
 * @param {string} sessionKey from computeTeammateSessionKey()
 * @param {string} agentName teammate's agent_type or fallback id
 * @returns {string} absolute path
 */
function teammateQueuePath(sessionKey, agentName) {
  const safeAgent = String(agentName || 'unknown')
    .replace(/[^A-Za-z0-9_.-]/g, '_')
    .slice(0, 64) || 'unknown';
  return path.join(
    os.tmpdir(),
    `${T1K.TEAMMATE_QUEUE_PREFIX}${sessionKey}-${safeAgent}${T1K.TEAMMATE_QUEUE_SUFFIX}`,
  );
}

/**
 * Read all teammate marker queue files for the current session, parse them,
 * and return both the collected marker objects AND the list of source files
 * (so the caller can delete them AFTER the parent's queue write succeeds).
 *
 * Each line in the queue file is a JSON-encoded marker object matching the
 * shape produced by lesson-collector.cjs parseMarkers().
 *
 * @param {string} sessionKey from computeTeammateSessionKey()
 * @returns {{ markers: object[], files: string[] }}
 */
function drainTeammateQueues(sessionKey) {
  const markers = [];
  const files = [];
  try {
    const tmpDir = os.tmpdir();
    const prefix = `${T1K.TEAMMATE_QUEUE_PREFIX}${sessionKey}-`;
    const suffix = T1K.TEAMMATE_QUEUE_SUFFIX;
    const candidates = fs.readdirSync(tmpDir).filter(f =>
      f.startsWith(prefix) && f.endsWith(suffix)
    );
    for (const f of candidates) {
      const fp = path.join(tmpDir, f);
      try {
        const raw = fs.readFileSync(fp, 'utf8');
        for (const line of raw.split('\n')) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            markers.push(JSON.parse(trimmed));
          } catch { /* skip malformed line */ }
        }
        files.push(fp);
      } catch { /* skip unreadable file */ }
    }
  } catch { /* tmpdir unreadable — return empty */ }
  return { markers, files };
}

module.exports = { T1K, SENSITIVE_PATTERNS, SAFE_PATTERNS, SECRET_TOKEN_PATTERNS, parseHookStdin, getModuleNames, getModuleEntries, detectProjectType, isTelemetryEnabled, ensureTelemetryDir, findProjectRoot, dedupGuard, warnOnce, checkGhOrgScope, resolveClaudeDir, resolveProjectDir, isT1KMetadata, deriveProjectName, getHomeDir, walkUpForClaudeDir, readTelemetryContext, readTelemetryEndpoint, getGhToken, emitTelemetryEvent, countErrorsSince, readActivatedSkillsSince, todayDateStr, readFeatureFlag, isTeammateContext, computeTeammateSessionKey, teammateQueuePath, drainTeammateQueues };
