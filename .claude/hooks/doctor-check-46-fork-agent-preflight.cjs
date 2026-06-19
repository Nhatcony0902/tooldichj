#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
'use strict';
/**
 * doctor-check-46-fork-agent-preflight.cjs — Doctor check #46.
 *
 * Audits every skill with `context: fork` for the Agent-availability
 * pre-flight pattern. Prevents the issue #259 failure mode at the
 * skill-author level — a forked-context skill that calls `Agent` or
 * `TeamCreate` from its body MUST also include a `ToolSearch` pre-flight
 * for those tools (so the AI can detect fork-context absence and bail
 * cleanly instead of leaving orphan state).
 *
 * Companion to:
 *   - .claude/hooks/team-create-preflight-gate.cjs (runtime block on TeamCreate)
 *   - theonekit-release-action/scripts/validate-fork-agent-preflight.cjs (CI gate)
 *
 * Detection rules per skill body (SKILL.md + references/*.md):
 *   1. Frontmatter has `context: fork`.
 *   2. Body invokes `Agent(` OR `TeamCreate(` OR `subagent_type:` (any of these).
 *   3. Body must contain at least one `ToolSearch(query="select:Agent...` OR
 *      `ToolSearch(query="select:...,Agent...` (or TeamCreate equivalent).
 *
 * Emits:
 *   [t1k:doctor:fork-agent-preflight status=ok|warn|fail count=N]
 *
 * Exit codes:
 *   0 — all OK
 *   1 — at least one skill missing the pre-flight pattern (FAIL)
 *   0 — internal error (fail-open)
 *
 * Usage:
 *   node doctor-check-46-fork-agent-preflight.cjs [path/to/.claude]
 */

const fs = require('fs');
const path = require('path');

const CHECK_ID = 46;
const CHECK_NAME = 'fork-agent-preflight';

function emit(level, message) {
  process.stdout.write(`${level} [check #${CHECK_ID}] ${CHECK_NAME}: ${message}\n`);
}

function marker(status, count) {
  process.stdout.write(`[t1k:doctor:${CHECK_NAME} status=${status} count=${count}]\n`);
}

function resolveClaudeDir() {
  const arg = process.argv[2];
  if (arg && fs.existsSync(arg)) return arg;
  const fromDirname = path.resolve(__dirname, '..');
  if (path.basename(fromDirname) === '.claude') return fromDirname;
  const fromCwd = path.join(process.cwd(), '.claude');
  if (fs.existsSync(fromCwd)) return fromCwd;
  return null;
}

function readSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch { return null; }
}

function hasForkContext(skillMd) {
  return /^context:\s*fork\s*$/m.test(skillMd);
}

function callsAgentOrTeamCreate(bodyText) {
  // Detect ACTUAL tool calls (not prose mentions or docs about how parent invokes the skill).
  //   Agent(...)        — direct Agent tool call (with opening paren)
  //   TeamCreate(...)   — direct TeamCreate tool call (with opening paren)
  //
  // Intentionally NOT matching `subagent_type:` alone or `Agent tool` (prose) — those
  // produce false positives in skills like t1k-sync-back whose docs describe how the
  // PARENT spawns them as sub-agents (not the body's own spawn pattern).
  return /(\bAgent\s*\(|\bTeamCreate\s*\()/.test(bodyText);
}

function hasPreflightToolSearch(bodyText) {
  // Accept either:
  //   ToolSearch(query="select:Agent..." (any select including Agent)
  //   ToolSearch(query="select:...,Agent..." (Agent in a multi-tool select)
  //   ToolSearch(query="select:TeamCreate..." (or in multi-select)
  return /ToolSearch\s*\(\s*query\s*=\s*["']select:[^"']*\b(Agent|TeamCreate)\b/i.test(bodyText);
}

function collectSkillBodies(skillDir) {
  // Returns full concatenated text of SKILL.md + all references/*.md
  const out = [];
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillMd)) {
    out.push(readSafe(skillMd) || '');
  }
  const refDir = path.join(skillDir, 'references');
  if (fs.existsSync(refDir)) {
    for (const f of fs.readdirSync(refDir)) {
      if (f.endsWith('.md')) {
        out.push(readSafe(path.join(refDir, f)) || '');
      }
    }
  }
  return out.join('\n\n');
}

function run() {
  const claudeDir = resolveClaudeDir();
  if (!claudeDir) {
    emit('SKIP', 'no .claude/ directory resolvable');
    marker('skip', 0);
    process.exit(0);
  }
  const skillsRoot = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsRoot)) {
    emit('SKIP', 'no skills/ directory');
    marker('skip', 0);
    process.exit(0);
  }

  const violations = [];
  const checked = [];

  for (const entry of fs.readdirSync(skillsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(skillsRoot, entry.name);
    const skillMd = readSafe(path.join(skillDir, 'SKILL.md'));
    if (!skillMd) continue;
    if (!hasForkContext(skillMd)) continue;

    const fullBody = collectSkillBodies(skillDir);
    const callsAgent = callsAgentOrTeamCreate(fullBody);
    if (!callsAgent) continue; // fork-context skill but doesn't spawn — safe

    const hasPreflight = hasPreflightToolSearch(fullBody);
    checked.push(entry.name);
    if (!hasPreflight) {
      violations.push({
        skill: entry.name,
        reason: 'context: fork skill spawns Agent/TeamCreate but lacks ToolSearch(query="select:Agent..." OR "select:TeamCreate..." pre-flight pattern'
      });
    }
  }

  if (violations.length === 0) {
    emit('OK', `audited ${checked.length} fork-context skills with Agent/TeamCreate spawning — all have pre-flight`);
    marker('ok', checked.length);
    process.exit(0);
  }

  for (const v of violations) {
    emit('FAIL', `skill ${v.skill}: ${v.reason}`);
  }
  emit('FAIL', `${violations.length} skill(s) missing the fork-context Agent pre-flight — see skills/t1k-team/SKILL.md Step 0 for the canonical pattern, and skills/t1k-team/references/fork-context-bail.md for the bail procedure`);
  marker('fail', violations.length);
  process.exit(1);
}

try {
  run();
} catch (err) {
  process.stderr.write(`[doctor-check-${CHECK_ID}] internal error (fail-open): ${err.message}\n`);
  marker('error', 0);
  process.exit(0);
}
