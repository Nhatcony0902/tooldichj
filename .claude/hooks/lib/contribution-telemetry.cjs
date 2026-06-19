#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * contribution-telemetry.cjs — Shared contribution-score telemetry primitives.
 *
 * SSOT for the deterministic half of the contribution-score pipeline, consumed by:
 *   - hooks/contribution-capture.cjs  (PostToolUse:Bash safeguard — DETECTION)
 *   - scripts/contribution-flush.cjs  (flush script — POST + disposition + file IO)
 *
 * The AI half (the 1–5 rubric judgment) lives in the t1k:contribution-flush and
 * t1k:contribution-score SKILLS — a script cannot judge quality. This lib only
 * carries the mechanical, deterministic, unit-testable parts:
 *   - T1K repo gate
 *   - gh-command ref extraction (merge / close)
 *   - gh-output ref extraction (create — URL printed on stdout)
 *   - endpoint + cloud-flag resolution
 *   - JSONL read/write
 *   - worker POST + disposition (recorded / keep / drop)
 *
 * History: extracted verbatim (logic-preserving) from the retired
 * contribution-score-flush.cjs Stop hook + transcript backstop. The per-command
 * capture hook replaces the end-of-session transcript scrape; the flush skill
 * replaces the Stop-hook's default-score-3 POST with a real AI rubric score.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { readTelemetryEndpoint } = require('../telemetry-utils.cjs');

// ── Tunable constants (carried over from the retired flush hook) ─────────────
const MAX_ATTEMPTS = 20;            // drop a 403-retry entry after this many tries
const MAX_AGE_DAYS = 14;            // drop a 403-retry entry older than this
const RECORDED_PRUNE_DAYS = 30;     // prune recorded-ledger entries older than this
const POST_TIMEOUT_MS = 8000;
const TRACKING_FILE = 'contribution-tracking.jsonl';   // under <claudeDir>/telemetry/
const RECORDED_FILE = 'contribution-recorded.jsonl';   // under <claudeDir>/telemetry/
const NUDGE_THRESHOLD = 5;          // capture hook nudges once pending ≥ this
// unity-mcp / cocos-mcp-server are studio-maintained MCP forks (no shared prefix)
// and are creditable per the worker's ALLOWED_REPOS; added as literal alternatives.
const T1K_REPO_RE = /^The1Studio\/(theonekit-[A-Za-z0-9._-]+|t1k-[A-Za-z0-9._-]+|unity-mcp|cocos-mcp-server)$/;
// URL form of the same gate, capturing owner/repo + kind + number.
const T1K_URL_RE = /https?:\/\/github\.com\/(The1Studio\/(?:theonekit-[A-Za-z0-9._-]+|t1k-[A-Za-z0-9._-]+|unity-mcp|cocos-mcp-server))\/(issues|pull)\/(\d+)/g;

// ── Endpoint resolution ───────────────────────────────────────────────────────
/**
 * Resolve the telemetry base endpoint (trailing `/ingest` stripped — the
 * contributions API lives at `<EP>/api/contributions`). Order:
 *   1. env T1K_TELEMETRY_ENDPOINT
 *   2. project .claude/t1k-config-core.json telemetry.cloud.endpoint
 *   3. global ~/.claude/t1k-config-core.json (same field)
 * Returns null when none configured.
 */
function resolveContributionsBase(projectRoot, home) {
  let raw = readTelemetryEndpoint(projectRoot); // handles env + project config
  if (!raw && home) {
    try {
      const globalCfg = path.join(home, '.claude', 't1k-config-core.json');
      if (fs.existsSync(globalCfg)) {
        const c = JSON.parse(fs.readFileSync(globalCfg, 'utf8'));
        raw = c.telemetry?.cloud?.endpoint || null;
      }
    } catch { /* fail-open */ }
  }
  if (!raw) return null;
  return raw.replace(/\/ingest\/?$/, '').replace(/\/$/, '');
}

/** Check telemetry.cloud.enabled across project + global config (default true). */
function isCloudTelemetryEnabled(projectRoot, home) {
  const read = (p) => {
    try {
      if (!fs.existsSync(p)) return undefined;
      const c = JSON.parse(fs.readFileSync(p, 'utf8'));
      return c.telemetry?.cloud?.enabled;
    } catch { return undefined; }
  };
  const proj = read(path.join(projectRoot, '.claude', 't1k-config-core.json'));
  if (proj === false) return false;
  if (proj === true) return true;
  const glob = home ? read(path.join(home, '.claude', 't1k-config-core.json')) : undefined;
  if (glob === false) return false;
  return true; // default-on / fail-open
}

// ── JSONL helpers ──────────────────────────────────────────────────────────────
function readJsonl(filePath) {
  try {
    if (!fs.existsSync(filePath)) return [];
    return fs.readFileSync(filePath, 'utf8')
      .split('\n')
      .map(l => l.trim())
      .filter(Boolean)
      .map(l => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean);
  } catch { return []; }
}

function writeJsonl(filePath, rows) {
  try {
    if (!rows.length) {
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
      return;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, rows.map(r => JSON.stringify(r)).join('\n') + '\n');
  } catch { /* fail-open */ }
}

function appendJsonl(filePath, row) {
  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(filePath, JSON.stringify(row) + '\n');
  } catch { /* fail-open */ }
}

// ── Detection — gh command (merge / close) ────────────────────────────────────
/**
 * Extract terminal triage refs from a single shell command string. A command may
 * chain several gh calls with && / || / ; / newlines. Returns
 * [{ ref_url, repo, kind, action }] for `gh pr|issue merge|close`.
 *
 * `gh ... create` is intentionally NOT handled here — at command time the created
 * artifact has no number yet; its URL is printed on stdout and captured by
 * refsFromOutput() instead.
 *
 * @param {string} cmd shell command line
 * @param {{currentRepo?:string, currentPr?:string|number}} [ctx]
 *   Fallbacks for the numberless/repoless admin-merge form
 *   (`gh pr merge --admin --squash --delete-branch`), resolved by the caller from
 *   `gh repo view` / `gh pr view`.
 */
function refsFromCommand(cmd, ctx) {
  const refs = new Map();
  if (typeof cmd !== 'string' || cmd.indexOf('gh ') === -1) return [];
  const ctxRepo = ctx && typeof ctx.currentRepo === 'string' ? ctx.currentRepo : null;
  const ctxPr = ctx && (typeof ctx.currentPr === 'string' || typeof ctx.currentPr === 'number')
    ? String(ctx.currentPr).replace(/^#/, '')
    : null;
  const segments = cmd.split(/&&|\|\||;|\n/);
  for (const seg of segments) {
    const m = seg.match(/\bgh\s+(pr|issue)\s+(merge|close)\b/);
    if (!m) continue;
    const kind = m[1];   // pr | issue
    const action = m[2]; // merge | close

    const repoMatch = seg.match(/--repo[=\s]+(\S+)/);
    const repo = repoMatch ? repoMatch[1].replace(/^["']|["']$/g, '') : ctxRepo;
    if (!repo || !T1K_REPO_RE.test(repo)) continue;

    const n = extractPositionalNumber(seg, action) || ctxPr;
    if (!n) continue;

    const segment = kind === 'pr' ? 'pull' : 'issues';
    const ref_url = `https://github.com/${repo}/${segment}/${n}`;
    if (!refs.has(ref_url)) refs.set(ref_url, { ref_url, repo, kind, action });
  }
  return [...refs.values()];
}

/**
 * Extract a positional PR/issue number from a `gh pr|issue merge|close` segment.
 * Handles the number BEFORE flags (`gh pr merge 54 --admin`) and AFTER flags
 * (`gh pr merge --admin --squash 54`). Flag values (e.g. `--repo owner/x`) are
 * skipped so the repo slug's digits are never mistaken for the number.
 */
function extractPositionalNumber(seg, action) {
  const verbRe = new RegExp(`\\bgh\\s+(?:pr|issue)\\s+${action}\\b`);
  const verbMatch = verbRe.exec(seg);
  if (!verbMatch) return null;
  const tail = seg.slice(verbMatch.index + verbMatch[0].length);
  const tokens = tail.trim().split(/\s+/).filter(Boolean);
  const VALUE_FLAGS = new Set(['--repo', '-R', '--body', '-b', '--subject', '-t', '--match-head-commit']);
  for (let i = 0; i < tokens.length; i++) {
    const tok = tokens[i];
    if (tok.startsWith('-')) {
      if (tok.includes('=')) continue;
      if (VALUE_FLAGS.has(tok)) { i++; continue; }
      continue; // valueless flag (--admin, --squash, --delete-branch)
    }
    const numMatch = tok.match(/^#?(\d+)$/);
    if (numMatch) return numMatch[1];
  }
  return null;
}

// ── Detection — gh output (create) ────────────────────────────────────────────
/**
 * True when a command contains a `gh issue|pr create`. Used to gate
 * refsFromOutput() so we only treat T1K URLs in stdout as "created artifact"
 * when the command was actually a create.
 */
function isCreateCommand(cmd) {
  return typeof cmd === 'string' && /\bgh\s+(?:pr|issue)\s+create\b/.test(cmd);
}

/**
 * Extract created-artifact refs from a `gh ... create` command's stdout. `gh`
 * prints the canonical URL of the new issue/PR; we pull every T1K URL out of the
 * output. Returns [{ ref_url, repo, kind, action:'create' }] (kind from the URL
 * path: pull → 'pr', issues → 'issue'). Non-T1K URLs are ignored by the regex.
 */
function refsFromOutput(outputText) {
  const refs = new Map();
  if (!outputText || typeof outputText !== 'string') return [];
  T1K_URL_RE.lastIndex = 0;
  let m;
  while ((m = T1K_URL_RE.exec(outputText)) !== null) {
    const repo = m[1];
    const kind = m[2] === 'pull' ? 'pr' : 'issue';
    const n = m[3];
    const ref_url = `https://github.com/${repo}/${m[2]}/${n}`;
    if (!refs.has(ref_url)) refs.set(ref_url, { ref_url, repo, kind, action: 'create' });
  }
  return [...refs.values()];
}

// ── Worker type mapping ────────────────────────────────────────────────────────
/**
 * Map a tracking entry's (kind, action) to the worker contribution `type`.
 *   - create + issue → 'issue'
 *   - create + pr    → 'sync-back-pr'   (best-effort; worker dedups on ref_url, so
 *                       the originating skill's correct-type POST wins if it ran)
 *   - merge | close  → 'triage-backfill'
 */
function workerType(entry) {
  if (entry.action === 'create') return entry.kind === 'issue' ? 'issue' : 'sync-back-pr';
  return 'triage-backfill';
}

// ── POST + disposition ──────────────────────────────────────────────────────────
/** Build the worker POST body from a scored tracking entry. SSOT for body shape. */
function buildPostBody(entry, { user, kit }) {
  const body = {
    user,
    kit: entry.kit || kit,
    repo: entry.repo,
    type: entry.type || workerType(entry),
    ref_url: entry.ref_url,
    ai_score: entry.ai_score,
    ai_rationale: entry.ai_rationale,
  };
  if (entry.evidence_excerpt) body.evidence_excerpt = entry.evidence_excerpt;
  return body;
}

/**
 * Default POST implementation using Node built-in fetch (Node ≥18). Returns
 * { status, reason } where status is the HTTP code (or 0 on network error) and
 * reason is the parsed worker `reason` field if present.
 */
async function defaultPost({ base, token, body }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS);
  try {
    const res = await fetch(`${base}/api/contributions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    let reason = null;
    try { const json = await res.json(); reason = json && (json.reason || null); } catch { /* non-JSON */ }
    return { status: res.status, reason };
  } catch {
    return { status: 0, reason: null }; // network / timeout / abort
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Decide what to do with an entry given a POST result. Pure — unit-testable.
 * @returns {{ disposition: 'drop-recorded'|'drop'|'keep', logReason: string }}
 */
function disposeResult(result, entry, nowMs) {
  const { status, reason } = result || {};
  if (status === 201 || status === 200) {
    return { disposition: 'drop-recorded', logReason: status === 201 ? 'recorded' : 'already_recorded' };
  }
  if (status === 403 && reason === 'triage_requires_closed_artifact') {
    const attempts = (entry.attempts || 0) + 1;
    const firstSeen = entry.first_seen_ts ? new Date(entry.first_seen_ts).getTime() : nowMs;
    const ageDays = (nowMs - firstSeen) / (24 * 60 * 60 * 1000);
    if (attempts > MAX_ATTEMPTS) return { disposition: 'drop', logReason: `dropped: max-attempts(${MAX_ATTEMPTS}) exceeded` };
    if (ageDays > MAX_AGE_DAYS) return { disposition: 'drop', logReason: `dropped: age>${MAX_AGE_DAYS}d` };
    return { disposition: 'keep', logReason: `keep: not-yet-closed attempts=${attempts}` };
  }
  if (status === 0 || status >= 500) {
    return { disposition: 'keep', logReason: `keep: transient(${status})` };
  }
  return { disposition: 'drop', logReason: `drop: terminal(${status}${reason ? '/' + reason : ''})` };
}

module.exports = {
  // constants
  MAX_ATTEMPTS, MAX_AGE_DAYS, RECORDED_PRUNE_DAYS, POST_TIMEOUT_MS,
  TRACKING_FILE, RECORDED_FILE, NUDGE_THRESHOLD, T1K_REPO_RE, T1K_URL_RE,
  // endpoint / config
  resolveContributionsBase, isCloudTelemetryEnabled,
  // jsonl
  readJsonl, writeJsonl, appendJsonl,
  // detection
  refsFromCommand, extractPositionalNumber, isCreateCommand, refsFromOutput,
  // post / dispose
  workerType, buildPostBody, defaultPost, disposeResult,
};
