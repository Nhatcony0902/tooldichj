#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * require-current-cli.cjs — PreToolUse guard that blocks state-mutating t1k
 * operations when the local CLI is behind the latest published version.
 *
 * Why:
 *   v4.17.0 of theonekit-cli ships the canonical-files cleanup driver. Older
 *   CLIs running `t1k update --kit` or `t1k modules install` skip the cleanup
 *   step → orphan files coexist with new files, causing schema drift and
 *   partial sync-back. This guard short-circuits before the bad invocation
 *   runs.
 *
 * Behaviour:
 *   - Reads the cached `current` + `latest` CLI versions written by
 *     SessionStart hook check-cli-updates.cjs.
 *   - Block (exit 2) when current < latest AND the requested command is in
 *     the state-mutating allow-list.
 *   - Allow (exit 0) escape routes (`t1k self-update`, `--cli`, doctor,
 *     --version) and any non-t1k command unconditionally.
 *   - Fail-OPEN on any internal error or missing cache — never break the
 *     user's session because of a buggy guard.
 *   - Override: T1K_REQUIRE_CURRENT_CLI=0 in the env bypasses the gate for
 *     one shell session.
 *
 * Matcher: PreToolUse on Bash (catches shell t1k invocations) and Skill
 * (catches /t1k:sync-back style invocations if the Claude Code PreToolUse
 * Skill matcher fires).
 */
'use strict';

try {
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  const cache = require('./lib/update-check-cache.cjs');

  // ── Helpers ─────────────────────────────────────────────────────────────────

  function parseSemver(v) {
    if (!v) return null;
    const m = String(v).trim().match(/(\d+)\.(\d+)\.(\d+)(?:-([\w.-]+))?/);
    if (!m) return null;
    return {
      major: Number(m[1]),
      minor: Number(m[2]),
      patch: Number(m[3]),
      prerelease: m[4] || null,
    };
  }

  function compareSemver(a, b) {
    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.prerelease && !b.prerelease) return -1;
    if (!a.prerelease && b.prerelease) return 1;
    if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
    return 0;
  }

  // Block-list: state-mutating t1k subcommands that depend on cleanup features
  // shipped in newer CLIs. Order: most-specific first (kit-update before catch-all).
  const BLOCK_PATTERNS = [
    { re: /^\s*t1k\s+sync-back\b/, label: 't1k sync-back' },
    { re: /^\s*t1k\s+init\b/, label: 't1k init' },
    { re: /^\s*t1k\s+modules\s+(install|remove|update|sync)\b/, label: 't1k modules <mutating>' },
    { re: /^\s*t1k\s+update\s+--kit\b/, label: 't1k update --kit' },
  ];

  // Allow-list: escape routes and read-only commands. Checked BEFORE block-list.
  const ALLOW_PATTERNS = [
    /^\s*t1k\s+self-update\b/,
    /^\s*t1k\s+update\s+(--cli|--latest)\b/,
    /^\s*t1k\s+--version\b/,
    /^\s*t1k\s+doctor\b/,
  ];

  // Skill names: handle Claude Code's namespacing variants. Allow-list overrides.
  const BLOCK_SKILL_NAMES = new Set([
    't1k-sync-back', 't1k:sync-back', 'theonekit-core:t1k-sync-back',
    't1k-modules', 't1k:modules', 'theonekit-core:t1k-modules',
    't1k-init', 't1k:init', 'theonekit-core:t1k-init',
  ]);

  function classifyCommand(cmd) {
    const trimmed = String(cmd || '').trim();
    if (!trimmed) return { kind: 'allow', reason: 'empty' };
    // Non-t1k command → never our concern.
    if (!/^\s*t1k\b/.test(trimmed)) return { kind: 'allow', reason: 'non-t1k' };
    // Allow-list first (escape routes win over block-list).
    for (const re of ALLOW_PATTERNS) if (re.test(trimmed)) return { kind: 'allow', reason: 'escape-route' };
    for (const p of BLOCK_PATTERNS) if (p.re.test(trimmed)) return { kind: 'block', label: p.label };
    return { kind: 'allow', reason: 't1k-other' };
  }

  function classifySkill(skillName) {
    if (!skillName) return { kind: 'allow', reason: 'no-skill-name' };
    return BLOCK_SKILL_NAMES.has(String(skillName))
      ? { kind: 'block', label: `skill ${skillName}` }
      : { kind: 'allow', reason: 'skill-not-listed' };
  }

  function emitBlockMessage(cmdLabel, current, latest) {
    const lines = [
      `[require-current-cli] BLOCKED — local t1k CLI v${current} is behind the latest v${latest}.`,
      `  Why: state-mutating commands like \`${cmdLabel}\` depend on CLI features`,
      `       only available in v${latest} (e.g. canonical-files cleanup driver`,
      `       in v4.17.0+). Running with a stale CLI risks orphan files,`,
      `       schema drift, or partial sync-back.`,
      '',
      '  Fix: run `t1k self-update` first, then retry your command.',
      '',
      '  Override (NOT recommended): set T1K_REQUIRE_CURRENT_CLI=0 in the env',
      '  for this one shell session.',
    ];
    process.stderr.write(lines.join('\n') + '\n');
  }

  // ── Main ────────────────────────────────────────────────────────────────────

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;
  const timer = createHookTimer('require-current-cli', { tool: toolName });

  // Resolve the classification for the requested tool.
  let classification;
  if (toolName === 'Bash' && toolInput && typeof toolInput.command === 'string') {
    classification = classifyCommand(toolInput.command);
  } else if (toolName === 'Skill' && toolInput) {
    // Claude Code skill invocations may name the skill via either field.
    const skill = toolInput.skill || toolInput.skill_name || toolInput.name || '';
    classification = classifySkill(skill);
  } else {
    timer.end({ outcome: 'skip', reason: 'unmatched-tool' });
    process.exit(0);
  }

  if (classification.kind === 'allow') {
    timer.end({ outcome: 'allow', reason: classification.reason });
    process.exit(0);
  }

  // From here, classification.kind === 'block'.
  // Honor the env override before any cache work.
  if (process.env.T1K_REQUIRE_CURRENT_CLI === '0') {
    logHook('require-current-cli', { decision: 'allow', reason: 'env-override', label: classification.label });
    timer.end({ outcome: 'allow', reason: 'env-override' });
    process.exit(0);
  }

  // Read cached versions; fail-open if missing/corrupt.
  const versions = cache.getCliVersions();
  if (!versions) {
    logHook('require-current-cli', { decision: 'allow', reason: 'cache-missing', label: classification.label });
    timer.end({ outcome: 'allow', reason: 'cache-missing' });
    process.exit(0);
  }

  const cur = parseSemver(versions.current);
  const lat = parseSemver(versions.latest);
  if (!cur || !lat) {
    logHook('require-current-cli', { decision: 'allow', reason: 'cache-unparseable', label: classification.label });
    timer.end({ outcome: 'allow', reason: 'cache-unparseable' });
    process.exit(0);
  }

  if (compareSemver(cur, lat) >= 0) {
    timer.end({ outcome: 'allow', reason: 'current-up-to-date', current: versions.current, latest: versions.latest });
    process.exit(0);
  }

  // Stale CLI + state-mutating command → block.
  emitBlockMessage(classification.label, versions.current, versions.latest);
  logHook('require-current-cli', {
    decision: 'block',
    label: classification.label,
    current: versions.current,
    latest: versions.latest,
  });
  timer.end({ outcome: 'block', current: versions.current, latest: versions.latest });
  process.exit(2);
} catch (err) {
  // Last-resort fail-open. logHookCrash itself is wrapped — never throw.
  try { require('./hook-logger.cjs').logHookCrash('require-current-cli', err); } catch { /* ok */ }
  process.exit(0);
}
