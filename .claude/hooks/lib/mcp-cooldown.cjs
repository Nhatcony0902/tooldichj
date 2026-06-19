#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * mcp-cooldown.cjs — 7-day per-server cooldown for tier=optional MCP reminders.
 *
 * check-mcp-health.cjs reminds about unregistered MCP servers every SessionStart.
 * For `required`/`recommended` tiers that's correct (the kit needs them). For
 * `optional` servers (the user may never want them), an every-session nag is
 * noise — so an unregistered optional server is reminded once, then suppressed
 * for 7 days. required/recommended are NEVER cooled here.
 *
 * State file: ~/.claude/.t1k-mcp-cooldown.json (mode 0o600)
 * Shape: { "<scope>:<name>": <last-reminded-epoch-ms>, ... }
 *   Keyed by scope+name so a user-scope and a project-scope server of the same
 *   name cool down independently (mirrors the per-scope keying in
 *   lib/update-check-cache.cjs, core#449).
 *
 * Write protocol: temp-file + atomic rename (POSIX-safe under concurrent
 * SessionStart hooks). Self-pruning: entries not seen in 90 days are dropped on
 * write so the file can't grow unbounded.
 *
 * Fail-open: any read/parse error ⇒ treat as "no cooldown" (remind) and rewrite
 * fresh. A corrupt state file never suppresses a reminder and never throws.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_FILENAME = '.t1k-mcp-cooldown.json';
const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;   // 7 days
const PRUNE_MS = 90 * 24 * 60 * 60 * 1000;     // 90 days

function statePath() {
  return path.join(os.homedir(), '.claude', STATE_FILENAME);
}

/** Compose the cooldown key for an entry. scope defaults to "user". */
function cooldownKey(scope, name) {
  return `${scope || 'user'}:${String(name)}`;
}

function readState() {
  const p = statePath();
  if (!fs.existsSync(p)) return {};
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {};
  } catch {
    return {}; // fail-open — corrupt file treated as empty (remind), rewritten on next update
  }
}

function writeState(data, now = Date.now()) {
  const p = statePath();
  const dir = path.dirname(p);
  // Prune entries not seen in 90d so the file stays bounded.
  const pruned = {};
  for (const [k, ts] of Object.entries(data)) {
    if (typeof ts === 'number' && now - ts < PRUNE_MS) pruned[k] = ts;
  }
  try {
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(pruned, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, p);
    try { fs.chmodSync(p, 0o600); } catch { /* best-effort */ }
  } catch { /* fail-open */ }
}

/**
 * Is the optional reminder for <scope>:<name> currently in cooldown?
 * @param {string} scope  "user" | "project" (default "user")
 * @param {string} name   server name
 * @param {number} [now]  injectable clock for tests
 * @returns {boolean} true ⇒ suppress (within 7d window); false ⇒ remind
 */
function inCooldown(scope, name, now = Date.now()) {
  const state = readState();
  const last = state[cooldownKey(scope, name)];
  if (typeof last !== 'number') return false; // never reminded / corrupt ⇒ remind
  return now - last < COOLDOWN_MS;
}

/**
 * Record that the optional reminder for <scope>:<name> just fired (resets the
 * 7-day window). Pruning happens on write.
 * @param {string} scope  "user" | "project" (default "user")
 * @param {string} name   server name
 * @param {number} [now]  injectable clock for tests
 */
function recordReminded(scope, name, now = Date.now()) {
  const state = readState();
  state[cooldownKey(scope, name)] = now;
  writeState(state, now);
}

module.exports = {
  inCooldown,
  recordReminded,
  cooldownKey,
  COOLDOWN_MS,
  // exported for tests:
  _internal: { statePath, readState, writeState, PRUNE_MS },
};
