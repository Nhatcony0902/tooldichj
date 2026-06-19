#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * prompt-telemetry-flush.cjs — Stop hook: flush last prompt's outcome
 *
 * On session stop, sends the final prompt's outcome to the telemetry Worker.
 * Without this, the last prompt of every session would have no outcome data.
 * Cleans up session-scoped cache files.
 * Fail-open: never blocks session shutdown.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { T1K, isTelemetryEnabled, ensureTelemetryDir, findProjectRoot, warnOnce, readTelemetryContext, readTelemetryEndpoint, getGhToken, emitTelemetryEvent, countErrorsSince, readActivatedSkillsSince } = require('./telemetry-utils.cjs');

  if (!isTelemetryEnabled()) process.exit(0);

  const projectRoot = findProjectRoot();
  const endpoint = readTelemetryEndpoint(projectRoot);
  if (!endpoint) {
    warnOnce('flush-no-endpoint', 'Telemetry flush skipped: no endpoint configured');
    process.exit(0);
  }

  const telemetryDir = ensureTelemetryDir();
  const statePath = path.join(telemetryDir, T1K.STATE_FILE);

  // Read static telemetry context so flush rows aren't null
  const { project, kit, hookVersion, cliVersion, installedModules, installedKits, gitBranch } = readTelemetryContext(projectRoot);

  // Read last prompt state
  if (!fs.existsSync(statePath)) process.exit(0);
  let prev;
  try { prev = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch { process.exit(0); }
  if (!prev.sessionId || !prev.ts) process.exit(0);

  // Get GitHub token
  const ghToken = getGhToken(telemetryDir);
  if (!ghToken) {
    warnOnce('flush-no-gh', 'Telemetry flush skipped: gh CLI not available');
    process.exit(0);
  }

  // Compute outcome
  const prevTs = new Date(prev.ts).getTime();
  const durationSec = Math.round((Date.now() - prevTs) / 1000);
  const errorCount = countErrorsSince(telemetryDir, prevTs);
  const outcome = errorCount > 0 ? 'error' : 'success';
  const activatedSkills = readActivatedSkillsSince(telemetryDir, prevTs);

  // Read the context snapshot for the real Claude Code session (written by statusline.cjs).
  // After the session-id fix, prev.sessionId IS Claude Code's real session_id, so the
  // context file t1k-context-{sessionId}.json is addressable here too. This lets flush
  // rows carry the same model/context fields as normal prompt rows — consistent data shape
  // across all rows in a session.
  let model = null;
  let contextTokens = null;
  let contextSize = null;
  let usageInputTokens = null, usageOutputTokens = null;
  let usageCacheCreationTokens = null, usageCacheReadTokens = null;
  let rateLimit5hPercent = null, rateLimit7dPercent = null;
  let linesAdded = null, linesRemoved = null;
  let claudeEmail = null, claudeOrgId = null, subscriptionType = null;
  try {
    const ctxPath = path.join(os.tmpdir(), `t1k-context-${prev.sessionId}.json`);
    if (fs.existsSync(ctxPath)) {
      const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
      if (typeof ctx.tokens === 'number') contextTokens = ctx.tokens;
      if (typeof ctx.size === 'number') contextSize = ctx.size;
      if (typeof ctx.modelId === 'string') model = ctx.modelId;
      else if (typeof ctx.modelName === 'string') model = ctx.modelName;
      // Per-request token breakdown
      const u = ctx.usage;
      if (u) {
        if (typeof u.input_tokens === 'number') usageInputTokens = u.input_tokens;
        if (typeof u.output_tokens === 'number') usageOutputTokens = u.output_tokens;
        if (typeof u.cache_creation_input_tokens === 'number') usageCacheCreationTokens = u.cache_creation_input_tokens;
        if (typeof u.cache_read_input_tokens === 'number') usageCacheReadTokens = u.cache_read_input_tokens;
      }
      // Rate limits + productivity + account
      if (ctx.rateLimits) {
        if (typeof ctx.rateLimits.fiveHourPercent === 'number') rateLimit5hPercent = ctx.rateLimits.fiveHourPercent;
        if (typeof ctx.rateLimits.sevenDayPercent === 'number') rateLimit7dPercent = ctx.rateLimits.sevenDayPercent;
      }
      if (typeof ctx.linesAdded === 'number') linesAdded = ctx.linesAdded;
      if (typeof ctx.linesRemoved === 'number') linesRemoved = ctx.linesRemoved;
      if (typeof ctx.claudeEmail === 'string') claudeEmail = ctx.claudeEmail;
      if (typeof ctx.claudeOrgId === 'string') claudeOrgId = ctx.claudeOrgId;
      if (typeof ctx.subscriptionType === 'string') subscriptionType = ctx.subscriptionType;
    }
  } catch { /* fail-open */ }

  // Rough token estimate for the placeholder prompt — keeps prompt_tokens non-null for
  // flush rows so aggregate queries (avg/median/max over prompt_tokens) don't skew.
  const FLUSH_PROMPT = '[session-end-flush]';
  const flushPromptTokens = Math.round(FLUSH_PROMPT.split(/\s+/).length * 1.3);

  // Send flush payload (reuses /ingest with flushOutcome flag)
  const payload = {
    ts: new Date().toISOString(),
    sessionId: prev.sessionId,
    prompt: FLUSH_PROMPT,
    promptTokens: flushPromptTokens,
    project,
    kit,
    installedModules,
    installedKits,
    osPlatform: process.platform,
    nodeVersion: process.version,
    hookVersion,
    cliVersion,
    isSlashCommand: false,
    sessionPromptIndex: prev.promptIndex || 0,
    ...(gitBranch && { gitBranch }),
    ...(model && { model }),
    ...(contextTokens != null && { contextTokens }),
    ...(contextSize != null && { contextSize }),
    ...(usageInputTokens != null && { usageInputTokens }),
    ...(usageOutputTokens != null && { usageOutputTokens }),
    ...(usageCacheCreationTokens != null && { usageCacheCreationTokens }),
    ...(usageCacheReadTokens != null && { usageCacheReadTokens }),
    ...(rateLimit5hPercent != null && { rateLimit5hPercent }),
    ...(rateLimit7dPercent != null && { rateLimit7dPercent }),
    ...(linesAdded != null && { linesAdded }),
    ...(linesRemoved != null && { linesRemoved }),
    ...(claudeEmail && { claudeEmail }),
    ...(claudeOrgId && { claudeOrgId }),
    ...(subscriptionType && { subscriptionType }),
    classifiedAs: 'flush',
    prevSessionId: prev.sessionId,
    prevOutcome: outcome,
    prevErrorType: errorCount > 0 ? 'runtime' : null,
    prevErrorCount: errorCount,
    prevDurationSec: durationSec,
    prevActivatedSkills: activatedSkills.length > 0 ? activatedSkills : undefined,
    prevToolsUsed: prev.toolsUsed?.length > 0 ? prev.toolsUsed : undefined,
    prevSubagentsSpawned: prev.subagentsSpawned > 0 ? prev.subagentsSpawned : undefined,
  };

  // SSOT transport: emitTelemetryEvent owns endpoint/auth/timeout/fail-open.
  // endpoint + ghToken are passed pre-resolved (already computed above for the
  // skip-guards) so we don't re-resolve them.
  emitTelemetryEvent(payload, { endpoint, ghToken })
    .finally(() => {
      // Clean up turn-scoped files only. Do NOT unlink statePath — flush runs at every
      // Stop event (end of every AI turn), but the state file must persist across turns
      // to track sessionPromptIndex and enable cross-turn piggyback. Stale state from a
      // previous Claude Code session is guarded in prompt-telemetry.cjs by a sessionId
      // match check when reading the file.
      try { fs.unlinkSync(path.join(telemetryDir, T1K.GH_TOKEN_CACHE)); } catch { /* ok */ }
      // Clean up per-session warning markers
      try {
        for (const f of fs.readdirSync(telemetryDir)) {
          if (f.startsWith('.warned-')) {
            fs.unlinkSync(path.join(telemetryDir, f));
          }
        }
      } catch { /* ok */ }
      process.exit(0);
    });

  setTimeout(() => process.exit(0), 4000);
} catch {
  process.exit(0); // Fail-open
}
