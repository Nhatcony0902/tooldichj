#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * sync-back-rollup.cjs — Stop hook: consolidate per-edit sync-back suggestions.
 *
 * Closes the "per-edit nag" half of #273. The companion PostToolUse hook
 * (kit-owned-file-modified.cjs) emits one `[t1k:sync-back-suggested]` marker
 * per edit AND stages each entry in `.claude/telemetry/sync-back-suggestions-<sessionKey>.jsonl`.
 *
 * At Stop, this rollup:
 *   1. Reads the per-session queue file
 *   2. De-duplicates by file path (latest entry wins)
 *   3. Emits ONE summary line:
 *        [t1k:sync-back-rollup count=<N> kits="<k1>,<k2>" files="<f1>,<f2>,..."]
 *      plus a human-readable second line nudging /t1k:sync-back
 *   4. Deletes the queue file so the next session starts fresh
 *
 * Fail-open: any exception → exit 0 (never block session end).
 *
 * Reuses (no duplicate utilities):
 *   - parseHookStdin, findProjectRoot, ensureTelemetryDir, computeTeammateSessionKey,
 *     isTeammateContext from telemetry-utils.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const {
    parseHookStdin,
    ensureTelemetryDir,
    computeTeammateSessionKey,
    isTeammateContext,
  } = require('./telemetry-utils.cjs');

  // Stop hook may receive empty stdin; parseHookStdin returns null then — that's fine.
  const hookData = parseHookStdin();

  // Skip teammate (SubagentStop) contexts — only the parent's Stop hook
  // should summarize so we don't double-emit per teammate.
  if (isTeammateContext(hookData)) process.exit(0);

  const telemetryDir = ensureTelemetryDir();
  const sessionKey = computeTeammateSessionKey();
  const queuePath = path.join(telemetryDir, `sync-back-suggestions-${sessionKey}.jsonl`);

  if (!fs.existsSync(queuePath)) process.exit(0); // No edits this session

  const raw = fs.readFileSync(queuePath, 'utf8');
  const entries = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      entries.push(JSON.parse(trimmed));
    } catch { /* skip malformed line */ }
  }

  if (entries.length === 0) {
    safeUnlink(queuePath);
    process.exit(0);
  }

  // Dedup by file path (keep latest entry per file).
  const byFile = new Map();
  for (const e of entries) {
    if (e && e.file) byFile.set(e.file, e);
  }
  const deduped = Array.from(byFile.values());

  const kits = Array.from(new Set(deduped.map(e => e.kit).filter(Boolean))).sort();
  const files = deduped.map(e => e.file);
  const count = deduped.length;

  // Truncate the files list in the marker to keep stdout frame bounded.
  // Full list is available in the queue file pre-delete; consumers can re-read
  // if they need the exhaustive set.
  const MAX_FILES_IN_MARKER = 10;
  const filesForMarker = files.slice(0, MAX_FILES_IN_MARKER);
  const truncated = files.length > MAX_FILES_IN_MARKER ? `,+${files.length - MAX_FILES_IN_MARKER}-more` : '';

  console.log(
    `[t1k:sync-back-rollup count=${count} kits="${kits.join(',')}" files="${filesForMarker.join(',')}${truncated}"]`
  );
  console.log(
    `You edited ${count} kit-owned file${count === 1 ? '' : 's'} in this session (${kits.join(', ')}). ` +
    `Recommend \`/t1k:sync-back\` to propagate to origin kit ${kits.length === 1 ? 'repo' : 'repos'}.`
  );

  safeUnlink(queuePath);
  process.exit(0);
} catch {
  process.exit(0); // Fail-open
}

function safeUnlink(p) {
  try { fs.unlinkSync(p); } catch { /* non-critical */ }
}
