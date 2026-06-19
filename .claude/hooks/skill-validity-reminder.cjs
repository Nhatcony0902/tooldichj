#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * skill-validity-reminder.cjs — PostToolUse hook on the `Skill` tool.
 *
 * In-session passive skill-validity self-check. When a kit-owned (`t1k-`/`t1k:`)
 * skill is ACTIVATED mid-session, emit a one-time-per-session reminder prompting
 * the assistant to self-assess whether the skill's guidance is still
 * fresh/correct/helpful for the current task — and, if not, to emit a
 * `[t1k:skill-bug ...]` marker. That marker feeds the EXISTING collector →
 * sync-back/issue pipeline (lesson-collector.cjs + lesson-queue-processor.cjs),
 * so no new plumbing is required — this hook only supplies the missing trigger.
 *
 * Why: the kit's skill-bug pipeline works but only fires when the assistant
 * REMEMBERS to emit a marker. Staleness discovered while USING a skill was
 * routinely missed. This closes that discipline leak by making the self-check
 * automatic at skill-use time (the moment the assistant has the skill content
 * in front of it and the task context to judge its validity).
 *
 * Scope: only kit-owned skills (name starts with `t1k-` or `t1k:`). Non-kit /
 * built-in skills are skipped. Deduped per session per skill (one reminder per
 * skill per session) so repeated use of the same skill is not nagged.
 *
 * Non-blocking (PostToolUse cannot block). Fail-open: any exception → exit 0.
 *
 * Reuses (no duplicate utilities):
 *   - parseHookStdin, ensureTelemetryDir, computeTeammateSessionKey from
 *     telemetry-utils.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const {
    parseHookStdin,
    ensureTelemetryDir,
    computeTeammateSessionKey,
  } = require('./telemetry-utils.cjs');

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;
  if (toolName !== 'Skill') process.exit(0);

  // The Skill tool carries the skill identity in `skill` (fallback `name`).
  const skill = (toolInput && (toolInput.skill || toolInput.name)) || '';
  if (!skill) process.exit(0);

  // Only kit-owned skills — dash form (t1k-...) or colon form (t1k:...).
  if (!/^t1k[:-]/.test(skill)) process.exit(0);

  // Per-session per-skill dedup — one reminder per skill per session.
  const telemetryDir = ensureTelemetryDir();
  const sessionKey = computeTeammateSessionKey();
  const seenPath = path.join(telemetryDir, `skill-validity-seen-${sessionKey}.json`);

  let seen = [];
  try {
    if (fs.existsSync(seenPath)) {
      const parsed = JSON.parse(fs.readFileSync(seenPath, 'utf8'));
      if (Array.isArray(parsed)) seen = parsed;
    }
  } catch { /* fail-open on corrupt cache */ }

  if (seen.includes(skill)) process.exit(0); // already reminded this session

  seen.push(skill);
  try { fs.writeFileSync(seenPath, JSON.stringify(seen)); } catch { /* non-critical */ }

  // Emit the passive self-check reminder (PostToolUse stdout → assistant context).
  process.stdout.write(
    `[t1k:skill-validity-check skill="${skill}"]\n` +
    `You just activated kit-owned skill "${skill}". As you apply its guidance, ` +
    `self-assess: is any of it STALE, WRONG, or UNHELPFUL for the current task ` +
    `(deprecated/renamed API, outdated version pin, removed flag, dead link, ` +
    `advice that contradicts what you observe)? If yes, emit this marker NOW so ` +
    `the auto-pipeline routes a fix (all attributes required):\n` +
    `[t1k:skill-bug kit="<owning-kit>" skill="${skill}" bug="<one-line>" evidence="<path-or-repro>"]\n` +
    `The collector queues it and spawns /t1k:sync-back (fix) or /t1k:issue. ` +
    `If the skill is fine, do nothing — this is a one-time check per skill per session.\n`
  );

  process.exit(0);
} catch {
  process.exit(0); // Fail-open: a buggy guard must never disrupt skill usage.
}
