#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * team-create-preflight-gate.cjs — PreToolUse hook for TeamCreate.
 *
 * Blocks TeamCreate calls when the t1k-team Pre-flight Protocol Step 0
 * (the Agent+TeamCreate ToolSearch) hasn't fired in the current session.
 *
 * Companion hook: team-create-preflight-tracker.cjs (PostToolUse on
 * ToolSearch) writes a per-session sentinel when Step 0 runs. This hook
 * checks the sentinel and blocks if absent.
 *
 * Two failure modes this prevents:
 *   B. Deferred-schema InputValidationError — Agent/TeamCreate are auto-
 *      deferred in 1M-Opus sessions. Calling TeamCreate without ToolSearch
 *      first throws InputValidationError because the schema isn't loaded.
 *   C. Orphan team+task files — when a skill declares TeamCreate in `tools:`
 *      but omits Agent, TeamCreate succeeds and writes team/task files,
 *      then the subsequent Agent dispatch fails (tool not in scope) and
 *      leaves orphans on disk with no recovery path.
 *
 * Self-detection: if the companion tracker hook is NOT registered in
 * settings.json PostToolUse on ToolSearch, this gate would block every
 * TeamCreate call forever (sentinel never written). In that case, we
 * fail-open with a stderr warning instead of silently breaking /t1k:team.
 *
 * Exit codes:
 *   0  — allow (Step 0 has fired, tool is not TeamCreate, or tracker unregistered)
 *   2  — block + stderr message (gate violation)
 *   0  — on internal error (fail-open per rules/security.md)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

function sentinelPath(sessionId) {
  // Use os.tmpdir() for ephemeral cross-platform state (per CR #3)
  const safe = String(sessionId || 'no-session').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return path.join(os.tmpdir(), `t1k-team-preflight-${safe}.marker`);
}

function trackerIsRegistered() {
  // Verify the companion tracker hook is wired in settings.json. Without it,
  // the sentinel is never written and this gate would block every TeamCreate
  // call forever — a meta-bug we should self-detect instead of perpetuate.
  try {
    const settingsPath = path.join(process.env.CLAUDE_PROJECT_DIR || process.cwd(), '.claude/settings.json');
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    const post = (settings.hooks && settings.hooks.PostToolUse) || [];
    return post.some(entry =>
      String(entry.matcher || '').includes('ToolSearch') &&
      (entry.hooks || []).some(h => String(h.command || '').includes('team-create-preflight-tracker'))
    );
  } catch {
    // Fail-open: if settings unreadable, assume registered so we don't
    // mask a real registration issue behind a file-read error.
    return true;
  }
}

try {
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const toolName = hookData.tool_name;
  if (toolName !== 'TeamCreate') process.exit(0);

  // Self-detection: if the companion tracker hook isn't registered in
  // settings.json, fail-open with a warning. Otherwise this gate would
  // block every TeamCreate call permanently (sentinel never written).
  if (!trackerIsRegistered()) {
    process.stderr.write(
      '[team-create-preflight-gate] WARN: companion tracker (team-create-preflight-tracker) ' +
      'not registered in .claude/settings.json PostToolUse on ToolSearch — gate effectively ' +
      'bypassed; fix settings.json so the sentinel can be written.\n'
    );
    process.exit(0);
  }

  const sessionId = hookData.session_id || process.env.CLAUDE_SESSION_ID || '';
  const sentinel = sentinelPath(sessionId);

  if (fs.existsSync(sentinel)) {
    // Step 0 has fired in this session — allow
    process.exit(0);
  }

  // Step 0 NOT fired — block
  const teamName = (hookData.tool_input && hookData.tool_input.team_name) || '<unnamed>';
  const msg = [
    '',
    '\x1b[31m[t1k:team-create-preflight-gate] BLOCK\x1b[0m: TeamCreate(team_name="' + teamName + '") cannot fire before t1k-team Pre-flight Step 0.',
    '',
    'Step 0 (the Agent+TeamCreate ToolSearch) must run BEFORE TeamCreate to prevent:',
    '  B. \x1b[1mDeferred-schema InputValidationError\x1b[0m — Agent and TeamCreate are auto-',
    '     deferred in 1M-Opus sessions. Calling TeamCreate without first loading the',
    '     schema via ToolSearch throws InputValidationError.',
    '  C. \x1b[1mOrphan team + task files\x1b[0m — a skill declaring TeamCreate in its `tools:`',
    '     array but omitting Agent will create a team and tasks on disk, then fail when',
    '     it tries to dispatch Agent (tool not in scope), leaving orphans with no recovery.',
    '',
    '\x1b[34mFix:\x1b[0m run this FIRST, then retry TeamCreate:',
    '    ToolSearch(query="select:Agent,TeamCreate", max_results=2)',
    '',
    'See: skills/t1k-team/SKILL.md → Pre-flight Protocol',
    '     skills/t1k-team/references/fork-context-bail.md',
    ''
  ].join('\n');

  process.stderr.write(msg);
  process.exit(2);
} catch (err) {
  // Fail-open per rules/security.md — a buggy guard never blocks legitimate work
  try { process.stderr.write('[team-create-preflight-gate] internal error (fail-open): ' + err.message + '\n'); } catch {}
  process.exit(0);
}
