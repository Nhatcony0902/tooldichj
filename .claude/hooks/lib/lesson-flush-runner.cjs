#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * lesson-flush-runner.cjs — End-of-session detached flush for queued markers.
 *
 * Spawned (detached + unref) by `lesson-collector.cjs` Stop hook AFTER it
 * appends new markers to `pending-skill-updates.jsonl`. Closes the gap where
 * a Stop fires but no subsequent UserPromptSubmit ever runs (single-shot CLI
 * runs, end-of-day session close), which left queued entries stranded until
 * the NEXT session — see issue #334.
 *
 * Scope (intentionally narrow):
 *   - type=skill-bug → gh issue create on `theonekit-<kit>` (minimal template,
 *                       no AI-driven pre-triage)
 *   - type=mcp-gap   → gh issue create on the MCP fork repo resolved from
 *                       t1k-config-<kit>.json mcp.required[].fork.issueRepo
 *   - type=lesson    → SKIP (PR drafting requires AI; queue path remains the
 *                       authoritative fix and the next session's UserPromptSubmit
 *                       handles it)
 *
 * After a successful `gh issue create`, appends a writeback row
 *   { fingerprint, submitted: true, issueUrl, autoFlush: true }
 * so `lesson-queue-processor.cjs` drops the original on the next tick.
 *
 * Fail-modes (all silent — never block, never throw):
 *   - gh not on PATH / not authenticated → exit 0, leave queue intact
 *   - `gh issue create` fails (rate limit, transient) → exit 0, leave queue intact
 *   - file I/O errors → exit 0
 *
 * Invocation: `node lesson-flush-runner.cjs <queue-path>`
 */
'use strict';

const fs = require('fs');
const { execFileSync } = require('child_process');

function hasGhAuth() {
  try {
    execFileSync('gh', ['auth', 'status'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'ignore', 'ignore'],
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

function readQueue(queuePath) {
  if (!fs.existsSync(queuePath)) return [];
  try {
    return fs.readFileSync(queuePath, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function alreadySubmitted(entries) {
  const set = new Set();
  for (const e of entries) {
    if (e && e.submitted === true && e.fingerprint) set.add(e.fingerprint);
  }
  return set;
}

function buildSkillBugIssue(entry) {
  const kit = entry.kit || 'unknown';
  const skill = entry.skill || 'unknown';
  const bug = (entry.payload && entry.payload.bug) || '(missing)';
  const evidence = (entry.payload && entry.payload.evidence) || '';
  const repo = `The1Studio/theonekit-${kit}`;
  const title = `fix(${kit}): ${bug.slice(0, 60)}`;
  const body = [
    '## Skill/Agent Issue (auto-filed by lesson-flush-runner)',
    '',
    `**Affected**: \`${skill}\``,
    `**Kit**: \`theonekit-${kit}\``,
    '**Type**: skill-bug',
    '',
    '### Description',
    bug,
    '',
    '### Evidence',
    '```',
    evidence,
    '```',
    '',
    '### Fingerprint',
    `\`${entry.fingerprint}\``,
    '',
    '_Filed automatically at session end by `lesson-flush-runner.cjs`. ' +
    'Pre-triage investigation NOT performed — re-triage on review. See #334._',
  ].join('\n');
  return { repo, title, body, label: 'skill-bug' };
}

function buildMcpGapIssue(entry) {
  const kit = entry.kit || 'unknown';
  const tool = entry.skill || 'unknown';
  const gap = (entry.payload && entry.payload.gap) || '(missing)';
  const evidence = (entry.payload && entry.payload.evidence) || '';
  // Repo resolution mirrors lesson-queue-processor's resolveMcpIssueRepo
  // fallback: file on the kit repo if MCP fork repo not resolvable here.
  const repo = `The1Studio/theonekit-${kit}`;
  const title = `mcp-gap(${tool}): ${gap.slice(0, 60)}`;
  const body = [
    '## MCP Gap (auto-filed by lesson-flush-runner)',
    '',
    `**Tool**: \`${tool}\``,
    `**Kit**: \`theonekit-${kit}\``,
    '',
    '### Gap',
    gap,
    '',
    '### Evidence',
    '```',
    evidence,
    '```',
    '',
    '### Fingerprint',
    `\`${entry.fingerprint}\``,
    '',
    '_Filed automatically at session end by `lesson-flush-runner.cjs`. ' +
    'MCP fork repo resolution skipped — re-route to fork repo on triage if appropriate. See #334._',
  ].join('\n');
  return { repo, title, body, label: 'mcp-gap' };
}

function createIssue({ repo, title, body, label }) {
  try {
    const out = execFileSync(
      'gh',
      ['issue', 'create', '--repo', repo, '--title', title, '--body', body, '--label', label],
      { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true }
    );
    const url = (out || '').trim().split('\n').pop();
    return /^https?:\/\//.test(url) ? url : null;
  } catch { return null; }
}

function appendWriteback(queuePath, fingerprint, issueUrl) {
  try {
    const row = JSON.stringify({
      fingerprint, submitted: true, issueUrl, autoFlush: true,
      ts: new Date().toISOString(),
    });
    fs.appendFileSync(queuePath, row + '\n');
    return true;
  } catch { return false; }
}

function main() {
  try {
    const queuePath = process.argv[2];
    if (!queuePath || !fs.existsSync(queuePath)) return 0;
    if (!hasGhAuth()) return 0;

    const entries = readQueue(queuePath);
    const submitted = alreadySubmitted(entries);
    let filed = 0;

    for (const e of entries) {
      if (!e || !e.fingerprint || e.submitted) continue;
      if (submitted.has(e.fingerprint)) continue;
      if (e.dryRun) continue;

      let spec = null;
      if (e.type === 'skill-bug') spec = buildSkillBugIssue(e);
      else if (e.type === 'mcp-gap') spec = buildMcpGapIssue(e);
      else continue; // lesson markers stay queued for AI sync-back

      const url = createIssue(spec);
      if (url && appendWriteback(queuePath, e.fingerprint, url)) {
        filed++;
        submitted.add(e.fingerprint);
      }
    }

    return filed > 0 ? 0 : 0;
  } catch { return 0; }
}

if (require.main === module) {
  process.exit(main());
}

module.exports = {
  buildSkillBugIssue,
  buildMcpGapIssue,
  readQueue,
  alreadySubmitted,
  main,
};
