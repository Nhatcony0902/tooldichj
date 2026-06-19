#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * agent-routing-index.cjs — build a DATA-DRIVEN task-description → specialized
 * agent keyword index from the registry (no hardcoded keyword→agent map).
 *
 * #504 — the `generic-agent-detector` PreToolUse hook needs to WARN (never block)
 * when a generic catch-all agent (`general-purpose`/`claude`) is spawned for a
 * task description that a specialized T1K agent clearly covers. The set of
 * description keywords that imply a specialized agent MUST come from registry
 * files, not a literal map baked into the hook (per `rules/code-conventions.md`
 * "Data-Driven Over Hardcoded" — deleting the registry data disables matching).
 *
 * Two registry sources, merged (highest-priority routing fragment wins on the
 * role→agent mapping):
 *
 *   1. `t1k-routing-*.json` `roles` — the canonical role→agent map. Each role
 *      KEY (e.g. "tester", "docs-manager", "kit-developer") is itself the
 *      authoritative keyword for that agent. We tokenize the role key on
 *      non-alphanumerics and emit each token (and the joined token) as keywords.
 *
 *   2. agent `.md` frontmatter `description` — the SSOT the routing fragment is
 *      generated FROM (see `_generatedFrom`). We harvest the example `user: "…"`
 *      lines (concrete task prompts) and extract their salient verbs/nouns as
 *      additional keywords for that agent.
 *
 * NOTHING in this file enumerates "migrate→fullstack" style literals — every
 * keyword is mechanically derived from registry content. Removing the routing
 * fragment (or the agent .md descriptions) yields an empty index → no warnings.
 *
 * Fail-open / best-effort: any read/parse error on a single source is swallowed;
 * the function returns whatever it could build (possibly empty).
 */
'use strict';

const fs = require('fs');
const path = require('path');

let T1K;
try { ({ T1K } = require('../telemetry-utils.cjs')); } catch { /* optional */ }
const ROUTING_PREFIX = (T1K && T1K.ROUTING_PREFIX) || 't1k-routing-';

// Words too generic to be useful routing signals — excluded from harvested
// keywords. These are language stop-words / ubiquitous dev verbs, NOT a
// keyword→agent map. Their only effect is reducing false matches.
const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'of', 'in', 'on', 'for', 'with', 'this',
  'that', 'use', 'using', 'agent', 'when', 'need', 'you', 'should', 'all', 'any',
  'per', 'into', 'from', 'run', 'make', 'do', 'task', 'code', 'file', 'files',
  'new', 'full', 'report', 'phase', 'plan', 'spec', 'it', 'is', 'are', 'be',
]);

/** Tokenize an identifier or sentence into lowercase alphanumeric word tokens. */
function tokenize(s) {
  if (typeof s !== 'string') return [];
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/**
 * Read the highest-priority role→agent map across all routing fragments in
 * claudeDir. Returns { role: agent } (override-by-priority, mirroring the
 * registry merge rule).
 */
function readRoles(claudeDir) {
  const roles = {};
  const byRolePriority = {};
  if (!claudeDir) return roles;
  let files;
  try {
    files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(ROUTING_PREFIX) && f.endsWith('.json'));
  } catch { return roles; }
  for (const f of files) {
    let frag;
    try { frag = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8')); } catch { continue; }
    const pr = typeof frag.priority === 'number' ? frag.priority : 0;
    const r = frag.roles && typeof frag.roles === 'object' ? frag.roles : {};
    for (const [role, agent] of Object.entries(r)) {
      if (typeof agent !== 'string') continue;
      if (byRolePriority[role] === undefined || pr >= byRolePriority[role]) {
        byRolePriority[role] = pr;
        roles[role] = agent;
      }
    }
  }
  return roles;
}

/** Extract the description frontmatter block text from an agent .md, if present. */
function readAgentDescription(mdPath) {
  let raw;
  try { raw = fs.readFileSync(mdPath, 'utf8'); } catch { return ''; }
  // Frontmatter description may be a block scalar (description: |). Grab the
  // example user prompts — concrete task phrasings are the best keyword source.
  const userLines = [];
  const re = /user:\s*["“]([^"”]+)["”]/gi;
  let m;
  while ((m = re.exec(raw)) !== null) userLines.push(m[1]);
  return userLines.join(' ');
}

/**
 * Build the agent → Set(keywords) index, plus a fast keyword → agent lookup.
 *
 * @param {string} claudeDir resolved .claude dir
 * @param {string} agentsDir directory holding agent .md files (claudeDir/agents)
 * @returns {{ keywordToAgent: Map<string,string>, agents: Set<string> }}
 */
function buildIndex(claudeDir, agentsDir) {
  const keywordToAgent = new Map();
  const agents = new Set();

  const roles = readRoles(claudeDir);
  // role token(s) → agent
  for (const [role, agent] of Object.entries(roles)) {
    agents.add(agent);
    for (const tok of tokenize(role)) {
      if (STOP_WORDS.has(tok) || tok.length < 3) continue;
      if (!keywordToAgent.has(tok)) keywordToAgent.set(tok, agent);
    }
    // The joined role (e.g. "docsmanager") is rarely typed; the per-token keys
    // above already cover "docs"/"manager". Skip the joined form.
  }

  // Harvest example user-prompt keywords from each agent .md whose name is a
  // routing target. Only agents already present in `roles` get description
  // keywords, so a stray .md never injects routing without registry backing.
  let agentFiles = [];
  try {
    agentFiles = fs.readdirSync(agentsDir).filter(f => f.endsWith('.md'));
  } catch { /* no agents dir */ }
  const agentNames = new Set(agents);
  for (const f of agentFiles) {
    const name = f.replace(/\.md$/, '');
    if (!agentNames.has(name)) continue;
    const desc = readAgentDescription(path.join(agentsDir, f));
    for (const tok of tokenize(desc)) {
      if (STOP_WORDS.has(tok) || tok.length < 4) continue;
      // Do not let a description keyword OVERRIDE a role-token keyword (role
      // tokens are more authoritative). Only fill gaps.
      if (!keywordToAgent.has(tok)) keywordToAgent.set(tok, name);
    }
  }

  return { keywordToAgent, agents };
}

/**
 * Given a task description and a prebuilt index, return the best specialized
 * agent suggestion (or null). "Best" = the agent with the most distinct keyword
 * hits in the description; ties broken by first-seen. Returns null when no
 * keyword matches — the caller then stays silent (fail-open, no false warns).
 *
 * @returns {{ agent: string, hits: string[] } | null}
 */
function suggestAgent(description, index) {
  if (!description || !index || !index.keywordToAgent || index.keywordToAgent.size === 0) {
    return null;
  }
  const tokens = tokenize(description);
  if (tokens.length === 0) return null;
  const counts = new Map(); // agent → Set(matched keywords)
  for (const tok of tokens) {
    const agent = index.keywordToAgent.get(tok);
    if (!agent) continue;
    if (!counts.has(agent)) counts.set(agent, new Set());
    counts.get(agent).add(tok);
  }
  if (counts.size === 0) return null;
  let best = null;
  let bestN = 0;
  for (const [agent, hitsSet] of counts) {
    if (hitsSet.size > bestN) {
      bestN = hitsSet.size;
      best = { agent, hits: [...hitsSet] };
    }
  }
  return best;
}

module.exports = { tokenize, readRoles, buildIndex, suggestAgent };
