#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * contribution-capture.cjs — PostToolUse:Bash safeguard for contribution telemetry.
 *
 * Problem this solves
 * -------------------
 * Recording a contribution score is a SKILL-BODY step (t1k:issue / t1k:sync-back /
 * t1k:triage invoke the t1k:contribution-score SSOT skill). A skill step is
 * model-dependent: if the model skips it, nothing records. This hook is the
 * DETERMINISTIC, can't-skip CAPTURE layer — it fires after every Bash command,
 * detects terminal/create `gh` actions against T1K repos, and appends a
 * fact-only line to a durable tracking file. The t1k:contribution-flush SKILL
 * later AI-scores + POSTs each tracked ref (a hook cannot judge quality).
 *
 * What it captures (T1K repos only — The1Studio/theonekit-* | t1k-*):
 *   - gh pr   merge <n>  /  gh pr merge --admin ...  (numberless/repoless form)
 *   - gh pr   close <n>
 *   - gh issue close <n>
 *   - gh issue|pr create  → ref_url parsed from the command's STDOUT
 *
 * It records facts only — NO score, NO gh user lookup (kept network-free + fast;
 * the flush skill resolves the authed user once). Replaces the retired
 * contribution-score-flush.cjs Stop-hook transcript backstop: per-command and
 * stdout-aware (so it can capture creates the old backstop skipped), and
 * deterministic instead of end-of-session best-effort.
 *
 * Nudge: once pending (tracked-but-unrecorded) refs reach NUDGE_THRESHOLD AND
 * this command just added one, it prints a one-line reminder to run
 * /t1k:contribution-flush. No work is done in the hook beyond append + count.
 *
 * Fail-open: ANY missing prerequisite / unexpected throw → exit 0. Never blocks.
 * Security: never logs tokens; the stored `cmd` excerpt is capped + scrubbed of
 * obvious `Authorization:`/token-bearing args is out of scope (gh merge/close/
 * create commands don't carry secrets), but the excerpt is length-capped.
 */
'use strict';

try {
  const fs = require('fs');
  const path = require('path');
  const { execFileSync } = require('child_process');
  const {
    isTelemetryEnabled, parseHookStdin, findProjectRoot, resolveClaudeDir, readFeatureFlag,
  } = require('./telemetry-utils.cjs');
  const lib = require('./lib/contribution-telemetry.cjs');

  if (!isTelemetryEnabled()) process.exit(0);

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);
  if (hookData.tool_name && hookData.tool_name !== 'Bash') process.exit(0);

  const cmd = (hookData.tool_input && hookData.tool_input.command || '').trim();
  if (!cmd || cmd.indexOf('gh ') === -1) process.exit(0);

  // Cheap pre-filter: only proceed for the verbs we capture.
  if (!/\bgh\s+(?:pr|issue)\s+(?:merge|close|create)\b/.test(cmd)) process.exit(0);

  const resolved = resolveClaudeDir();
  if (!resolved || !resolved.claudeDir) process.exit(0);
  const { claudeDir, home } = resolved;
  const projectRoot = findProjectRoot();

  // Respect the kit-wide telemetry feature flag + cloud-telemetry flag.
  if (!readFeatureFlag(claudeDir, 'telemetry', true)) process.exit(0);
  if (!lib.isCloudTelemetryEnabled(projectRoot, home)) process.exit(0);

  // ── Collect refs ──────────────────────────────────────────────────────────
  const refs = [];

  // merge / close — ref lives in the command. Resolve current repo/PR only for
  // the numberless admin-merge form, and only when needed (avoids per-Bash gh
  // calls on unrelated commands).
  const needsCtx = /\bgh\s+pr\s+merge\b/.test(cmd) && !/--repo/.test(cmd);
  let ctx;
  if (needsCtx) ctx = resolveGhContext(execFileSync);
  refs.push(...lib.refsFromCommand(cmd, ctx));

  // create — ref lives in the command's STDOUT (the URL gh prints).
  if (lib.isCreateCommand(cmd)) {
    const out = stringifyResult(hookData.tool_result ?? hookData.tool_response);
    refs.push(...lib.refsFromOutput(out));
  }

  if (!refs.length) process.exit(0);

  // ── Append (dedup vs tracking + recorded ledger) ────────────────────────────
  const telemetryDir = path.join(claudeDir, 'telemetry');
  const trackingPath = path.join(telemetryDir, lib.TRACKING_FILE);
  const recordedPath = path.join(telemetryDir, lib.RECORDED_FILE);

  const tracking = lib.readJsonl(trackingPath);
  const known = new Set(tracking.map(t => t.ref_url));
  const recorded = new Set(lib.readJsonl(recordedPath).map(r => r.ref_url));

  const nowIso = new Date().toISOString();
  let added = 0;
  for (const ref of refs) {
    if (known.has(ref.ref_url) || recorded.has(ref.ref_url)) continue;
    lib.appendJsonl(trackingPath, {
      ts: nowIso,
      kind: ref.kind,
      action: ref.action,
      repo: ref.repo,
      ref_url: ref.ref_url,
      cmd: cmd.slice(0, 120),
      attempts: 0,
      first_seen_ts: nowIso,
    });
    known.add(ref.ref_url);
    added++;
  }

  if (!added) process.exit(0);

  // ── Nudge ───────────────────────────────────────────────────────────────────
  const pending = lib.readJsonl(trackingPath).filter(t => !recorded.has(t.ref_url)).length;
  process.stdout.write(`[t1k:contrib-capture] captured ${added} contribution ref(s)\n`);
  if (pending >= lib.NUDGE_THRESHOLD) {
    process.stdout.write(
      `[t1k:contrib-capture] ${pending} contributions pending — run /t1k:contribution-flush to score + record them\n`
    );
  }
  process.exit(0);
} catch {
  // Hard fail-open: a buggy capture hook must never block a Bash command.
  process.exit(0);
}

/** Coerce a Bash tool result (string or {stdout,...}) to a searchable string. */
function stringifyResult(r) {
  if (r == null) return '';
  if (typeof r === 'string') return r;
  try { return JSON.stringify(r); } catch { return ''; }
}

/**
 * Resolve current repo + current branch's PR number for the numberless/repoless
 * admin-merge form. Best-effort; any failure → undefined fields. Short timeouts
 * keep the PostToolUse path snappy.
 */
function resolveGhContext(execFileSync) {
  const out = {};
  try {
    out.currentRepo = execFileSync('gh', ['repo', 'view', '--json', 'nameWithOwner', '--jq', '.nameWithOwner'], {
      timeout: 4000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim() || undefined;
  } catch { /* leave undefined */ }
  try {
    const pr = execFileSync('gh', ['pr', 'view', '--json', 'number', '--jq', '.number'], {
      timeout: 4000, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    if (pr && /^\d+$/.test(pr)) out.currentPr = pr;
  } catch { /* leave undefined */ }
  return out;
}
