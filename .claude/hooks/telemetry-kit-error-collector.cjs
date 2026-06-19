#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * telemetry-kit-error-collector.cjs — PostToolUse hook: auto-detect T1K kit errors.
 *
 * Pipeline:
 *   opt-out guards → error detection → classifier → sanitizer → dedup →
 *   rate-limit → append JSONL → (dry-run OR emit [t1k:auto-issue] marker)
 *
 * Does NOT call the Task tool directly (hooks are subprocesses). Instead,
 * it writes a pending submission request to
 *   .claude/telemetry/pending-issue-submissions.jsonl
 * and emits a [t1k:auto-issue] marker. A rule tells the assistant to read
 * the marker at its next turn and spawn a background /t1k:issue sub-agent.
 *
 * Fail-open: any exception → process.exit(0), never block the user.
 */
'use strict';

try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');

  const {
    parseHookStdin,
    isTelemetryEnabled,
    ensureTelemetryDir,
    todayDateStr,
    findProjectRoot,
    T1K,
  } = require('./telemetry-utils.cjs');

  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  const { isKitError } = require('./lib/kit-error-classifier.cjs');
  const { sanitize } = require('./lib/kit-error-sanitizer.cjs');
  const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

  // ── guard 1: global telemetry opt-out ──
  if (!isTelemetryEnabled()) process.exit(0);

  // ── guard 2: autoIssueSubmission feature flag + config ──
  // Reads config fragments for both the kill-switch and the limits section.
  function readAutoIssueConfig() {
    const defaults = { enabled: false, maxPerSession: 5, dedupeTTLDays: 7, dryRunEnv: 'T1K_AUTO_ISSUE_DRY_RUN', submitThreshold: 1 };
    try {
      const root = findProjectRoot();
      const claudeDir = path.join(root, '.claude');
      if (!fs.existsSync(claudeDir)) return defaults;
      const result = { ...defaults };
      for (const f of fs.readdirSync(claudeDir)) {
        if (!f.startsWith(T1K.CONFIG_PREFIX) || !f.endsWith('.json')) continue;
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
          if (cfg.features && cfg.features.autoIssueSubmission === true) result.enabled = true;
          if (cfg.autoIssueSubmission && typeof cfg.autoIssueSubmission === 'object') {
            if (typeof cfg.autoIssueSubmission.maxPerSession === 'number') {
              result.maxPerSession = cfg.autoIssueSubmission.maxPerSession;
            }
            if (typeof cfg.autoIssueSubmission.dedupeTTLDays === 'number') {
              result.dedupeTTLDays = cfg.autoIssueSubmission.dedupeTTLDays;
            }
            if (typeof cfg.autoIssueSubmission.dryRunEnv === 'string') {
              result.dryRunEnv = cfg.autoIssueSubmission.dryRunEnv;
            }
            if (typeof cfg.autoIssueSubmission.submitThreshold === 'number') {
              result.submitThreshold = cfg.autoIssueSubmission.submitThreshold;
            }
          }
        } catch {}
      }
      return result;
    } catch {
      return defaults;
    }
  }

  const autoIssueConfig = readAutoIssueConfig();
  if (!autoIssueConfig.enabled) process.exit(0);

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const toolName = hookData.tool_name;
  const toolInput = hookData.tool_input || {};
  const toolResult = hookData.tool_result;

  if (!toolName) process.exit(0);
  const timer = createHookTimer('telemetry-kit-error-collector', { tool: toolName });

  // ── guard 3: detect error signal ──
  const resultStr = typeof toolResult === 'string' ? toolResult :
    (toolResult ? (() => { try { return JSON.stringify(toolResult); } catch { return ''; } })() : '');

  const hasExitCode = /exit code [1-9]\d*/i.test(resultStr) || /Exit code:\s*[1-9]\d*/i.test(resultStr);
  const hasStrongError = /^(TypeError|SyntaxError|ReferenceError|ENOENT|FATAL ERROR):/m.test(resultStr) ||
    resultStr.includes('command not found') ||
    resultStr.includes('Permission denied') ||
    resultStr.includes('MODULE_NOT_FOUND') ||
    /npm ERR!/.test(resultStr);
  const hasTaskBlocked = toolName === 'Task' && /Status:\s*BLOCKED/.test(resultStr);
  const hasSkillError = toolName === 'Skill' &&
    (resultStr.includes('"isError":true') || resultStr.includes("'isError': true"));
  const hasToolUseError = /tool_use_error|Invalid tool parameters/i.test(resultStr);

  if (!hasExitCode && !hasStrongError && !hasTaskBlocked && !hasSkillError && !hasToolUseError) {
    process.exit(0);
  }

  // ── classify ──
  const classification = isKitError({
    toolName,
    toolInput,
    toolResult: resultStr,
    projectRoot: findProjectRoot(),
  });

  if (!classification.isKit) process.exit(0);

  // ── sanitize ──
  const sanitized = sanitize({
    toolName,
    toolInput,
    toolResult: resultStr,
    cwd: process.cwd(),
    home: os.homedir() || '',
  });

  // ── fingerprint + dedup (TTL from config) ──
  const fp = fingerprint(sanitized, classification);
  const dedup = checkAndRecord(fp, {
    reason: classification.reason,
    originKit: classification.originKit,
    maxAgeDays: autoIssueConfig.dedupeTTLDays,
  });

  // ── rate limit (session-scoped, data-driven from config) ──
  const MAX_PER_SESSION = autoIssueConfig.maxPerSession;
  const sessionId = process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('md5')
      .update((process.env.CLAUDE_PROJECT_DIR || '') + new Date().toISOString().slice(0, 10))
      .digest('hex').slice(0, 16);
  const rateDir = path.join(os.tmpdir(), 't1k-auto-issue');
  if (!fs.existsSync(rateDir)) {
    try { fs.mkdirSync(rateDir, { recursive: true }); } catch {}
  }
  const counterFile = path.join(rateDir, `${sessionId}.count`);
  let sessionCount = 0;
  try {
    if (fs.existsSync(counterFile)) {
      sessionCount = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
    }
  } catch {}

  // ── append JSONL telemetry record ──
  const telemetryDir = ensureTelemetryDir();
  const jsonlPath = path.join(telemetryDir, `kit-errors-${todayDateStr()}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    fingerprint: fp,
    reason: classification.reason,
    origin: {
      kit: classification.originKit,
      repo: classification.originRepo,
      module: classification.originModule,
    },
    sanitized,
    isDuplicate: dedup.isDuplicate,
    submittedBefore: dedup.submittedBefore,
    count: dedup.count,
    submitted: false,
    skipReason: null,
  };

  // Duplicate handling.
  //
  // Local dedup must suppress duplicate *upstream calls* (post-submission),
  // NOT duplicate *escalation attempts when nothing has been submitted yet*.
  // Skip only when:
  //   - submittedBefore: we already filed it upstream → 'already-submitted', OR
  //   - count < submitThreshold: not enough signal yet → 'below-threshold'.
  // Otherwise (submittedBefore === false AND count >= submitThreshold) the
  // FIRST upstream submission must proceed even though the fingerprint is a
  // local-cache duplicate (the cache proves prior occurrence, not prior
  // upstream call). See theonekit-core#385.
  if (dedup.isDuplicate) {
    if (dedup.submittedBefore) {
      entry.skipReason = 'already-submitted';
      try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch {}
      process.exit(0);
    }
    if (dedup.count < autoIssueConfig.submitThreshold) {
      entry.skipReason = 'below-threshold';
      try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch {}
      process.exit(0);
    }
    // Fall through: never submitted upstream + enough signal → escalate.
  }

  // Rate limited → log and skip submission
  if (sessionCount >= MAX_PER_SESSION) {
    entry.skipReason = 'rate-limited';
    try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch {}
    process.exit(0);
  }

  // ── dry run (env var name from config) ──
  if (process.env[autoIssueConfig.dryRunEnv] === '1') {
    entry.skipReason = 'dry-run';
    try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch {}
    try {
      const logPath = path.join(os.homedir() || os.tmpdir(), '.claude', '.auto-issue.log');
      const logDir = path.dirname(logPath);
      if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
      fs.appendFileSync(logPath,
        `[${entry.ts}] DRY_RUN fp=${fp} reason=${classification.reason} ` +
        `kit=${classification.originKit || '?'} tool=${toolName}\n`);
    } catch {}
    process.exit(0);
  }

  // ── real submission path: write pending request + emit marker ──
  entry.submitted = false; // will be flipped once the sub-agent confirms

  // Append telemetry record
  try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch {}

  // Append pending submission request (assistant will consume this)
  const pendingPath = path.join(telemetryDir, 'pending-issue-submissions.jsonl');
  const submissionRequest = {
    ts: entry.ts,
    fingerprint: fp,
    origin: entry.origin,
    affectedFile: sanitized.filesMentioned[0] || null,
    label: 'bug',
    description: `Auto-detected ${classification.reason} in ${toolName} — ${sanitized.stderrHead.slice(0, 120)}`,
    context: {
      toolName,
      sanitizedCmd: sanitized.cmd,
      stderrHead: sanitized.stderrHead,
      classifierReason: classification.reason,
      count: dedup.count,
      filesMentioned: sanitized.filesMentioned,
    },
  };
  try { fs.appendFileSync(pendingPath, JSON.stringify(submissionRequest) + '\n'); } catch {}

  // Increment session counter
  try { fs.writeFileSync(counterFile, String(sessionCount + 1)); } catch {}

  // Emit marker so assistant spawns /t1k:issue in its next turn
  const kitTag = classification.originKit ? `kit="${classification.originKit}"` : 'kit="?"';
  console.log(
    `[t1k:auto-issue] count=${sessionCount + 1}/${MAX_PER_SESSION} ${kitTag} ` +
    `reason="${classification.reason}" fp="${fp}"`
  );

  logHook('telemetry-kit-error-collector', {
    classified: classification.reason,
    fingerprint: fp.slice(0, 16), // truncated for log
    kit: classification.originKit || '?',
  });
  timer.end({ outcome: 'submitted', submitted: true });

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
