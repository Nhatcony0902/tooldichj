#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * contribution-flush-nudge.cjs — UserPromptSubmit hook.
 *
 * Problem this solves
 * -------------------
 * contribution-capture.cjs (PostToolUse:Bash) records `gh pr/issue create/merge/
 * close` refs to <claudeDir>/telemetry/contribution-tracking.jsonl and is meant to
 * nudge the user to run /t1k:contribution-flush once pending (tracked-but-
 * unrecorded) refs reach NUDGE_THRESHOLD. But its only nudge is a
 * `process.stdout.write` line in the PostToolUse hook, which (a) is NOT surfaced
 * as a user-visible suggestion, and (b) when the capture happens inside a
 * SUB-AGENT's Bash context (the common case), prints in the sub-agent and never
 * reaches the main session. Result: a user can accumulate many pending refs with
 * zero visible "run /t1k:contribution-flush" suggestion.
 *
 * This hook adds the PROMPT-TIME surfacing — it mirrors lesson-queue-processor.cjs:
 * on every UserPromptSubmit it reads the tracking + recorded ledgers, counts
 * pending refs, and (when pending ≥ NUDGE_THRESHOLD) injects a one-line reminder
 * into the AI context via stdout (the same mechanism UserPromptSubmit uses to add
 * context). It does NOT replace contribution-capture's per-command stdout line —
 * that stays as the capture confirmation; this is the additional prompt-time
 * surfacing that actually reaches the user.
 *
 * Dedup: a naive nudge would re-nag identically on EVERY prompt. Instead this hook
 * records the last-nudged pending count per session in
 * <claudeDir>/telemetry/contribution-nudge-seen-<sessionKey>.json and only emits
 * when the current pending count is GREATER than the last count it nudged at. So
 * the first time pending crosses the threshold it fires once; it stays silent on
 * subsequent prompts with the same count; and it re-fires only when MORE
 * contributions accumulate (a genuinely new state worth surfacing). A flush that
 * clears the ledger drops pending below threshold → silent again until the next
 * accumulation, and the seen-count is reset so the next crossing re-nudges.
 *
 * Fail-open: any error / missing file → exit 0, never block the prompt.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const {
  isTelemetryEnabled,
  resolveClaudeDir,
  readFeatureFlag,
  findProjectRoot,
  computeTeammateSessionKey,
} = require('./telemetry-utils.cjs');

const lib = require('./lib/contribution-telemetry.cjs');

/**
 * Count pending contribution refs: tracking entries whose ref_url is NOT present
 * in the recorded ledger. Mirrors the capture hook's pending count exactly so the
 * two stay in lockstep.
 *
 * @param {object[]} tracking rows from contribution-tracking.jsonl
 * @param {object[]} recorded rows from contribution-recorded.jsonl
 * @returns {number}
 */
function countPending(tracking, recorded) {
  const recordedSet = new Set((recorded || []).map(r => r && r.ref_url).filter(Boolean));
  let pending = 0;
  for (const t of tracking || []) {
    if (t && t.ref_url && !recordedSet.has(t.ref_url)) pending++;
  }
  return pending;
}

/**
 * Dedup decision: nudge only when pending has reached the threshold AND is
 * strictly greater than the count we last nudged at this session. Returns true
 * to nudge, false to stay silent.
 *
 * @param {number} pending current pending count
 * @param {number} lastNudgedCount count at the previous nudge this session (0 if never)
 * @param {number} threshold NUDGE_THRESHOLD
 */
function shouldNudge(pending, lastNudgedCount, threshold) {
  if (pending < threshold) return false;
  return pending > (Number(lastNudgedCount) || 0);
}

/** Build the one-line reminder injected into the AI context. */
function buildNudge(pending) {
  return `[t1k:contrib-queue] ${pending} contribution${pending === 1 ? '' : 's'} pending — `
    + 'run /t1k:contribution-flush to AI-score + record them.';
}

/**
 * Read the per-session last-nudged count. Fail-open → 0.
 * @param {string} seenPath
 * @returns {number}
 */
function readLastNudged(seenPath) {
  try {
    if (!fs.existsSync(seenPath)) return 0;
    const parsed = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
    if (parsed && typeof parsed.count === 'number') return parsed.count;
  } catch { /* fail-open */ }
  return 0;
}

/**
 * Persist the per-session last-nudged count. `count` is the pending value we just
 * nudged at; when pending falls below threshold we reset to 0 so the next crossing
 * re-nudges. Fail-silent.
 */
function writeLastNudged(seenPath, count) {
  try {
    fs.mkdirSync(path.dirname(seenPath), { recursive: true });
    fs.writeFileSync(seenPath, JSON.stringify({ count }));
  } catch { /* non-critical */ }
}

function main() {
  try {
    if (!isTelemetryEnabled()) return 0;

    const resolved = resolveClaudeDir();
    if (!resolved || !resolved.claudeDir) return 0;
    const { claudeDir, home } = resolved;
    const projectRoot = findProjectRoot();

    // Respect the kit-wide telemetry flag + cloud-telemetry flag — same gate the
    // capture hook applies, so the nudge never fires for users who opted out.
    if (!readFeatureFlag(claudeDir, 'telemetry', true)) return 0;
    if (!lib.isCloudTelemetryEnabled(projectRoot, home)) return 0;

    const telemetryDir = path.join(claudeDir, 'telemetry');
    const trackingPath = path.join(telemetryDir, lib.TRACKING_FILE);
    const recordedPath = path.join(telemetryDir, lib.RECORDED_FILE);

    const tracking = lib.readJsonl(trackingPath);
    if (!tracking.length) return 0; // nothing tracked → silent

    const recorded = lib.readJsonl(recordedPath);
    const pending = countPending(tracking, recorded);

    const sessionKey = computeTeammateSessionKey();
    const seenPath = path.join(telemetryDir, `contribution-nudge-seen-${sessionKey}.json`);
    const lastNudged = readLastNudged(seenPath);

    if (!shouldNudge(pending, lastNudged, lib.NUDGE_THRESHOLD)) {
      // If pending has dropped below threshold (e.g. a flush cleared the ledger),
      // reset the seen-count so a future re-accumulation nudges again.
      if (pending < lib.NUDGE_THRESHOLD && lastNudged !== 0) writeLastNudged(seenPath, 0);
      return 0;
    }

    // UserPromptSubmit injects context via stdout — same convention as
    // lesson-queue-processor / check-module-keywords.
    console.log(buildNudge(pending));
    writeLastNudged(seenPath, pending);
    return 0;
  } catch {
    return 0; // fail-open
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  countPending,
  shouldNudge,
  buildNudge,
  readLastNudged,
  writeLastNudged,
  main,
};
