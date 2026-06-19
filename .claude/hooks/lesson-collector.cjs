#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * lesson-collector.cjs — Stop hook: parse AI-emitted lesson/skill-bug markers.
 *
 * Pipeline:
 *   opt-out guard → feature flag → parse last AI turn →
 *   extract [t1k:lesson ...] / [t1k:skill-bug ...] markers (strict regex) →
 *   sanitize → fingerprint + 7-day TTL dedup → rate-limit (5/session) →
 *   append to .claude/telemetry/pending-skill-updates.jsonl →
 *   emit [t1k:lesson-queued count=N] to stdout
 *
 * Reuses (no duplicate utilities):
 *   - sanitize helpers from lib/kit-error-sanitizer.cjs (content sanitizer — SSOT)
 *   - fingerprint()/checkAndRecord() from lib/kit-error-dedup.cjs (16-char md5 + TTL)
 *     with a dedicated cache at $HOME/.claude/.lesson-fingerprints.json via env override
 *   - readFeatureFlag(), resolveClaudeDir() from telemetry-utils.cjs
 *
 * Fail-open: any exception → process.exit(0), never block the user.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

const {
  parseHookStdin,
  isTelemetryEnabled,
  ensureTelemetryDir,
  findProjectRoot,
  resolveClaudeDir,
  readFeatureFlag,
  isTeammateContext,
  computeTeammateSessionKey,
  teammateQueuePath,
  drainTeammateQueues,
  T1K,
} = require('./telemetry-utils.cjs');

const { safeResolve, SafePathError } = require('./lib/safe-paths.cjs');

const { logHook, createHookTimer } = require('./hook-logger.cjs');
const sanitizer = require('./lib/kit-error-sanitizer.cjs');

// ── Constants (data-driven config overrides) ──
const CACHE_FILENAME = '.lesson-fingerprints.json';
const SYNC_LOG_FILENAME = '.lesson-sync.log';
const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const RATE_DIR_NAME = 't1k-lesson-sync';
const FEATURE_FLAG = 'autoLessonSync';
const ENV_OPT_IN = 'T1K_AUTO_LESSON_SYNC';

// Strict marker regex — all attributes required, each value quoted.
//   [t1k:lesson    kit="..." skill="..." fragment="..." reason="..."]
//   [t1k:skill-bug kit="..." skill="..." bug="..."      evidence="..."]
//   [t1k:mcp-gap   kit="..." tool="..."  gap="..."      evidence="..."]
// Values use ([^"]*) to disallow unescaped quotes and avoid catastrophic backtracking.
const LESSON_RE   = /\[t1k:lesson\s+kit="([^"]+)"\s+skill="([^"]+)"\s+fragment="([^"]+)"\s+reason="([^"]*)"\s*\]/g;
const SKILL_BUG_RE = /\[t1k:skill-bug\s+kit="([^"]+)"\s+skill="([^"]+)"\s+bug="([^"]+)"\s+evidence="([^"]*)"\s*\]/g;
const MCP_GAP_RE   = /\[t1k:mcp-gap\s+kit="([^"]+)"\s+tool="([^"]+)"\s+gap="([^"]+)"\s+evidence="([^"]*)"\s*\]/g;

/**
 * Read the autoLessonSync config block (feature flag + limits) from any
 * t1k-config-*.json fragment in claudeDir. Uses readFeatureFlag() for flag
 * semantics (opt-out wins). Limits come from any fragment that defines them
 * (later fragments win); missing fields fall back to defaults.
 */
function readAutoLessonConfig(claudeDir) {
  const defaults = {
    enabled: false,
    maxPerSession: 5,
    dedupeTTLDays: 7,
    dryRunEnv: 'T1K_LESSON_SYNC_DRY_RUN',
  };
  // Env-var kill switch (symmetric):
  //   T1K_AUTO_LESSON_SYNC=1 or =true  → force-ENABLE (overrides config default of false)
  //   T1K_AUTO_LESSON_SYNC=0 or =false → force-DISABLE (overrides even a config-enabled flag)
  //   unset                            → fall through to config flag (readFeatureFlag)
  // This lets kit maintainers enable per-shell (e.g. .envrc/direnv) AND lets CI/consumers
  // explicitly suppress the pipeline even if a fragment enables it.
  const envValue = process.env[ENV_OPT_IN];
  const envForceEnable = envValue === '1' || envValue === 'true';
  const envForceDisable = envValue === '0' || envValue === 'false' || envValue === '';
  let enabled;
  if (envForceDisable) {
    enabled = false;
  } else if (envForceEnable) {
    enabled = true;
  } else {
    enabled = readFeatureFlag(claudeDir, FEATURE_FLAG, defaults.enabled);
  }
  const result = { ...defaults, enabled };
  try {
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const f of files) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        if (cfg.autoLessonSync && typeof cfg.autoLessonSync === 'object') {
          if (typeof cfg.autoLessonSync.maxPerSession === 'number') {
            result.maxPerSession = cfg.autoLessonSync.maxPerSession;
          }
          if (typeof cfg.autoLessonSync.dedupeTTLDays === 'number') {
            result.dedupeTTLDays = cfg.autoLessonSync.dedupeTTLDays;
          }
          if (typeof cfg.autoLessonSync.dryRunEnv === 'string') {
            result.dryRunEnv = cfg.autoLessonSync.dryRunEnv;
          }
        }
      } catch { /* skip malformed fragment */ }
    }
  } catch { /* no claudeDir */ }
  return result;
}

/**
 * Scan text for lesson + skill-bug markers. Returns array of:
 *   { type: 'lesson'|'skill-bug', kit, skill, payload: {...}, primary: string }
 * where `primary` is the most identifying attribute for fingerprinting
 * (fragment for lesson, bug for skill-bug).
 */
function parseMarkers(text) {
  const out = [];
  if (typeof text !== 'string' || !text) return out;

  LESSON_RE.lastIndex = 0;
  let m;
  while ((m = LESSON_RE.exec(text)) !== null) {
    out.push({
      type: 'lesson',
      kit: m[1],
      skill: m[2],
      payload: { fragment: m[3], reason: m[4] },
      primary: m[3],
    });
  }

  SKILL_BUG_RE.lastIndex = 0;
  while ((m = SKILL_BUG_RE.exec(text)) !== null) {
    out.push({
      type: 'skill-bug',
      kit: m[1],
      skill: m[2],
      payload: { bug: m[3], evidence: m[4] },
      primary: m[3],
    });
  }

  // mcp-gap markers route to /t1k:issue against the MCP fork repo (resolved
  // by the queue processor via the kit's t1k-config-{kit}.json mcp.required
  // entry). We carry kit + tool here; processor adds repo from config.
  MCP_GAP_RE.lastIndex = 0;
  while ((m = MCP_GAP_RE.exec(text)) !== null) {
    out.push({
      type: 'mcp-gap',
      kit: m[1],
      // Reuse `skill` slot for the MCP tool name so the queue schema stays
      // flat — processor formats the reminder as "tool=..." for this type.
      skill: m[2],
      payload: { gap: m[3], evidence: m[4] },
      primary: m[3],
    });
  }

  return out;
}

/**
 * Sanitize text: strip secrets, env vars, user paths. Marker syntax is
 * preserved — the strip helpers only touch token shapes and absolute paths.
 */
function sanitizeMarkerText(text, cwd, home) {
  let out = text;
  out = sanitizer._stripUserPaths(out, home, cwd);
  out = sanitizer._stripEnvVars(out);
  out = sanitizer._stripSecrets(out);
  out = sanitizer._stripSensitiveFilePaths(out);
  return out;
}

/** Stable session id — mirrors auto-issue collector logic. */
function computeSessionId() {
  return process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('md5')
      .update((process.env.CLAUDE_PROJECT_DIR || findProjectRoot()) + new Date().toISOString().slice(0, 10))
      .digest('hex').slice(0, 16);
}

/** $HOME/.claude — cross-platform global dir for runtime artifacts. */
function defaultGlobalClaudeDir() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  return path.join(home, T1K.CLAUDE_DIR);
}

/**
 * Stop hook stdin shape (Claude Code):
 *   { transcript_path, stop_hook_active, stop_reason, cwd, ... }
 * Extract the last assistant turn text by parsing the transcript JSONL.
 * Falls back to explicit text fields on the payload (used by tests).
 */
function extractLastAiTurn(hookData) {
  if (!hookData || typeof hookData !== 'object') return '';

  const rawTranscriptPath = hookData.transcript_path;
  // Defense-in-depth: safeResolve verifies the path (including symlink realpath check)
  // is under a recognized harness root before we read it. Fail-open on rejection —
  // worst case is we miss lesson markers for this turn, not a hook crash.
  let transcriptPath = rawTranscriptPath;
  if (rawTranscriptPath) {
    try {
      transcriptPath = safeResolve(rawTranscriptPath, [os.tmpdir(), os.homedir()]);
    } catch (e) {
      if (e instanceof SafePathError) {
        transcriptPath = null; // skip — path did not pass safety check
      } else {
        throw e;
      }
    }
  }
  if (transcriptPath && fs.existsSync(transcriptPath)) {
    try {
      const raw = fs.readFileSync(transcriptPath, 'utf8');
      const lines = raw.trim().split('\n');
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i];
        if (!line) continue;
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (!entry || (entry.type !== 'assistant' && entry.role !== 'assistant')) continue;
        const text = extractTextFromEntry(entry);
        if (text) return text;
      }
    } catch { /* fall through to fallback */ }
  }

  if (typeof hookData.text === 'string') return hookData.text;
  if (typeof hookData.last_turn === 'string') return hookData.last_turn;
  return '';
}

/** Extract concatenated text from an assistant transcript entry. */
function extractTextFromEntry(entry) {
  const parts = [];
  const candidates = [entry.message, entry, entry.delta];
  for (const c of candidates) {
    if (!c) continue;
    const content = c.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

/**
 * Stage parsed teammate markers to a per-agent JSONL file under tmpdir.
 *
 * Teammate (SubagentStop) context only — bypasses dedup, rate-limit, and the
 * canonical queue. The parent's Stop hook drains these files and runs them
 * through the full pipeline so dedup state stays centralized in $HOME/.claude.
 *
 * Resolves issue #272: markers emitted by teammates were silently dropped
 * because lesson-collector only fired at Stop (main agent). Now wired to
 * SubagentStop too — teammates stage, parent merges.
 *
 * @param {object[]} markers from parseMarkers()
 * @param {object} hookData parsed SubagentStop payload
 * @returns {number} 0 (fail-open)
 */
function stageTeammateMarkers(markers, hookData) {
  const sessionKey = computeTeammateSessionKey();
  const agentName = (hookData && typeof hookData.agent_type === 'string' && hookData.agent_type)
    || process.env.CLAUDE_TEAM_NAME
    || `subagent-${process.pid}`;
  const queueFile = teammateQueuePath(sessionKey, agentName);
  let staged = 0;
  for (const marker of markers) {
    try {
      fs.appendFileSync(queueFile, JSON.stringify(marker) + '\n');
      staged++;
    } catch { /* fail-open — best-effort staging */ }
  }
  if (staged > 0) {
    console.log(
      `[t1k:lesson-teammate-staged] count=${staged} agent=${agentName} sessionKey=${sessionKey}`
    );
  }
  return 0;
}

function main() {
  try {
    if (!isTelemetryEnabled()) return 0;

    const resolved = resolveClaudeDir();
    if (!resolved) return 0;
    const claudeDir = resolved.claudeDir;

    const cfg = readAutoLessonConfig(claudeDir);
    const hookData = parseHookStdin() || {};
    const isTeammate = isTeammateContext(hookData);

    // ── Teammate (SubagentStop) branch (#272) ──
    // Stage markers from THIS teammate's transcript to /tmp; parent's Stop hook
    // drains + merges via drainTeammateQueues(). We bypass the feature-flag
    // gate here intentionally: the parent will apply the flag uniformly on the
    // merged set, and unconditional staging keeps the temp files self-healing
    // (parent always cleans up, regardless of flag state).
    if (isTeammate) {
      const lastTurnText = extractLastAiTurn(hookData);
      if (!lastTurnText) return 0;
      const home = os.homedir() || '';
      const cwd = process.cwd();
      const scrubbed = sanitizeMarkerText(lastTurnText, cwd, home);
      const markers = parseMarkers(scrubbed);
      if (markers.length === 0) return 0;
      return stageTeammateMarkers(markers, hookData);
    }

    if (!cfg.enabled) {
      // One-time per-session hint: parse for markers WITHOUT writing to queue.
      // Only fires when markers exist but the feature is OFF — never adds noise.
      // Drain teammate queues here too so the count is accurate AND the temp
      // files don't accumulate forever when the feature is OFF.
      const lastTurnText = extractLastAiTurn(hookData);
      const mainMarkers = lastTurnText ? parseMarkers(lastTurnText) : [];
      const sessionKey = computeTeammateSessionKey();
      const { markers: teammateMarkers, files: teammateFiles } = drainTeammateQueues(sessionKey);
      // Clean up drained temp files even when feature is OFF (avoid accumulation)
      for (const f of teammateFiles) {
        try { fs.unlinkSync(f); } catch { /* best-effort */ }
      }
      const totalCount = mainMarkers.length + teammateMarkers.length;
      if (totalCount > 0) {
        const hintKey = path.join(os.tmpdir(), `t1k-lesson-hint-${computeSessionId()}.flag`);
        if (!fs.existsSync(hintKey)) {
          try { fs.writeFileSync(hintKey, '1'); } catch { /* ok */ }
          console.log(
            `[t1k:lesson-hint] ${totalCount} marker(s) detected but autoLessonSync is OFF. ` +
            `Set T1K_AUTO_LESSON_SYNC=1 or features.autoLessonSync: true in t1k-config-*.json to enable.`
          );
        }
      }
      return 0;
    }

    const timer = createHookTimer('lesson-collector');

    const lastTurnText = extractLastAiTurn(hookData);
    const home = os.homedir() || '';
    const cwd = process.cwd();
    const mainMarkers = lastTurnText
      ? parseMarkers(sanitizeMarkerText(lastTurnText, cwd, home))
      : [];

    // Drain teammate-staged markers (from SubagentStop runs earlier in the
    // session) and merge with main markers. Teammate markers were already
    // sanitized at stage-time, but re-sanitizing here is idempotent and
    // defends against staged-then-restored markers from older sessions.
    const sessionKey = computeTeammateSessionKey();
    const { markers: rawTeammateMarkers, files: teammateFiles } = drainTeammateQueues(sessionKey);
    const teammateMarkers = rawTeammateMarkers.map(m => {
      // Sanitize the primary + payload fields the dedup/issue pipeline reads.
      const sanitized = { ...m, payload: { ...m.payload } };
      if (typeof sanitized.primary === 'string') {
        sanitized.primary = sanitizeMarkerText(sanitized.primary, cwd, home);
      }
      for (const k of Object.keys(sanitized.payload)) {
        if (typeof sanitized.payload[k] === 'string') {
          sanitized.payload[k] = sanitizeMarkerText(sanitized.payload[k], cwd, home);
        }
      }
      return sanitized;
    });

    const markers = mainMarkers.concat(teammateMarkers);
    if (markers.length === 0) {
      // Still clean up any drained-but-empty files
      for (const f of teammateFiles) {
        try { fs.unlinkSync(f); } catch { /* ok */ }
      }
      timer.end({ outcome: 'skip', note: 'no-markers' });
      return 0;
    }

    // Use a lesson-scoped fingerprint cache via env override. The dedup module
    // reads T1K_KIT_ERROR_CACHE_PATH dynamically on every call, so setting it
    // here directs reads/writes to $HOME/.claude/.lesson-fingerprints.json.
    // T1K_LESSON_CACHE_PATH is a test-only override; when set, it replaces the
    // global default so subprocess tests can isolate dedup state.
    // safeResolve validates env-var-supplied paths against allowed roots (home + tmpdir)
    // to prevent .envrc-injected path traversal or symlink escape (R1 P2).
    const rawLessonCachePath = process.env.T1K_LESSON_CACHE_PATH;
    let cachePath;
    if (rawLessonCachePath) {
      try {
        cachePath = safeResolve(rawLessonCachePath, [os.homedir(), os.tmpdir()]);
      } catch {
        cachePath = path.join(defaultGlobalClaudeDir(), CACHE_FILENAME); // fall back to default
      }
    } else {
      cachePath = path.join(defaultGlobalClaudeDir(), CACHE_FILENAME);
    }
    const prevCacheEnv = process.env.T1K_KIT_ERROR_CACHE_PATH;
    process.env.T1K_KIT_ERROR_CACHE_PATH = cachePath;
    const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

    const telemetryDir = ensureTelemetryDir();
    const queuePath = path.join(telemetryDir, QUEUE_FILENAME);
    const sessionId = computeSessionId();
    const rateDir = path.join(os.tmpdir(), RATE_DIR_NAME);
    if (!fs.existsSync(rateDir)) {
      try { fs.mkdirSync(rateDir, { recursive: true }); } catch { /* ok */ }
    }
    const counterFile = path.join(rateDir, `${sessionId}.count`);
    let sessionCount = 0;
    try {
      if (fs.existsSync(counterFile)) {
        sessionCount = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
      }
    } catch { /* ok */ }

    const isDryRun = process.env[cfg.dryRunEnv] === '1';
    let queuedThisRun = 0;
    let droppedDuplicate = 0;
    let droppedRateLimit = 0;
    const nowIso = new Date().toISOString();

    for (const marker of markers) {
      if (sessionCount + queuedThisRun >= cfg.maxPerSession) {
        droppedRateLimit++;
        logHook('lesson-collector', { drop: 'rate-limited', type: marker.type, kit: marker.kit });
        continue;
      }

      const fp = fingerprint(
        { tool: 'lesson', cmd: marker.type, stderrHead: marker.primary },
        { reason: marker.type, originKit: marker.kit }
      );
      const dedup = checkAndRecord(fp, {
        reason: marker.type,
        originKit: marker.kit,
        maxAgeDays: cfg.dedupeTTLDays,
      });

      if (dedup.isDuplicate) {
        droppedDuplicate++;
        logHook('lesson-collector', { drop: 'duplicate', type: marker.type, fp });
        continue;
      }

      const entry = {
        ts: nowIso,
        type: marker.type,
        fingerprint: fp,
        kit: marker.kit,
        skill: marker.skill,
        payload: marker.payload,
        sessionId,
        dryRun: isDryRun,
        submitted: false,
        submittedAt: null,
        prUrl: null,
        issueUrl: null,
      };

      try { fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }

      if (isDryRun) {
        try {
          const logPath = path.join(defaultGlobalClaudeDir(), SYNC_LOG_FILENAME);
          const logDir = path.dirname(logPath);
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          fs.appendFileSync(
            logPath,
            `[${nowIso}] DRY_RUN fp=${fp} type=${marker.type} kit=${marker.kit} skill=${marker.skill}\n`
          );
        } catch { /* ok */ }
      }

      queuedThisRun++;
    }

    if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
    else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;

    if (queuedThisRun > 0) {
      try { fs.writeFileSync(counterFile, String(sessionCount + queuedThisRun)); } catch { /* ok */ }
      const dryTag = isDryRun ? ' dryRun=1' : '';
      console.log(
        `[t1k:lesson-queued] count=${queuedThisRun} total=${sessionCount + queuedThisRun}/${cfg.maxPerSession}${dryTag}`
      );

      // End-of-session flush (issue #334): spawn a detached fire-and-forget
      // runner that files skill-bug / mcp-gap entries via `gh` directly so
      // queued markers don't sit unprocessed when no subsequent UserPromptSubmit
      // fires (single-shot CLI, end-of-day close, automated batch). Lesson
      // markers (PR drafting) still flow through the AI sync-back path on the
      // next session — that requires reasoning the runner can't do.
      // Skipped under dry-run. Inherits CWD for repo resolution.
      if (!isDryRun) {
        try {
          const runner = path.join(__dirname, 'lib', 'lesson-flush-runner.cjs');
          const child = spawn(process.execPath, [runner, queuePath], {
            detached: true,
            stdio: 'ignore',
            windowsHide: true,
          });
          child.unref();
        } catch { /* fail-open — runner is best-effort */ }
      }
    }

    // Clean up drained teammate queue files now that markers have flowed
    // through the canonical pipeline (queued / deduped / rate-limited — all
    // outcomes are terminal for these markers). Best-effort: leftover files
    // are harmless and will be drained again on the next session.
    for (const f of teammateFiles) {
      try { fs.unlinkSync(f); } catch { /* ok */ }
    }

    logHook('lesson-collector', {
      queued: queuedThisRun,
      duplicate: droppedDuplicate,
      rateLimited: droppedRateLimit,
      teammateMerged: teammateMarkers.length,
      teammateFiles: teammateFiles.length,
      dryRun: isDryRun,
    });
    timer.end({ outcome: 'ok' });
    return 0;
  } catch (e) {
    if (process.env.T1K_DEBUG_LESSON === '1') {
      try { process.stderr.write(`[lesson-collector:debug] ${e && e.stack || e}\n`); } catch {}
    }
    return 0; // fail-open
  }
}

// Spawned as a hook: run main and exit. Required as a module: just export.
if (require.main === module) {
  process.exit(main());
}

module.exports = {
  LESSON_RE,
  SKILL_BUG_RE,
  MCP_GAP_RE,
  parseMarkers,
  readAutoLessonConfig,
  sanitizeMarkerText,
  computeSessionId,
  extractLastAiTurn,
  stageTeammateMarkers,
  main,
};
