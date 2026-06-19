#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * generic-agent-detector.cjs — PreToolUse:Agent hook
 *
 * Auto-detects when the assistant spawns a generic catch-all agent
 * (`general-purpose`, `claude`) instead of a specific T1K agent.
 *
 * The premise (per `~/.claude/rules/orchestration-rules.md` + agent registry):
 * every task should map to a specific agent (`t1k-planner`, `t1k-brainstormer`,
 * `t1k-fullstack-developer`, `t1k-debugger`, etc.). Falling back to
 * `general-purpose` means EITHER (a) the right specific agent isn't installed,
 * OR (b) the assistant didn't bother routing. Both are bugs worth surfacing:
 *
 *   (a) → kit-content gap: file a skill-bug so the missing agent gets shipped
 *   (b) → routing gap: file a skill-bug so the routing protocol gets tighter
 *
 * Pipeline (mirrors workflow-failure-detector.cjs):
 *   opt-out guard → feature flag → read tool_input.subagent_type →
 *   if subagent_type ∈ GENERIC_TYPES → fingerprint + 7-day TTL dedup →
 *   rate-limit (3/session) → append `[t1k:skill-bug]` to
 *   pending-skill-updates.jsonl → emit stdout marker → exit 0.
 *
 * NEVER blocks: this hook always exits 0. The assistant's tool call proceeds
 * regardless. The hook only OBSERVES.
 *
 * Fail-open: any exception → exit 0. Crashes log to
 * ~/.claude/.generic-agent-detector.log.
 *
 * Design note (AI-driven design):
 *   This hook emits FACTS (which agent was spawned, with what description, in
 *   what context). It does NOT decide what the "right" specific agent should
 *   have been — that's the queue-processor + sub-agent's job, which has the
 *   full kit registry to consult. No hardcoded mapping here.
 *
 * Opt-out:
 *   - Touch `~/.claude/.opt-out-generic-agent-detector`
 *   - OR set env `T1K_DISABLE_GENERIC_AGENT_DETECTOR=1`
 *   - OR set feature flag `features.detectGenericAgents: false` in
 *     `.claude/t1k-config-core.json`
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const {
  parseHookStdin,
  isTelemetryEnabled,
  ensureTelemetryDir,
  findProjectRoot,
  resolveClaudeDir,
  readFeatureFlag,
  T1K,
} = require('./telemetry-utils.cjs');

const { logHook, createHookTimer } = require('./hook-logger.cjs');
const { buildIndex, suggestAgent } = require('./lib/agent-routing-index.cjs');

// Generic catch-all agent types. If a specific T1K agent exists for the task,
// using one of these is a routing gap or kit-content gap — both worth surfacing.
//
// `Explore`, `Plan`, `claude-code-guide`, `statusline-setup`, `t1k-mcp-manager`,
// and any `t1k-*` agent are SPECIFIC and NOT flagged.
const GENERIC_TYPES = new Set(['general-purpose', 'claude']);

const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const CACHE_FILENAME = '.generic-agent-detector-cache.json';
const RATE_DIR_NAME = 't1k-generic-agent-rate';
const DEFAULT_MAX_PER_SESSION = 3;
const DEFAULT_DEDUP_TTL_DAYS = 7;
const FEATURE_FLAG = 'detectGenericAgents';
const OPT_OUT_FILE = '.opt-out-generic-agent-detector';
const ENV_DISABLE = 'T1K_DISABLE_GENERIC_AGENT_DETECTOR';

// Default denylist of description prefixes that mark synthetic / test spawns.
// Matches are case-insensitive, prefix-only, applied after trimming whitespace.
// Override or extend via `features.genericAgentDetectorTestPrefixes` (array of
// strings) in any `.claude/t1k-config-*.json` fragment.
const DEFAULT_TEST_PREFIXES = [
  'test',
  'smoke',
  'smoke test',
  'hook-test',
  '[debug]',
  '[smoke]',
  '[test]',
];

function readTestPrefixes(claudeDir) {
  if (!claudeDir) return DEFAULT_TEST_PREFIXES;
  try {
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const cf of files) {
      try {
        const c = JSON.parse(fs.readFileSync(path.join(claudeDir, cf), 'utf8'));
        const v = c.features && c.features.genericAgentDetectorTestPrefixes;
        if (Array.isArray(v)) {
          return v.filter(x => typeof x === 'string' && x.length > 0);
        }
      } catch { /* skip unreadable fragment */ }
    }
  } catch { /* no claudeDir or unreadable */ }
  return DEFAULT_TEST_PREFIXES;
}

function matchesTestPrefix(description, prefixes) {
  if (typeof description !== 'string' || !description) return false;
  const norm = description.trim().toLowerCase();
  for (const p of prefixes) {
    if (norm.startsWith(String(p).toLowerCase())) return true;
  }
  return false;
}

function defaultGlobalClaudeDir() {
  const home = os.homedir();
  return path.join(home, '.claude');
}

function computeSessionId() {
  // Reuse CLAUDE_SESSION_ID if present, otherwise derive from PPID + start time
  if (process.env.CLAUDE_SESSION_ID) return process.env.CLAUDE_SESSION_ID;
  return `pid-${process.ppid}-${Date.now()}`;
}

function logCrash(err) {
  try {
    const logPath = path.join(defaultGlobalClaudeDir(), '.generic-agent-detector.log');
    const line = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(logPath, line);
  } catch (_e) { /* nothing we can do */ }
}

function isOptedOut() {
  if (process.env[ENV_DISABLE] === '1') return true;
  try {
    if (fs.existsSync(path.join(defaultGlobalClaudeDir(), OPT_OUT_FILE))) return true;
  } catch (_e) { /* ok */ }
  return false;
}

function sanitizeDescription(desc, cwd, home) {
  if (typeof desc !== 'string') return '';
  let out = desc;
  if (cwd) out = out.split(cwd).join('<cwd>');
  if (home) out = out.split(home).join('<home>');
  // Strip long token-looking strings (>=20 chars alnum) just in case
  out = out.replace(/\b[A-Za-z0-9_-]{20,}\b/g, '<token>');
  return out.slice(0, 200);
}

function main() {
  const timer = createHookTimer('generic-agent-detector');

  try {
    if (isOptedOut()) {
      timer.end({ outcome: 'skip', note: 'opted-out' });
      return 0;
    }

    if (!isTelemetryEnabled()) {
      timer.end({ outcome: 'skip', note: 'telemetry-disabled' });
      return 0;
    }

    const claudeDir = resolveClaudeDir();
    if (!claudeDir) {
      timer.end({ outcome: 'skip', note: 'no-claude-dir' });
      return 0;
    }

    const flagEnabled = readFeatureFlag(claudeDir, FEATURE_FLAG, true);
    if (!flagEnabled) {
      timer.end({ outcome: 'skip', note: 'feature-flag-off' });
      return 0;
    }

    const hookData = parseHookStdin();
    if (!hookData || hookData.tool_name !== 'Agent') {
      timer.end({ outcome: 'skip', note: 'not-agent-tool' });
      return 0;
    }

    const toolInput = hookData.tool_input || {};
    const subagentType = toolInput.subagent_type;
    if (!subagentType || !GENERIC_TYPES.has(subagentType)) {
      timer.end({ outcome: 'skip', note: 'specific-agent' });
      return 0;
    }

    const description = String(toolInput.description || '<no description>');
    const cwd = process.cwd();
    const home = os.homedir() || '';
    const projectRoot = findProjectRoot();
    const sanitizedDesc = sanitizeDescription(description, cwd, home);

    // Test-prefix denylist: skip obvious synthetic / smoke-test spawns so they
    // don't pollute the skill-bug queue. Configurable via
    // `features.genericAgentDetectorTestPrefixes` in t1k-config-*.json (#343).
    const testPrefixes = readTestPrefixes(claudeDir);
    if (matchesTestPrefix(description, testPrefixes)) {
      logHook('generic-agent-detector', {
        drop: 'test-prefix',
        subagentType,
        descPrefix: sanitizedDesc.slice(0, 40),
      });
      timer.end({ outcome: 'skip', note: 'test-prefix-denylist' });
      return 0;
    }

    // #504 — DATA-DRIVEN routing WARN (never blocks). When the task description
    // matches a specialized T1K agent (keywords sourced from t1k-routing-*.json
    // roles + agent .md descriptions — no hardcoded keyword→agent map), surface
    // a non-blocking warning BEFORE the telemetry dedup/rate-limit gates so the
    // assistant + user always see the suggestion even when the skill-bug queue
    // entry is deduped. Best-effort: any failure here is swallowed (fail-open).
    let suggestion = null;
    try {
      const agentsDir = path.join(claudeDir, 'agents');
      const index = buildIndex(claudeDir, agentsDir);
      suggestion = suggestAgent(description, index);
      // Don't suggest a generic type back to itself.
      if (suggestion && GENERIC_TYPES.has(suggestion.agent)) suggestion = null;
    } catch (e) {
      logCrash(e);
    }
    if (suggestion) {
      console.warn(
        `[t1k:agent-routing-warn] "${subagentType}" spawned for a task a specialized agent covers — ` +
        `consider "${suggestion.agent}" (matched: ${suggestion.hits.slice(0, 4).join(', ')}). ` +
        `This is a warning only; the spawn proceeds. Route via the narrowest specialist ` +
        `(rules/orchestration-rules.md "Task-Type → Agent Routing").`
      );
      logHook('generic-agent-detector', {
        routingWarn: 1,
        subagentType,
        suggested: suggestion.agent,
        hits: suggestion.hits.slice(0, 6),
      });
    }

    // Fingerprint based on (subagent_type, sanitized description prefix) so the
    // same agent spawned for the same kind of task dedups within the TTL.
    const cachePath = path.join(defaultGlobalClaudeDir(), CACHE_FILENAME);
    const prevCacheEnv = process.env.T1K_KIT_ERROR_CACHE_PATH;
    process.env.T1K_KIT_ERROR_CACHE_PATH = cachePath;
    const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

    const fp = fingerprint(
      { tool: 'generic-agent', cmd: subagentType, stderrHead: sanitizedDesc.slice(0, 80) },
      { reason: 'generic-agent-spawn', originKit: 'theonekit-core' }
    );
    const dedup = checkAndRecord(fp, {
      reason: 'generic-agent-spawn',
      originKit: 'theonekit-core',
      maxAgeDays: DEFAULT_DEDUP_TTL_DAYS,
    });

    if (dedup.isDuplicate) {
      if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
      else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;
      logHook('generic-agent-detector', { drop: 'duplicate', fp, subagentType });
      timer.end({ outcome: 'skip', note: 'duplicate' });
      return 0;
    }

    // Per-session rate limit (3 unique entries per session)
    const sessionId = computeSessionId();
    const rateDir = path.join(os.tmpdir(), RATE_DIR_NAME);
    if (!fs.existsSync(rateDir)) {
      try { fs.mkdirSync(rateDir, { recursive: true }); } catch { /* ok */ }
    }
    const counterFile = path.join(rateDir, `${sessionId}.count`);
    let sessionCount = 0;
    try {
      if (fs.existsSync(counterFile)) {
        sessionCount = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
      }
    } catch { /* ok */ }
    if (sessionCount >= DEFAULT_MAX_PER_SESSION) {
      if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
      else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;
      logHook('generic-agent-detector', { drop: 'rate-limited', subagentType });
      timer.end({ outcome: 'skip', note: 'rate-limited' });
      return 0;
    }

    const telemetryDir = ensureTelemetryDir();
    const queuePath = path.join(telemetryDir, QUEUE_FILENAME);
    const nowIso = new Date().toISOString();

    const entry = {
      ts: nowIso,
      type: 'skill-bug',
      fingerprint: fp,
      kit: 'theonekit-core',
      skill: `agent-routing:${subagentType}`,
      payload: {
        bug: `generic catch-all agent "${subagentType}" was spawned — should have used a specific T1K agent for this task`,
        evidence: `description: "${sanitizedDesc}"; cwd: ${path.basename(projectRoot || cwd)}`,
        pattern: 'generic-agent-spawn',
        agentType: subagentType,
        description: sanitizedDesc,
        sessionId,
        remediation: `Either (a) route to an existing specific agent (check .claude/agents/ for t1k-* matches), OR (b) if no specific agent fits, propose creating one in the owning kit (likely theonekit-core for generic dev tasks, or a domain-specific kit otherwise).`,
      },
      sessionId,
      submitted: false,
      submittedAt: null,
      prUrl: null,
      issueUrl: null,
      source: 'generic-agent-detector',
    };

    try {
      fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
    } catch (e) {
      logCrash(e);
    }

    try { fs.writeFileSync(counterFile, String(sessionCount + 1)); } catch { /* ok */ }

    // Restore cache env
    if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
    else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;

    // Visible marker — appears in tool output, signals the assistant + user
    console.log(
      `[t1k:generic-agent-detected] agent=${subagentType} desc="${sanitizedDesc.slice(0, 60)}" → queued skill-bug fp=${fp.slice(0, 8)}`
    );

    logHook('generic-agent-detector', {
      queued: 1,
      subagentType,
      fp,
      sessionCount: sessionCount + 1,
    });
    timer.end({ outcome: 'queued', note: subagentType });
    return 0;
  } catch (err) {
    logCrash(err);
    try { timer.end({ outcome: 'error', note: String(err && err.message || err) }); } catch { /* ok */ }
    return 0;
  }
}

process.exit(main());
