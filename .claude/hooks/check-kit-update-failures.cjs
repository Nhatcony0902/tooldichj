#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * check-kit-update-failures.cjs — SessionStart hook: detect silent failures
 * inside the background `t1k update --yes` pipeline and route to the
 * existing auto-issue submission flow.
 *
 * Background: `check-kit-updates.cjs` spawns a detached `t1k update --yes`
 * via the runner wrapper. PostToolUse-driven `telemetry-kit-error-collector.cjs`
 * never sees those failures because the child runs outside the AI tool
 * surface — its output only lands in `~/.claude/.kit-update.log` and
 * `~/.claude/.kit-update.status`.
 *
 * This hook fills that gap. On SessionStart it:
 *   1. Scans the LAST session block of ~/.claude/.kit-update.log for
 *      high-severity failure patterns.
 *   2. Reads ~/.claude/.kit-update.status — if exitCode !== 0 within
 *      the freshness window, treats the recorded stderrTail as a
 *      high-severity signal.
 *   3. Fingerprints + dedups + rate-limits via the shared
 *      kit-error-dedup library (same TTL + per-session cap as the
 *      tool-error collector).
 *   4. On first-seen failure: append a pending submission entry to
 *      .claude/telemetry/pending-issue-submissions.jsonl and emit a
 *      [t1k:auto-issue] marker so the assistant spawns a background
 *      /t1k:issue sub-agent (see rules/error-recovery.md handler).
 *
 * Pure log-scan + status-read. Does NOT modify the runner. Does NOT
 * call the Task tool. Fail-open on every exception.
 *
 * Cross-platform: no /dev/stdin, no shell syntax. Uses path.join,
 * os.homedir, process.platform.
 */
'use strict';

try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const crypto = require('crypto');

  const {
    isTelemetryEnabled,
    ensureTelemetryDir,
    todayDateStr,
    findProjectRoot,
    T1K,
  } = require('./telemetry-utils.cjs');

  const { logHook, createHookTimer } = require('./hook-logger.cjs');
  const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

  // ── guard 1: global telemetry opt-out ──
  if (!isTelemetryEnabled()) process.exit(0);

  // ── guard 2: autoIssueSubmission feature flag (same gate as the tool-error collector) ──
  function readAutoIssueConfig() {
    const defaults = { enabled: false, maxPerSession: 5, dedupeTTLDays: 7, dryRunEnv: 'T1K_AUTO_ISSUE_DRY_RUN' };
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
          }
        } catch { /* ignore malformed fragment */ }
      }
      return result;
    } catch {
      return defaults;
    }
  }

  const autoIssueConfig = readAutoIssueConfig();
  if (!autoIssueConfig.enabled) process.exit(0);

  const timer = createHookTimer('check-kit-update-failures');

  // ── Resolve $HOME/.claude/.kit-update.log + .status paths ──
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir();
  if (!home) { timer.end({ outcome: 'no-home' }); process.exit(0); }

  const claudeHome = path.join(home, '.claude');
  const logPath = path.join(claudeHome, T1K.PATHS.UPDATE_LOG);
  const statusPath = path.join(claudeHome, T1K.PATHS.UPDATE_STATUS);

  // ── Read the last session block from .kit-update.log ──
  // Session boundary marker is `===== [ISO-timestamp] ===== ` written by
  // check-kit-updates.cjs before each spawn.
  function readLastSessionBlock() {
    if (!fs.existsSync(logPath)) return '';
    let raw;
    try { raw = fs.readFileSync(logPath, 'utf8'); } catch { return ''; }
    if (!raw) return '';
    // Only inspect the last ~64KB — log can grow large; bound the scan.
    const MAX_TAIL = 64 * 1024;
    if (raw.length > MAX_TAIL) raw = raw.slice(-MAX_TAIL);
    // Separator written by check-kit-updates.cjs:
    //   "\n===== [ISO-timestamp] Auto-update via CLI =====\n"
    // Be liberal: anchor on the `===== [<timestamp>]` prefix; the suffix may
    // contain any text before another `=====` run.
    const sep = /^===== \[[^\]]+\][^\n]*=====/gm;
    let lastIdx = -1;
    let m;
    while ((m = sep.exec(raw)) !== null) lastIdx = m.index;
    if (lastIdx < 0) return raw; // no separator — treat all as last block
    return raw.slice(lastIdx);
  }

  // ── Pattern table (issue body, with severity classification) ──
  // High-severity persistent failures trigger the auto-issue pipeline.
  // Network-class errors are excluded — they self-recover next session.
  const PATTERNS = [
    { re: /✗\s+Kit content update failed:/i,            severity: 'high',   label: 'kit-content-failed' },
    { re: /--yes\s+requires\s+one\s+of/i,                severity: 'high',   label: 'modular-kit-needs-preset' },
    { re: /gh:\s+command\s+not\s+found/i,                severity: 'medium', label: 'missing-dependency-gh' },
    { re: /Permission\s+denied/i,                        severity: 'high',   label: 'permission-denied' },
    { re: /MODULE_NOT_FOUND/,                            severity: 'high',   label: 'module-not-found' },
    { re: /manifest\.json:\s+not\s+found/i,              severity: 'medium', label: 'manifest-missing' },
    { re: /release\s+not\s+found/i,                      severity: 'medium', label: 'release-not-found' },
    // Network-class — excluded from auto-issue (self-recover). Listed for
    // documentation; matchPatterns() skips them via severity filter.
    { re: /Error:\s+ENOTFOUND/i,                         severity: 'low',    label: 'network-enotfound' },
    { re: /Error:\s+ECONNREFUSED/i,                      severity: 'low',    label: 'network-econnrefused' },
  ];

  function matchPatterns(text) {
    if (!text) return [];
    const hits = [];
    for (const p of PATTERNS) {
      if (p.severity === 'low') continue; // skip network-class
      if (p.re.test(text)) hits.push(p);
    }
    return hits;
  }

  // ── Read .kit-update.status (written by t1k-update-runner.cjs) ──
  // Only consider it a signal if the run is fresh (<24h, same window as the
  // PREV RUN FAILED banner in check-kit-updates.cjs) and exitCode !== 0.
  const STATUS_MAX_AGE_MS = 24 * 60 * 60 * 1000;
  function readStatusFailure() {
    if (!fs.existsSync(statusPath)) return null;
    let status;
    try { status = JSON.parse(fs.readFileSync(statusPath, 'utf8')); }
    catch { return null; }
    if (!status || typeof status.exitCode !== 'number') return null;
    if (status.exitCode === 0) return null;
    const ts = Date.parse(status.ts || '');
    if (!Number.isFinite(ts)) return null;
    const age = Date.now() - ts;
    if (age < 0 || age > STATUS_MAX_AGE_MS) return null;
    return status;
  }

  // ── Build a signal record (combining log + status) ──
  const lastBlock = readLastSessionBlock();
  const logHits = matchPatterns(lastBlock);
  const statusFailure = readStatusFailure();

  if (logHits.length === 0 && !statusFailure) {
    timer.end({ outcome: 'no-failures' });
    process.exit(0);
  }

  // ── Sanitize: strip absolute user paths from the stderr/log excerpt ──
  function sanitizeText(s) {
    if (!s) return '';
    let out = String(s);
    if (home) out = out.split(home).join('~');
    // Strip Windows-style user paths
    out = out.replace(/C:\\Users\\[^\\/\s"']+/gi, '~');
    // Bound size
    if (out.length > 1500) out = out.slice(-1500);
    return out;
  }

  // Derive the canonical error line for fingerprinting. Prefer the
  // status.stderrTail (truer signal — exit-code-backed), then fall back
  // to the first log-pattern match. Two callers in two sessions hitting
  // the same root cause should produce the same fingerprint.
  let errorHead;
  let primaryLabel;
  if (statusFailure) {
    const tail = String(statusFailure.stderrTail || '').trim();
    const lines = tail.split('\n').map(l => l.trim()).filter(Boolean);
    errorHead = lines.slice(-3).join(' ').slice(0, 300) ||
                `exitCode=${statusFailure.exitCode} (no stderr captured)`;
    primaryLabel = (logHits[0] && logHits[0].label) || `runner-exit-${statusFailure.exitCode}`;
  } else {
    // Log-only path: find the matched line for stable fingerprinting.
    const firstHit = logHits[0];
    const lineMatch = lastBlock.split('\n').find(l => firstHit.re.test(l));
    errorHead = (lineMatch || firstHit.label).slice(0, 300);
    primaryLabel = firstHit.label;
  }

  const sanitizedErrorHead = sanitizeText(errorHead);

  // ── Fingerprint + dedup ──
  const classification = {
    reason: 'kit-update-silent-failure',
    originKit: 'theonekit-core', // hook lives in core; affected kit is recorded below
  };
  const fp = fingerprint(
    { tool: 't1k-update', cmd: 'update --yes', stderrHead: sanitizedErrorHead },
    classification
  );
  const dedup = checkAndRecord(fp, {
    reason: classification.reason,
    originKit: classification.originKit,
    maxAgeDays: autoIssueConfig.dedupeTTLDays,
  });

  // ── Session counter (shared dir with the tool-error collector) ──
  const MAX_PER_SESSION = autoIssueConfig.maxPerSession;
  const sessionId = process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('md5')
      .update((process.env.CLAUDE_PROJECT_DIR || '') + new Date().toISOString().slice(0, 10))
      .digest('hex').slice(0, 16);
  const rateDir = path.join(os.tmpdir(), 't1k-auto-issue');
  try { if (!fs.existsSync(rateDir)) fs.mkdirSync(rateDir, { recursive: true }); } catch { /* ok */ }
  const counterFile = path.join(rateDir, `${sessionId}.count`);
  let sessionCount = 0;
  try {
    if (fs.existsSync(counterFile)) {
      sessionCount = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
    }
  } catch { /* ok */ }

  // ── Build telemetry entry ──
  const telemetryDir = ensureTelemetryDir();
  const jsonlPath = path.join(telemetryDir, `kit-errors-${todayDateStr()}.jsonl`);
  const entry = {
    ts: new Date().toISOString(),
    fingerprint: fp,
    reason: classification.reason,
    origin: {
      kit: classification.originKit,
      repo: 'The1Studio/theonekit-core',
      module: null,
    },
    sanitized: {
      tool: 't1k-update',
      cmd: 'update --yes',
      stderrHead: sanitizedErrorHead,
      filesMentioned: [],
    },
    detection: {
      source: statusFailure ? 'status-exit-code' : 'log-pattern',
      label: primaryLabel,
      patterns: logHits.map(h => h.label),
      exitCode: statusFailure ? statusFailure.exitCode : null,
      affectedKits: statusFailure && Array.isArray(statusFailure.kits) ? statusFailure.kits : [],
    },
    isDuplicate: dedup.isDuplicate,
    submittedBefore: dedup.submittedBefore,
    count: dedup.count,
    submitted: false,
    skipReason: null,
  };

  // Duplicate → log + skip submission (no counter bump)
  if (dedup.isDuplicate) {
    entry.skipReason = dedup.submittedBefore ? 'already-submitted' : 'local-duplicate';
    try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }
    timer.end({ outcome: 'duplicate', skipReason: entry.skipReason });
    process.exit(0);
  }

  // Rate-limited → log + skip submission
  if (sessionCount >= MAX_PER_SESSION) {
    entry.skipReason = 'rate-limited';
    try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }
    timer.end({ outcome: 'rate-limited' });
    process.exit(0);
  }

  // Dry-run → log to ~/.claude/.auto-issue.log and skip
  if (process.env[autoIssueConfig.dryRunEnv] === '1') {
    entry.skipReason = 'dry-run';
    try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }
    try {
      const auditPath = path.join(claudeHome, '.auto-issue.log');
      const auditDir = path.dirname(auditPath);
      if (!fs.existsSync(auditDir)) fs.mkdirSync(auditDir, { recursive: true });
      fs.appendFileSync(auditPath,
        `[${entry.ts}] DRY_RUN fp=${fp} reason=${classification.reason} ` +
        `label=${primaryLabel} source=${entry.detection.source}\n`);
    } catch { /* ok */ }
    timer.end({ outcome: 'dry-run' });
    process.exit(0);
  }

  // ── Real submission path ──
  try { fs.appendFileSync(jsonlPath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }

  const pendingPath = path.join(telemetryDir, 'pending-issue-submissions.jsonl');
  const submissionRequest = {
    ts: entry.ts,
    fingerprint: fp,
    origin: entry.origin,
    affectedFile: null,
    label: 'bug',
    description:
      `Auto-detected ${classification.reason} (${primaryLabel}) — ` +
      sanitizedErrorHead.slice(0, 120),
    context: {
      toolName: 't1k-update',
      sanitizedCmd: 'update --yes',
      stderrHead: sanitizedErrorHead,
      classifierReason: classification.reason,
      detectionSource: entry.detection.source,
      detectionLabel: primaryLabel,
      patternsMatched: entry.detection.patterns,
      exitCode: entry.detection.exitCode,
      affectedKits: entry.detection.affectedKits,
      count: dedup.count,
      filesMentioned: [],
    },
  };
  try { fs.appendFileSync(pendingPath, JSON.stringify(submissionRequest) + '\n'); } catch { /* ok */ }

  // Bump session counter (shared file with the tool-error collector)
  try { fs.writeFileSync(counterFile, String(sessionCount + 1)); } catch { /* ok */ }

  // Emit marker — same format as telemetry-kit-error-collector.cjs so the
  // existing assistant handler in rules/error-recovery.md picks it up.
  console.log(
    `[t1k:auto-issue] count=${sessionCount + 1}/${MAX_PER_SESSION} ` +
    `kit="${classification.originKit}" reason="${classification.reason}" fp="${fp}"`
  );

  logHook('check-kit-update-failures', {
    label: primaryLabel,
    fingerprint: fp.slice(0, 16),
    detectionSource: entry.detection.source,
  });
  timer.end({ outcome: 'submitted', submitted: true });

  process.exit(0);
} catch {
  process.exit(0); // fail-open
}
