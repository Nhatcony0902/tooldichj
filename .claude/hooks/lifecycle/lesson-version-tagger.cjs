// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';

/**
 * lesson-version-tagger.cjs — A4.5 lifecycle subscriber.
 *
 * Subscribes to: postUpdate (and only postUpdate)
 *
 * Purpose: solve cross-version drift in the auto-lesson pipeline (per
 * .claude/rules/telemetry.md). When a `[t1k:lesson ...]` marker queued in
 * `<claudeDir>/telemetry/pending-skill-updates.jsonl` is later picked up by
 * the /t1k:sync-back sub-agent, the kit may have updated in between. Tagging
 * the queue entries with the kit version that was current AT QUEUE TIME (or
 * after the most recent update) lets the sync-back agent detect drift and
 * decide whether to re-evaluate the lesson against the new version.
 *
 * What this subscriber does on every postUpdate:
 *   1. Read <claudeDir>/telemetry/pending-skill-updates.jsonl (skip if absent)
 *   2. For each entry whose `kit` matches the postUpdate payload's `kit` AND
 *      that does NOT already have a `kitVersionAtUpdate` field, tag it with
 *      payload.toVersion + the postUpdate ts
 *   3. Write the queue back atomically (rename-after-write)
 *
 * Idempotency: declared `idempotent: true`. Re-firing the same postUpdate is
 * safe — the field-presence guard skips entries that were already tagged.
 *
 * Fail-open: every I/O / parse step in try/catch. Tagging failure must NEVER
 * block the lifecycle hub or block the queue from being processed by the
 * /t1k:sync-back agent.
 *
 * Spec: plans/260422-1905-safety-addendum-implementation/artifacts/a4-design-decisions.md §Q3
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const TARGET_EVENT = 'postUpdate';

/**
 * Resolve the .claude dir that owns this subscriber file.
 * __dirname = <claudeDir>/hooks/lifecycle  →  parent.parent = <claudeDir>
 */
function resolveClaudeDir() {
  try {
    const claudeDir = path.resolve(__dirname, '..', '..');
    if (path.basename(claudeDir) === '.claude') return claudeDir;
    return null;
  } catch {
    return null;
  }
}

/**
 * Atomic write: write to a sibling temp file and rename. Avoids partial-state
 * if the process is killed mid-write.
 */
function writeQueueAtomic(filePath, content) {
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, { mode: 0o600 });
  fs.renameSync(tmpPath, filePath);
}

/**
 * Tag matching queue entries with the new version. Returns the number of
 * entries that were tagged; 0 means a no-op (no matching kit, or all already
 * tagged).
 */
function tagQueueEntries(claudeDir, payload) {
  if (!claudeDir || !payload || typeof payload.kit !== 'string' || typeof payload.toVersion !== 'string') {
    return 0;
  }
  const queueFile = path.join(claudeDir, 'telemetry', QUEUE_FILENAME);
  if (!fs.existsSync(queueFile)) return 0;

  let raw;
  try {
    raw = fs.readFileSync(queueFile, 'utf8');
  } catch {
    return 0;
  }

  const lines = raw.split('\n');
  let tagged = 0;
  const stamp = new Date().toISOString();
  const taggedLines = lines.map(line => {
    if (line.length === 0) return line;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return line; // leave unparseable lines alone
    }
    if (!entry || typeof entry !== 'object') return line;
    if (entry.kit !== payload.kit) return line;
    if (entry.kitVersionAtUpdate) return line; // already tagged
    entry.kitVersionAtUpdate = payload.toVersion;
    entry.kitVersionAtUpdateTs = stamp;
    if (typeof payload.lifecycleRunId === 'string') {
      entry.taggedByLifecycleRunId = payload.lifecycleRunId;
    }
    tagged += 1;
    return JSON.stringify(entry);
  });

  if (tagged === 0) return 0;

  try {
    writeQueueAtomic(queueFile, taggedLines.join('\n'));
  } catch {
    return 0; // fail-open
  }
  return tagged;
}

/**
 * Subscriber registration entry point per A4.5 loader contract.
 * Only fires for postUpdate; the registry should contain exactly one entry
 * for this subscriber with event="postUpdate".
 */
module.exports = function register(lifecycle, entry) {
  if (!entry || entry.event !== TARGET_EVENT) return;
  const claudeDir = resolveClaudeDir();
  if (!claudeDir) return;
  lifecycle.subscribe(
    TARGET_EVENT,
    (payload) => {
      try {
        tagQueueEntries(claudeDir, payload);
      } catch {
        // fail-open per A3 contract
      }
    },
    {
      priority: typeof entry.priority === 'number' ? entry.priority : 100,
      subscriberId: typeof entry.subscriberId === 'string' ? entry.subscriberId : 'lesson-version-tagger',
    }
  );
};

// Test exports — implementation detail, not public API.
module.exports._tagQueueEntries = tagQueueEntries;
module.exports._resolveClaudeDir = resolveClaudeDir;
module.exports._QUEUE_FILENAME = QUEUE_FILENAME;
