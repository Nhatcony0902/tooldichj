#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * lesson-queue-processor.cjs — UserPromptSubmit hook.
 *
 * Reads .claude/telemetry/pending-skill-updates.jsonl. If non-empty, emits a
 * system-reminder block to stdout with per-entry details so the AI spawns
 * background sub-agents at its next turn:
 *   - type=lesson     → /t1k:sync-back  (draft PR to kit repo)
 *   - type=skill-bug  → /t1k:issue      (GitHub issue on kit repo)
 *   - type=mcp-gap    → /t1k:issue      (GitHub issue on the MCP FORK repo
 *                        resolved from t1k-config-{kit}.json mcp.required[]
 *                        .fork.issueRepo — NOT the kit repo)
 *
 * Writeback protocol: sub-agents append a writeback row
 * `{ fingerprint, submitted: true, prUrl|issueUrl }` after a successful
 * submission. On the next tick this processor does a 2-pass dedup:
 *   pass 1 — collect fingerprints from rows where `submitted === true`
 *   pass 2 — drop both the writeback rows AND any original entry whose
 *            fingerprint is in that set
 * So the writeback row marks the ORIGINAL entry (by fingerprint) as done,
 * not just the writeback row itself. See issue #170.
 *
 * Dry-run: when T1K_LESSON_SYNC_DRY_RUN=1, the reminder text says
 * "DRY RUN — sub-agent spawn skipped" so the AI knows not to act.
 *
 * Fail-open: any exception → process.exit(0), never block the user.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  isTelemetryEnabled,
  findProjectRoot,
  resolveClaudeDir,
  readFeatureFlag,
  T1K,
} = require('./telemetry-utils.cjs');

const { logHook, createHookTimer } = require('./hook-logger.cjs');

const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const FEATURE_FLAG = 'autoLessonSync';
const ENV_OPT_IN = 'T1K_AUTO_LESSON_SYNC';
const FAILURE_THRESHOLD = 5;

/**
 * Resolve the issue-target repo for an mcp-gap entry by reading the kit's
 * t1k-config-{kit}.json fragment(s) and pulling mcp.required[].fork.issueRepo.
 * Falls back to the kit name itself when the fork block is missing — sub-agent
 * still has enough info to file the issue, just on the kit repo not the fork.
 *
 * Why read at processor time rather than at collector time: the collector
 * stays minimal (one regex pass, no JSON I/O per marker), and config can
 * change between collection and processing without re-stamping queue rows.
 */
function resolveMcpIssueRepo(claudeDir, kitName, toolName) {
  try {
    if (!claudeDir || !fs.existsSync(claudeDir)) return null;
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const f of files) {
      let cfg;
      try { cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8')); }
      catch { continue; }
      const matchesKit =
        cfg && (cfg.kit === kitName || cfg.kitName === `theonekit-${kitName}` || cfg.kitName === kitName);
      if (!matchesKit) continue;
      const required = cfg.mcp && Array.isArray(cfg.mcp.required) ? cfg.mcp.required : [];
      for (const entry of required) {
        if (entry && entry.fork && typeof entry.fork.issueRepo === 'string') {
          return entry.fork.issueRepo;
        }
      }
    }
  } catch { /* fail-open */ }
  return null;
}

/**
 * Read queue JSONL lines. Silently skips unparseable lines.
 * @param {string} queuePath
 * @returns {object[]}
 */
function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  let raw;
  try { raw = fs.readFileSync(queuePath, 'utf8'); } catch { return []; }
  return raw.split('\n').filter(Boolean).map(line => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

/**
 * Filter out completed entries via 2-pass dedup by fingerprint.
 *
 * Sub-agents append a writeback row `{ fingerprint, submitted: true, prUrl|issueUrl }`
 * after a successful submission. The original pending entry is left in place
 * (it has `submitted: undefined`). Without fingerprint matching, only the
 * writeback row would be dropped and the original entry would loop forever.
 *
 * Pass 1: collect fingerprints from rows where `submitted === true`.
 * Pass 2: drop the writeback rows themselves AND any row whose fingerprint
 *         is in that set.
 *
 * Fixes #170.
 *
 * @param {object[]} entries
 * @returns {object[]}
 */
function filterUnsubmitted(entries) {
  const submittedFingerprints = new Set(
    entries
      .filter(e => e && e.submitted === true && e.fingerprint)
      .map(e => e.fingerprint)
  );
  return entries.filter(e =>
    e
    && e.submitted !== true
    && !submittedFingerprints.has(e.fingerprint)
  );
}

/**
 * Apply circuit breaker to the queue:
 * - Drop entries with `permanently_failed: true`
 * - Increment `failures` on entries that returned with `submitted: false`
 *   (sub-agent attempted but did not succeed)
 * - When `failures >= FAILURE_THRESHOLD`, mark `permanently_failed: true`
 *   and surface a one-time `[t1k:lesson-stale]` reminder
 *
 * Returns { kept, stale } where `kept` is the new queue contents and
 * `stale` is the list of fingerprints that just tripped the circuit breaker.
 *
 * @param {object[]} entries
 * @returns {{ kept: object[], stale: string[] }}
 */
function applyCircuitBreaker(entries) {
  const kept = [];
  const stale = [];
  for (const e of entries) {
    if (!e) continue;
    if (e.permanently_failed === true) continue; // drop
    const failures = Number(e.failures) || 0;
    // Entries flagged `submitted: false` by a returning sub-agent → bump count
    const bumped = e.submitted === false ? failures + 1 : failures;
    if (bumped >= FAILURE_THRESHOLD) {
      stale.push(e.fingerprint || '?');
      continue; // drop now and surface the stale reminder
    }
    if (e.submitted === false) {
      kept.push({ ...e, failures: bumped, submitted: undefined });
    } else {
      kept.push(e);
    }
  }
  return { kept, stale };
}

/**
 * Persist the queue back to JSONL. If the queue is now empty, unlink the file
 * to keep directories tidy; otherwise overwrite with the remaining lines.
 */
function writeQueue(queuePath, entries) {
  try {
    if (entries.length === 0) {
      if (fs.existsSync(queuePath)) fs.unlinkSync(queuePath);
      return;
    }
    const text = entries.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(queuePath, text);
  } catch { /* fail-silent */ }
}

/**
 * Build the ordered list of candidate queue paths for defensive sweep.
 *
 * Priority:
 *   1. canonical   — <projectRoot>/.claude/telemetry/pending-skill-updates.jsonl
 *   2. globalTele  — ~/.claude/telemetry/pending-skill-updates.jsonl
 *   3. globalRoot  — ~/.claude/pending-skill-updates.jsonl  (observed orphan)
 *   4. projectRoot — <projectRoot>/.claude/pending-skill-updates.jsonl (observed orphan)
 *
 * Deduped via Set so that in global-only mode (projectRoot == ~/.claude parent)
 * the canonical path doesn't also appear as an "orphan" candidate.
 *
 * @param {string} projectRoot
 * @returns {{ canonical: string, orphans: string[] }}
 */
function buildCandidatePaths(projectRoot) {
  const home = os.homedir();
  const canonical = path.join(projectRoot, T1K.CLAUDE_DIR, T1K.TELEMETRY_DIR, QUEUE_FILENAME);
  const globalTelePath = path.join(home, '.claude', T1K.TELEMETRY_DIR, QUEUE_FILENAME);
  const globalRootPath = path.join(home, '.claude', QUEUE_FILENAME);
  const projectRootPath = path.join(projectRoot, T1K.CLAUDE_DIR, QUEUE_FILENAME);

  // Orphans = all candidates except canonical, deduped
  const seen = new Set([canonical]);
  const orphans = [];
  for (const p of [globalTelePath, globalRootPath, projectRootPath]) {
    if (!seen.has(p)) {
      seen.add(p);
      orphans.push(p);
    }
  }
  return { canonical, orphans };
}

/**
 * Read all candidate queue paths, merge by fingerprint (submitted=true wins),
 * write merged result to the canonical path, then delete/truncate orphan files
 * that had entries (migration). Returns the total merged entry array.
 *
 * Merge strategy: entries from orphan files are merged into the canonical set.
 * If a fingerprint appears in multiple files and at least one has `submitted: true`,
 * the submitted version wins (so writeback rows in orphans correctly clear canonical entries).
 *
 * @param {string} canonical
 * @param {string[]} orphans
 * @returns {object[]} merged entries (including writeback rows — caller must filterUnsubmitted)
 */
function mergeAndMigrateQueues(canonical, orphans) {
  // Read canonical first
  const canonicalEntries = readQueue(canonical);

  // Read orphans that exist and have content
  const orphanSources = [];
  for (const orphanPath of orphans) {
    if (!fs.existsSync(orphanPath)) continue;
    const entries = readQueue(orphanPath);
    if (entries.length > 0) {
      orphanSources.push({ path: orphanPath, entries });
    }
  }

  if (orphanSources.length === 0) {
    // No orphan data — no migration needed, return canonical as-is
    return canonicalEntries;
  }

  // Merge: build a map keyed by fingerprint; submitted=true wins over submitted=undefined/false
  // Entries without a fingerprint are kept as-is (de-duplication not possible)
  const fingerprintMap = new Map();
  const unkeyed = []; // entries without fingerprint — kept as-is

  function absorb(entry) {
    if (!entry || !entry.fingerprint) {
      unkeyed.push(entry);
      return;
    }
    const existing = fingerprintMap.get(entry.fingerprint);
    if (!existing) {
      fingerprintMap.set(entry.fingerprint, entry);
    } else {
      // submitted: true wins
      if (entry.submitted === true && existing.submitted !== true) {
        fingerprintMap.set(entry.fingerprint, entry);
      }
    }
  }

  for (const entry of canonicalEntries) absorb(entry);

  let totalOrphanEntries = 0;
  for (const { entries } of orphanSources) {
    totalOrphanEntries += entries.length;
    for (const entry of entries) absorb(entry);
  }

  const merged = [...fingerprintMap.values(), ...unkeyed];

  // Write merged result to canonical (ensure dir exists)
  const canonicalDir = path.dirname(canonical);
  try {
    if (!fs.existsSync(canonicalDir)) fs.mkdirSync(canonicalDir, { recursive: true });
    const text = merged.map(e => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(canonical, text);
  } catch { /* fail-silent — will proceed with in-memory merged */ }

  // Truncate orphan files after successful migration so they don't re-accumulate
  for (const { path: orphanPath, entries } of orphanSources) {
    try {
      fs.unlinkSync(orphanPath);
      process.stderr.write(
        `[lesson-queue-processor] migrated ${entries.length} entries from ${orphanPath} → ${canonical}\n`
      );
    } catch { /* fail-silent */ }
  }

  return merged;
}

/**
 * Build the system-reminder text sent to the AI. Includes per-entry details
 * and explicit instructions for which skill to invoke per marker type.
 *
 * @param {object[]} entries
 * @param {{ dryRun?: boolean, claudeDir?: string, canonicalQueuePath?: string }} opts
 */
function buildReminder(entries, opts) {
  const isDryRun = !!(opts && opts.dryRun);
  const claudeDir = opts && opts.claudeDir;
  const canonicalQueuePath = (opts && opts.canonicalQueuePath) || QUEUE_FILENAME;
  let mcpGapPresent = false;
  const lines = [];
  lines.push(`[t1k:lesson-queue] ${entries.length} pending skill update${entries.length === 1 ? '' : 's'}:`);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const idx = i + 1;
    if (e.type === 'lesson') {
      lines.push(
        `  ${idx}. lesson — kit=${e.kit} skill=${e.skill} fragment=${e.payload?.fragment || '?'} reason="${e.payload?.reason || ''}"`
      );
    } else if (e.type === 'skill-bug') {
      lines.push(
        `  ${idx}. skill-bug — kit=${e.kit} skill=${e.skill} bug="${e.payload?.bug || ''}" evidence="${e.payload?.evidence || ''}"`
      );
    } else if (e.type === 'mcp-gap') {
      mcpGapPresent = true;
      const repo = resolveMcpIssueRepo(claudeDir, e.kit, e.skill) || `(fallback: theonekit-${e.kit})`;
      lines.push(
        `  ${idx}. mcp-gap — kit=${e.kit} tool=${e.skill} gap="${e.payload?.gap || ''}" evidence="${e.payload?.evidence || ''}" → file issue on ${repo}`
      );
    } else {
      lines.push(`  ${idx}. ${e.type || 'unknown'} — kit=${e.kit || '?'} skill=${e.skill || '?'}`);
    }
  }

  if (isDryRun) {
    lines.push('');
    lines.push('DRY RUN — sub-agent spawn skipped. Entries remain queued; set T1K_LESSON_SYNC_DRY_RUN=0 to submit.');
  } else {
    lines.push('');
    lines.push('Action: spawn one background sub-agent per entry (MUST set subagent_type to a named T1K agent — e.g. t1k-project-manager or t1k-skills-manager — NEVER general-purpose/claude which trip generic-agent-detector per #344):');
    lines.push('  - type=lesson    → /t1k:sync-back (draft PR to kit repo)');
    lines.push('  - type=skill-bug → /t1k:issue     (GitHub issue on kit repo)');
    if (mcpGapPresent) {
      lines.push('  - type=mcp-gap   → /t1k:issue     (GitHub issue on the MCP FORK repo shown above — NOT the kit repo)');
    }
    lines.push(`After each completes, append a writeback line to \`${canonicalQueuePath}\` with`);
    lines.push('{ fingerprint, submitted: true, prUrl | issueUrl } so the processor can drop the row.');
  }

  return lines.join('\n');
}

function main() {
  try {
    if (!isTelemetryEnabled()) return 0;

    const resolved = resolveClaudeDir();
    if (!resolved) return 0;
    // Env-var opt-in mirrors lesson-collector.cjs: T1K_AUTO_LESSON_SYNC=1
    // force-enables the reminder emission even if config ships the flag off.
    const enabled = readFeatureFlag(resolved.claudeDir, FEATURE_FLAG, false)
      || process.env[ENV_OPT_IN] === '1';
    if (!enabled) return 0;

    const timer = createHookTimer('lesson-queue-processor');
    const projectRoot = findProjectRoot();

    // Build candidate paths: canonical + known orphan locations.
    // mergeAndMigrateQueues reads all, merges by fingerprint, writes canonical,
    // truncates orphans — so writeback rows written to any location are picked up.
    const { canonical: queuePath, orphans } = buildCandidatePaths(projectRoot);
    const all = mergeAndMigrateQueues(queuePath, orphans);

    const unsubmitted = filterUnsubmitted(all);
    const removedSubmitted = all.length - unsubmitted.length;

    // Apply circuit breaker: bump failure counters, drop permanently_failed.
    const { kept, stale } = applyCircuitBreaker(unsubmitted);
    const removedStale = unsubmitted.length - kept.length;

    // Rewrite the canonical file when the queue actually changed.
    if (removedSubmitted > 0 || removedStale > 0 || (all.length > 0 && kept.length === 0)) {
      writeQueue(queuePath, kept);
    }

    // Surface stale entries one-time so the user knows the circuit tripped.
    if (stale.length > 0) {
      console.log(`[t1k:lesson-stale] ${stale.length} entr${stale.length === 1 ? 'y' : 'ies'} dropped after ${FAILURE_THRESHOLD} failures: ${stale.join(', ')}`);
    }

    if (kept.length === 0) {
      timer.end({ outcome: 'skip', note: 'empty-queue', removed: removedSubmitted + removedStale });
      return 0;
    }

    const isDryRun = process.env.T1K_LESSON_SYNC_DRY_RUN === '1';
    const reminder = buildReminder(kept, { dryRun: isDryRun, claudeDir: resolved.claudeDir, canonicalQueuePath: queuePath });

    // UserPromptSubmit hooks inject into the AI context via stdout.
    // Existing hooks (check-module-keywords, telemetry-stop-reminder) use
    // console.log for the same purpose; we follow that convention.
    console.log(reminder);

    logHook('lesson-queue-processor', {
      pending: kept.length,
      removed: removedSubmitted + removedStale,
      stale: stale.length,
      dryRun: isDryRun,
    });
    timer.end({ outcome: 'reminder-emitted' });
    return 0;
  } catch {
    return 0; // fail-open
  }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  readQueue,
  filterUnsubmitted,
  applyCircuitBreaker,
  writeQueue,
  buildCandidatePaths,
  mergeAndMigrateQueues,
  buildReminder,
  resolveMcpIssueRepo,
  main,
};
