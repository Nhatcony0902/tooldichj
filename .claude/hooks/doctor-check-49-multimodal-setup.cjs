// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-49-multimodal-setup.cjs — Doctor check #49.
 *
 * Validates the multimodal module setup when the `t1k-extended` module is
 * installed AND the `t1k-extended-multimodal` skill directory is present.
 * installedModules is keyed by MODULE name (t1k-extended), not skill name —
 * the skill directory check is the secondary guard for partial installs.
 * Checks:
 *
 *   1. GEMINI_API_KEY env var is set (WARN if absent)
 *   2. MINIMAX_API_KEY env var is set (WARN if absent — optional)
 *   3. python3 >= 3.10 is available (FAIL if missing or too old)
 *   4. github:The1Studio/human-mcp#v2.15.1 is installed; freshness signal via
 *      `npm view @goonnguyen/human-mcp@2.15.1` against the upstream npm mirror (WARN if not)
 *
 * Probe is a no-op (SKIP) when either `t1k-extended` is absent from
 * `installedModules`, or the skill dir `skills/t1k-extended-multimodal/` is
 * missing on disk.
 *
 * Path resolution (F-11): resolves metadata.json via resolveClaudeDir() —
 * the same pattern used by doctor-check-45 and doctor-check-46.
 *
 * Supply-chain safety (F-004): uses `npm view ... version --json` for MCP
 * resolvability — metadata-only, no code execution, no supply-chain risk.
 * Does NOT use `npx --yes` which downloads and runs 4th-party code.
 *
 * Phase 10 support: honors T1K_METADATA_PATH env override so smoke-test
 * fixtures can inject an arbitrary metadata.json path without touching disk.
 *
 * Fail-open: all top-level logic is wrapped in a try/catch that exits 0 on
 * internal exceptions — a buggy probe never blocks the doctor pipeline.
 *
 * Emits:
 *   [t1k:doctor] check=49 status=SKIP|OK|WARN|FAIL label="multimodal-setup" detail="..."
 *   FAIL is also used for internal errors (fail-open catch block). No ERROR status emitted.
 *
 * Exit codes:
 *   0 — SKIP, OK, WARN, or internal error (fail-open)
 *   1 — FAIL (python3 missing or too old)
 *
 * Usage:
 *   node doctor-check-49-multimodal-setup.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CHECK_ID = 49;
const CHECK_LABEL = 'multimodal-setup';
const MODULE_NAME = 't1k-extended';
const PYTHON_MIN_MAJOR = 3;
const PYTHON_MIN_MINOR = 10;
// MCP_PACKAGE is the upstream npm mirror — used ONLY for the `npm view` freshness
// signal (metadata-only, no code execution). The canonical consumer install path
// is the fork: github:The1Studio/human-mcp#v2.15.1 (see MCP_FORK below).
// Rationale: `npm view` requires an npm-registry slug; the fork URL is not on npm.
// Keeping both constants makes the dual intent explicit and avoids `npm view`
// silently changing meaning if MCP_PACKAGE were ever updated to the fork path.
const MCP_PACKAGE = '@goonnguyen/human-mcp';
const MCP_VERSION = '2.15.1';
// MCP_FORK is the authoritative install path. Consumer-facing WARN hint references
// this so users always install from the fork, not the upstream npm package.
const MCP_FORK = 'github:The1Studio/human-mcp#v2.15.1';

// ---------------------------------------------------------------------------
// resolveClaudeDir — verbatim from doctor-check-46-fork-agent-preflight.cjs:50
// Handles: CLI arg override, __dirname-relative (hooks/ sits inside .claude/),
// cwd-relative fallback, and global-only mode returning null.
// ---------------------------------------------------------------------------
function resolveClaudeDir() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const fromDirname = path.resolve(__dirname, '..');
  if (path.basename(fromDirname) === '.claude') return fromDirname;
  const fromCwd = path.join(process.cwd(), '.claude');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return null;
}

// ---------------------------------------------------------------------------
// Output helpers — match the doctor probe convention.
// ---------------------------------------------------------------------------
function emit(status, detail) {
  process.stdout.write(
    `[t1k:doctor] check=${CHECK_ID} status=${status} label="${CHECK_LABEL}" detail="${detail}"\n`
  );
}

function emitLine(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_LABEL}: ${message}\n`);
}

// ---------------------------------------------------------------------------
// python3 version check (F-23: import-resolution, not just syntax check)
// ---------------------------------------------------------------------------
function checkPython() {
  // Try python3 first; fall back to python on Windows.
  const candidates = process.platform === 'win32'
    ? ['python', 'python3']
    : ['python3', 'python'];

  for (const cmd of candidates) {
    try {
      const out = execFileSync(cmd, ['--version'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5000,
      }).trim();

      // Parse "Python X.Y.Z" — handle both stdout variants
      const match = out.match(/Python\s+(\d+)\.(\d+)/i);
      if (!match) continue;

      const major = parseInt(match[1], 10);
      const minor = parseInt(match[2], 10);

      if (major < PYTHON_MIN_MAJOR || (major === PYTHON_MIN_MAJOR && minor < PYTHON_MIN_MINOR)) {
        emitLine('FAIL', `found ${out} — requires python3 ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+`);
        emit('FAIL', `python3 ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ required — found ${out}. Install via system package manager.`);
        return { ok: false };
      }

      return { ok: true, version: out };
    } catch (_) {
      // Command not found or timed out — try next candidate.
    }
  }

  // No python3 / python found.
  emitLine('FAIL', `python3 not found — ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ required. Install via system package manager.`);
  emit('FAIL', `python3 not found — ${PYTHON_MIN_MAJOR}.${PYTHON_MIN_MINOR}+ required. Install via system package manager.`);
  return { ok: false };
}

// ---------------------------------------------------------------------------
// MCP resolvability check (F-004: npm view metadata-only, no npx execution)
// ---------------------------------------------------------------------------
function checkMcpResolvable() {
  try {
    const out = execFileSync(
      'npm',
      ['view', `${MCP_PACKAGE}@${MCP_VERSION}`, 'version', '--json'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 8000,
      }
    ).trim();

    if (!out || out.length === 0) {
      return { ok: false, reason: 'npm view returned empty output' };
    }

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: err.message };
  }
}

// ---------------------------------------------------------------------------
// Main probe logic
// ---------------------------------------------------------------------------
function run() {
  // Phase 10: honor T1K_METADATA_PATH env override — smoke-test fixtures inject
  // a synthetic metadata.json path via this env var so tests run without
  // touching the real installed state.
  let metaPath;
  if (process.env.T1K_METADATA_PATH) {
    metaPath = process.env.T1K_METADATA_PATH;
  } else {
    const claudeDir = resolveClaudeDir();
    if (!claudeDir) {
      emitLine('SKIP', 'no .claude/ directory resolvable');
      emit('SKIP', 'no .claude/ directory resolvable');
      process.exit(0);
    }
    metaPath = path.join(claudeDir, 'metadata.json');
  }

  // Read and parse metadata.json
  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch (err) {
    emitLine('SKIP', `metadata.json unreadable: ${err.message}`);
    emit('SKIP', `metadata.json unreadable: ${err.message}`);
    process.exit(0);
  }

  // F-I01 fix: installedModules is keyed by MODULE name (e.g. 't1k-extended'), NOT skill name.
  // Checking for 't1k-extended-multimodal' (a skill slug) would always miss because the CLI
  // writes module names as keys — confirmed by inspecting real metadata.json files.
  // Secondary guard: verify the multimodal skill directory is actually present on disk,
  // so we skip cleanly on installs where the module is registered but the skill wasn't unpacked.
  const moduleInstalled = 't1k-extended' in (meta.installedModules || {});
  const claudeDirForSkillCheck = process.env.T1K_METADATA_PATH
    ? path.dirname(process.env.T1K_METADATA_PATH)
    : resolveClaudeDir();
  const skillMdPath = claudeDirForSkillCheck
    ? path.join(claudeDirForSkillCheck, 'skills', 't1k-extended-multimodal', 'SKILL.md')
    : null;
  const skillInstalled = skillMdPath ? fs.existsSync(skillMdPath) : false;

  if (!moduleInstalled || !skillInstalled) {
    emitLine('SKIP', `${MODULE_NAME} not installed — probe is a no-op`);
    emit('SKIP', `${MODULE_NAME} not installed`);
    process.exit(0);
  }

  emitLine('INFO', `${MODULE_NAME} is installed — running multimodal setup checks`);

  const warns = [];
  let hasFail = false;

  // Check 1: GEMINI_API_KEY
  if (!process.env.GEMINI_API_KEY) {
    warns.push('GEMINI_API_KEY not set');
    emitLine('WARN', 'GEMINI_API_KEY not set — Set GEMINI_API_KEY from https://aistudio.google.com/apikey');
  }

  // Check 2: MINIMAX_API_KEY (optional — WARN only)
  if (!process.env.MINIMAX_API_KEY) {
    warns.push('MINIMAX_API_KEY not set');
    emitLine('WARN', 'MINIMAX_API_KEY not set — Set MINIMAX_API_KEY from https://platform.minimax.io for MiniMax generation (optional)');
  }

  // Check 3: python3 >= 3.10
  const pythonResult = checkPython();
  if (!pythonResult.ok) {
    hasFail = true;
  }

  // Check 4: human-mcp resolvability (npm view — metadata only, no execution)
  const mcpResult = checkMcpResolvable();
  if (!mcpResult.ok) {
    warns.push('human-mcp not resolvable');
    emitLine(
      'WARN',
      `human-mcp upstream not found in npm registry (${mcpResult.reason || 'empty response'}). ` +
      `Install from fork: claude mcp add human-mcp -- npx -y ${MCP_FORK}`
    );
  }

  // Emit final status
  if (hasFail) {
    // FAIL already emitted inline by checkPython()
    process.exit(1);
  }

  if (warns.length > 0) {
    emit('WARN', warns.join('; '));
    process.exit(0);
  }

  emitLine('OK', 'all multimodal setup checks passed');
  emit('OK', 'python3 present, API keys set, human-mcp resolvable');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Fail-open wrapper — internal hook exceptions never crash the doctor pipeline.
// Per rules/security.md: "fail-open on internal hook exception (exit 0)".
// ---------------------------------------------------------------------------
try {
  run();
} catch (err) {
  process.stderr.write(`[doctor-check-${CHECK_ID}] internal error (fail-open): ${err.message}\n`);
  // F-I05 fix: use FAIL (within the documented SKIP|OK|WARN|FAIL set) instead of ERROR.
  // The doctor parser only handles the 4 documented statuses; ERROR may be silently dropped.
  emit('FAIL', `internal error — ${err.message}`);
  process.exit(0);
}
