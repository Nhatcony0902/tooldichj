#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * workflow-failure-detector.cjs — SubagentStop hook: auto-detect agent workflow failures.
 *
 * Closes the gap between hook-level tool errors (already covered by
 * telemetry-kit-error-collector.cjs) and workflow-level failures that only
 * surface when a background sub-agent completes. Without this hook, the
 * coordinator had to read the <task-notification> by eye and manually emit
 * a `[t1k:skill-bug]` marker.
 *
 * Pipeline:
 *   opt-out guard → feature flag → read transcript_path → extract last AI turn
 *   text + total tokens → apply 5 detection patterns → sanitize evidence →
 *   fingerprint + 7-day TTL dedup → rate-limit (3/session per pattern) →
 *   append `[t1k:skill-bug]` entries to pending-skill-updates.jsonl →
 *   emit `[t1k:workflow-failure-detected count=N]` to stdout.
 *
 * Detection patterns (each fires an independent skill-bug entry):
 *   P1  Mid-task stop   — incomplete-thought tail + token WINDOW (≥180K and ≤300K)
 *   P2  Skill fallback  — "cannot spawn" / "not actually available" / "<subj> fell back"
 *   P3  Tool unavailable— InputValidationError without ToolSearch recovery
 *   P4  Empty deliver.  — claimed Write at path but file missing or <100 bytes
 *   P5  Out-of-scope    — agent text admits modifying out-of-scope files
 *
 * False-positive guards (prose patterns only fire on a genuine sub-agent):
 *   - P1/P2/P5 are gated on a present, non-"unknown" agent_type. A missing
 *     agent_type on SubagentStop means we're likely reading the MAIN-session
 *     transcript, where this narration is normal — not a failure.
 *   - P1 uses a token WINDOW (floor 180K, ceiling 300K): above the ceiling the
 *     transcript is the main session (token bleed), so the signal is dropped.
 *   - P2 no longer matches the bare phrase "fall back to"/"falling back to" —
 *     those appear in ordinary prose describing fallback DESIGN behavior.
 *
 * Reuses (no duplicate utilities):
 *   - sanitize helpers from lib/kit-error-sanitizer.cjs (SSOT for redaction)
 *   - fingerprint()/checkAndRecord() from lib/kit-error-dedup.cjs
 *     scoped to its own cache via T1K_KIT_ERROR_CACHE_PATH env override
 *   - readFeatureFlag(), resolveClaudeDir(), ensureTelemetryDir(),
 *     findProjectRoot(), T1K constants from telemetry-utils.cjs
 *   - safeResolve from lib/safe-paths.cjs (validates transcript_path)
 *
 * Fail-open: any exception → process.exit(0). Crashes log to
 * ~/.claude/.workflow-failure-detector.log.
 *
 * Design note (AI-driven design): the hook emits FACTS (failure-pattern hits,
 * sanitized evidence snippets, agent type, token usage). It does NOT decide
 * whether to file an issue — that's the queue-processor + sub-agent's job.
 * No hardcoded skill→issue mappings.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const {
  parseHookStdin,
  isTelemetryEnabled,
  ensureTelemetryDir,
  findProjectRoot,
  resolveClaudeDir,
  readFeatureFlag,
  T1K,
} = require('./telemetry-utils.cjs');

const { safeResolve, SafePathError } = require('./lib/safe-paths.cjs');
const { logHook, createHookTimer } = require('./hook-logger.cjs');
const sanitizer = require('./lib/kit-error-sanitizer.cjs');

// ── Constants (data-driven config overrides) ──
const CACHE_FILENAME = '.workflow-failure-fingerprints.json';
const CRASH_LOG_FILENAME = '.workflow-failure-detector.log';
const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const RATE_DIR_NAME = 't1k-workflow-failure';
const FEATURE_FLAG = 'autoLessonSync';     // piggy-backs on the same flag as lesson-collector
const ENV_OPT_IN = 'T1K_AUTO_LESSON_SYNC'; // (same kill switch — sub-pipeline of auto-lesson)
const DRY_RUN_ENV = 'T1K_WORKFLOW_FAILURE_DRY_RUN';

// Token usage thresholds for P1 (mid-task stop). At/above this implies context
// exhaustion was the likely cause. Configurable via t1k-config-*.json.
const DEFAULT_MID_TASK_TOKEN_THRESHOLD = 180_000;
// Upper bound for P1. A genuine isolated sub-agent transcript rarely accumulates
// past this; when totalTokens exceeds it the SubagentStop hook is almost
// certainly reading the MAIN-session transcript (token bleed), not a fresh
// sub-agent. Observed false positive: tokens=682580 from a main-loop "let me
// read..." narration. Above the ceiling, the token signal is meaningless → skip.
const DEFAULT_MID_TASK_TOKEN_CEILING = 300_000;
// Empty-deliverable size threshold — files smaller than this when the agent
// claimed a Write are flagged as P4.
const DEFAULT_EMPTY_DELIVERABLE_BYTES = 100;
// Per-pattern rate limit (separate from lesson-collector's 5/session global).
const DEFAULT_MAX_PER_PATTERN_PER_SESSION = 3;

// ── Detection patterns (sanitized text only — never raw) ──
//
// P1 (mid-task stop) — incomplete-thought tail. We anchor on common
// trailing-fragment phrases that imply the agent intended to do another step.
// We do NOT use any single phrase as a smoking gun; the pattern only fires
// when paired with high token usage (see classifyMidTaskStop).
const MID_TASK_TAIL_RE = /\b(?:now let me|let me check|let me now|let me also|i['’]?ll just|i['’]?ll now|next,? i['’]?ll|next,? let me|going to|will continue|continuing with|let me look|let me read|let me see)\b[^.!?\n]{0,80}\.?\s*$/i;

// P2 (skill fallback) — skill body cannot fulfill stated purpose.
//
// IMPORTANT (#false-positive fix): bare "fall back to" / "falling back to" were
// REMOVED. They matched ordinary prose describing fallback *design behavior*
// (e.g. "the model-router would fail the whole pipe and fall back to Opus"),
// producing skill-bug false positives every turn.
//
// IMPORTANT (#445 false-positive fix): the previous "(skill|agent|tool) ... fell
// back" clause STILL fired on DOMAIN prose, because "agent" and "tool" are common
// engineering nouns ("navigation agent fell back to the previous waypoint", "the
// physics tool fell back to AABB bounds"). The issue evidence — a Unity report
// about MeasureSpriteB "falling back to the world AABB" — is exactly this class.
//
// Two subject tiers now feed the "...fell back" surface:
//   • RELIABLE subjects — "skill" / "this skill" / "this (sub-)agent" / "the
//     (sub-)agent" / "I" / "we". These are self-referential to the skill/agent
//     RUNTIME and rarely appear as domain nouns, so they fire on their own.
//   • AMBIGUOUS subjects — bare "agent" / "tool" (collide with "navigation agent",
//     "physics tool"). These STILL match the regex, but classifySkillFallback()
//     requires an execution-failure cause nearby AND rejects when a
//     domain-engineering token is in the window (see the two guard REs below).
// Every other alternative (cannot spawn, not actually available, etc.) remains
// self-diagnostic and matches as before, exempt from the guards.
const SKILL_FALLBACK_RE = /\b(?:cannot spawn|can['’]?t spawn|hard error caught by pre-flight|not actually available in this context|not available in this fork|skill cannot|skill couldn['’]?t|(?:this skill|the skill|this sub-?agent|this agent|the sub-?agent|skill|agent|tool|i|we)(?:\s+\w+){0,4}\s+(?:fell back|had to fall back|was forced to fall back|forced to fall back))\b/i;

// #445 — subjects that are reliably the skill/agent RUNTIME (not a domain noun).
// Tested against the matched substring (m[0]): if it STARTS with one of these
// runtime subjects, no failure-cause guard is required. Bare "agent"/"tool" are
// intentionally EXCLUDED (they collide with "navigation agent"/"physics tool")
// and must clear the failure-cause + denylist guards to fire.
const FALLBACK_RELIABLE_SUBJECT_RE = /^(?:this skill|the skill|this sub-?agent|this agent|the sub-?agent|skill|i|we)\b/i;

// #445 — for AMBIGUOUS subjects (bare "agent"/"tool"), the "...fell back" branch
// only counts as a genuine skill-body failure when an execution-failure cause
// sits near the match. A bare "the navigation agent fell back to the waypoint"
// with no failure framing is design narration.
const FALLBACK_FAILURE_CAUSE_RE = /\b(?:because|since)\b[^.!?\n]{0,80}\b(?:could ?n['’]?t|can ?not|cannot|can['’]?t|unable|fail(?:ed|s|ing)?|not (?:actually )?available|blocked|unavailable|missing|denied|timed? out|errored?|down|depth[- ]limit)\b|\b(?:could ?n['’]?t|can ?not|cannot|unable to|failed to|was unable to|not available)\b[^.!?\n]{0,80}\b(?:so|therefore)\b|\b(?:in this (?:context|fork)|depth[- ]limit|recursion depth)\b/i;

// #445 — domain-engineering denylist. When an AMBIGUOUS-subject "fall back" match
// sits next to one of these tokens, the prose is almost certainly describing a
// DOMAIN fallback (AABB-vs-physics-shape, default values, retry paths, nav
// waypoints) rather than a skill/agent runtime failure.
const FALLBACK_DOMAIN_DENYLIST_RE = /\b(?:aabb|bounding ?box|physics ?shape|collider|sprite|waypoint|nav(?:mesh|igation)?|default ?value|cached? value|placeholder|fall-?through|previous (?:value|state|waypoint|frame)|world units|footprint)\b/i;

// P3 (tool unavailable) — deferred-tool schema not loaded.
const TOOL_VALIDATION_RE = /\b(?:InputValidationError|schema not loaded|tool schema is not loaded|deferred tool .*? not loaded)\b/i;
const TOOLSEARCH_RECOVERY_RE = /\bToolSearch\s*\(/i;

// P5 (out-of-scope) — self-admitted scope drift. Conservative match: the agent
// explicitly states it MODIFIED something outside its declared scope.
//
// IMPORTANT (#482 false-positive fix): the bare alternatives "out of scope" /
// "outside my scope" / "outside the declared scope" etc. were REMOVED. They
// matched the everyday-English phrase that pervades completion-report PROSE
// ("these were out of scope for the autonomous run", "X is out of scope for
// this PR") which has NOTHING to do with an agent editing files it doesn't own.
// The detector applied zero contextual signal, so any narrative use tripped a
// false skill-bug and risked an auto-filed garbage issue.
//
// Two firing surfaces remain, BOTH action-anchored to an actual modification:
//   • An explicit "(edited|modified|touched|wrote|changed) ... files outside ...
//     scope" admission — the agent self-reports a concrete write-vs-scope drift.
//   • A bare "out of scope" / "outside ... scope" phrase STILL matches the broad
//     regex, but classifyOutOfScope() then REQUIRES a corroborating modification
//     verb nearby (see OUT_OF_SCOPE_MODIFY_RE). Narrative prose with no
//     modification framing in the surrounding window is rejected as benign.
const OUT_OF_SCOPE_RE = /\b(?:(?:edited|modified|touched|wrote|changed|altered)\s+(?:\w+\s+){0,3}files?\s+outside|went out of scope|out of scope|outside (?:my|its|the (?:declared|agreed)) scope|outside the declared scope|outside its declared scope)\b/i;

// #482 — the action-anchored alternatives are self-grounding (they already name a
// modification verb + "files outside"). The bare "out of scope" / "outside ...
// scope" alternatives are NARRATIVE-prone, so when the matched substring is one
// of those bare phrases the classifier requires a corroborating modification
// signal in the surrounding context window before firing. This rejects benign
// completion-report prose ("X is out of scope for this PR", "these were out of
// scope for the autonomous run") while still catching a real self-report
// ("I modified config.json which is out of scope for this task").
const OUT_OF_SCOPE_ACTION_RE = /\b(?:edited|modified|touched|wrote|changed|altered)\s+(?:\w+\s+){0,3}files?\s+outside\b|\bwent out of scope\b/i;
const OUT_OF_SCOPE_MODIFY_RE = /\b(?:edit(?:ed|ing|s)?|modif(?:y|ied|ying|ies)|touch(?:ed|ing|es)?|wrote|writ(?:ing|ten)|chang(?:e|ed|ing|es)|alter(?:ed|ing|s)?|updat(?:e|ed|ing|es)|creat(?:e|ed|ing|es)|delet(?:e|ed|ing|es))\b/i;
const OUT_OF_SCOPE_CONTEXT_WINDOW = 90;

// P4 (empty deliverable) — capture every claimed Write target the agent
// mentions and check on disk. Two complementary forms.
const WRITE_TARGET_RE_LIST = [
  // "Created file path/to/file.md"
  /(?:created|wrote|written|saved)(?:\s+(?:file|the file))?\s+(?:to|at)?\s*[`'"“”]?((?:[~.]?\/)?[\w\-./]+\.[A-Za-z][A-Za-z0-9]{0,7})[`'"“”]?/gi,
  // "Wrote N lines to path/to/file.md"
  /(?:wrote|written|saved)\s+(?:\d+\s+(?:lines?|bytes?)\s+)?to\s+[`'"“”]?((?:[~.]?\/)?[\w\-./]+\.[A-Za-z][A-Za-z0-9]{0,7})[`'"“”]?/gi,
];

// P4 false-positive guard (#397) — a claimed Write target is only a genuine
// empty-deliverable failure when the surrounding text ASSERTS completion. When
// the same path appears inside an INTENTION phrase ("I will write to", "about
// to create", "let me write", "next I'll save to"), the file's absence on disk
// is expected — the agent is announcing future work, not claiming a finished
// deliverable. We inspect a short context window immediately before the matched
// verb; if it carries future/intent framing, the candidate is skipped.
// Matches future/intent framing ending right before the matched write-verb.
// Covers passive future ("will be ", "to be ", "going to be ", "shall be ")
// and active intent ("I will ", "about to ", "plan to ", "let me ") that lead
// into a write verb. The trailing `\s*$` anchors the phrase to the end of the
// inspected context window (i.e. immediately before the verb).
const INTENT_CONTEXT_RE = /\b(?:will|i'?ll|we'?ll|they'?ll|going to|gonna|about to|plan(?:ning)? to|intend(?:ing)? to|let me|let's|then i'?ll|now i'?ll|i'?m going to|i am going to|need to|should|shall|would|(?:will|to|shall|should|would|going to|gonna|about to|needs? to|has to)\s+be)\s*$/i;
const INTENT_CONTEXT_WINDOW = 48;

/**
 * Read the workflow-failure-detector config block from any t1k-config-*.json
 * fragment in claudeDir. Piggy-backs on autoLessonSync feature flag (same kill
 * switch); per-detector limits live under workflowFailureDetector.{...}.
 */
function readConfig(claudeDir) {
  const defaults = {
    enabled: false,
    midTaskTokenThreshold: DEFAULT_MID_TASK_TOKEN_THRESHOLD,
    midTaskTokenCeiling: DEFAULT_MID_TASK_TOKEN_CEILING,
    emptyDeliverableBytes: DEFAULT_EMPTY_DELIVERABLE_BYTES,
    maxPerPatternPerSession: DEFAULT_MAX_PER_PATTERN_PER_SESSION,
    dedupeTTLDays: 7,
  };

  // Env kill switch (symmetric, mirrors lesson-collector)
  const envValue = process.env[ENV_OPT_IN];
  const envForceEnable = envValue === '1' || envValue === 'true';
  const envForceDisable = envValue === '0' || envValue === 'false' || envValue === '';
  let enabled;
  if (envForceDisable) {
    enabled = false;
  } else if (envForceEnable) {
    enabled = true;
  } else {
    enabled = readFeatureFlag(claudeDir, FEATURE_FLAG, defaults.enabled);
  }
  const result = { ...defaults, enabled };

  try {
    const files = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'));
    for (const f of files) {
      try {
        const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        const sub = cfg.workflowFailureDetector;
        if (sub && typeof sub === 'object') {
          if (typeof sub.midTaskTokenThreshold === 'number') result.midTaskTokenThreshold = sub.midTaskTokenThreshold;
          if (typeof sub.midTaskTokenCeiling === 'number') result.midTaskTokenCeiling = sub.midTaskTokenCeiling;
          if (typeof sub.emptyDeliverableBytes === 'number') result.emptyDeliverableBytes = sub.emptyDeliverableBytes;
          if (typeof sub.maxPerPatternPerSession === 'number') result.maxPerPatternPerSession = sub.maxPerPatternPerSession;
          if (typeof sub.dedupeTTLDays === 'number') result.dedupeTTLDays = sub.dedupeTTLDays;
        }
      } catch { /* skip malformed fragment */ }
    }
  } catch { /* no claudeDir */ }
  return result;
}

/** Stable session id — same shape as lesson-collector. */
function computeSessionId() {
  return process.env.CLAUDE_SESSION_ID ||
    crypto.createHash('md5')
      .update((process.env.CLAUDE_PROJECT_DIR || findProjectRoot()) + new Date().toISOString().slice(0, 10))
      .digest('hex').slice(0, 16);
}

/** $HOME/.claude — cross-platform global dir. */
function defaultGlobalClaudeDir() {
  const home = os.homedir() || process.env.HOME || process.env.USERPROFILE || os.tmpdir();
  return path.join(home, T1K.CLAUDE_DIR);
}

/**
 * Read the last assistant turn from the transcript JSONL.
 * Returns { text, totalTokens } — totalTokens is best-effort (transcript
 * entries often include usage.total_tokens or usage.input_tokens +
 * usage.output_tokens).
 */
function extractFinalTurn(transcriptPath) {
  const empty = { text: '', totalTokens: 0 };
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return empty;

  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');
    let cumulativeInput = 0;
    let cumulativeOutput = 0;
    let lastTotalTokens = 0;
    let finalAssistantText = '';

    // Walk forward to accumulate token usage from every assistant turn,
    // and capture the last assistant turn's text.
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry) continue;

      const isAssistant = entry.type === 'assistant' || entry.role === 'assistant'
        || (entry.message && entry.message.role === 'assistant');
      if (!isAssistant) continue;

      const usage = (entry.message && entry.message.usage) || entry.usage || null;
      if (usage) {
        if (typeof usage.total_tokens === 'number') {
          lastTotalTokens = usage.total_tokens;
        }
        if (typeof usage.input_tokens === 'number') cumulativeInput += usage.input_tokens;
        if (typeof usage.output_tokens === 'number') cumulativeOutput += usage.output_tokens;
      }

      const text = extractTextFromEntry(entry);
      if (text) finalAssistantText = text;
    }

    const totalTokens = lastTotalTokens || (cumulativeInput + cumulativeOutput);
    return { text: finalAssistantText, totalTokens };
  } catch {
    return empty;
  }
}

/** Concatenate text blocks from an assistant transcript entry. */
function extractTextFromEntry(entry) {
  const parts = [];
  const candidates = [entry.message, entry, entry.delta];
  for (const c of candidates) {
    if (!c) continue;
    const content = c.content;
    if (typeof content === 'string') parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object' && typeof block.text === 'string') {
          parts.push(block.text);
        }
      }
    }
  }
  return parts.join('\n').trim();
}

/** Sanitize evidence text via the shared kit-error-sanitizer helpers. */
function sanitizeEvidence(text, cwd, home) {
  let out = text;
  out = sanitizer._stripUserPaths(out, home, cwd);
  out = sanitizer._stripEnvVars(out);
  out = sanitizer._stripSecrets(out);
  out = sanitizer._stripSensitiveFilePaths(out);
  return out;
}

/**
 * Tail of the text — for trailing-thought matching we care about the final
 * 240 chars after trimming whitespace. (Anchoring on $ in the full text is
 * unreliable when agents append metadata.)
 */
function tailOf(text, n = 240) {
  if (!text) return '';
  return text.trim().slice(-n);
}

/**
 * P1 — mid-task stop. Fires only when ALL THREE hold:
 *   - trailing-thought regex matches the tail (last 240 chars), AND
 *   - totalTokens >= configured threshold (default 180K), AND
 *   - totalTokens <= configured ceiling (default 300K)
 * The token *window* (not just a floor) is critical: trailing thoughts alone
 * happen for legitimate reasons (the agent says "let me check" then runs a
 * tool). The floor restricts to near-exhausted context; the ceiling rejects the
 * case where the SubagentStop transcript is actually the MAIN-session transcript
 * (observed false positive: tokens=682580 — impossible for a fresh sub-agent —
 * paired with ordinary "let me read..." narration).
 */
function classifyMidTaskStop(text, totalTokens, threshold, ceiling) {
  if (totalTokens < threshold) return null;
  if (typeof ceiling === 'number' && ceiling > 0 && totalTokens > ceiling) return null;
  const tail = tailOf(text);
  const m = MID_TASK_TAIL_RE.exec(tail);
  if (!m) return null;
  return {
    pattern: 'mid-task-stop',
    bug: 'agent stopped mid-task without writing deliverable',
    evidence: `tokens=${totalTokens} tail="${m[0].slice(0, 100)}"`,
  };
}

/** P2 — skill body cannot fulfill stated purpose. */
function classifySkillFallback(text) {
  const m = SKILL_FALLBACK_RE.exec(text);
  if (!m) return null;
  // Pull a context window around the match for both evidence AND the #445 guards.
  const idx = m.index;
  const guardStart = Math.max(0, idx - 80);
  const guardEnd = Math.min(text.length, idx + m[0].length + 120);
  const guardCtx = text.slice(guardStart, guardEnd);

  // #445 — the "...fell back" branch is the only one prone to domain-prose false
  // positives. Two tiers:
  //   • Self-diagnostic branches (cannot spawn, not actually available, ...) and
  //     RELIABLE subjects (skill / this skill / I / we / the sub-agent) fire on
  //     their own — they can only describe a skill/agent runtime failure.
  //   • AMBIGUOUS subjects (bare "agent"/"tool" — collide with "navigation agent",
  //     "physics tool") require an execution-failure cause nearby AND must NOT sit
  //     next to a domain-engineering token (AABB, waypoint, default value, ...).
  const isFellBackBranch = /\bfell back\b|\bfall back\b/i.test(m[0]);
  if (isFellBackBranch && !FALLBACK_RELIABLE_SUBJECT_RE.test(m[0])) {
    if (FALLBACK_DOMAIN_DENYLIST_RE.test(guardCtx)) return null;
    if (!FALLBACK_FAILURE_CAUSE_RE.test(guardCtx)) return null;
  }

  const ctx = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 120));
  return {
    pattern: 'skill-fallback',
    bug: 'skill body cannot fulfill stated purpose, fell back',
    evidence: `match="${m[0]}" ctx="${ctx.slice(0, 160).replace(/\s+/g, ' ')}"`,
  };
}

/** P3 — tool unavailable, no ToolSearch recovery. */
function classifyToolUnavailable(text) {
  const m = TOOL_VALIDATION_RE.exec(text);
  if (!m) return null;
  // If a ToolSearch call appears AFTER the error, treat as recovered.
  const errIdx = m.index;
  const afterErr = text.slice(errIdx);
  if (TOOLSEARCH_RECOVERY_RE.test(afterErr)) return null;
  return {
    pattern: 'tool-unavailable',
    bug: 'deferred tool used without ToolSearch schema load',
    evidence: `match="${m[0]}" no ToolSearch follow-up`,
  };
}

/**
 * P5 — out-of-scope edits self-reported.
 *
 * #482 — guard against benign completion-report PROSE. The action-anchored
 * matches ("modified files outside ... scope", "went out of scope") are
 * self-grounding and fire directly. A bare "out of scope" / "outside ... scope"
 * phrase only counts as a genuine scope-drift admission when a modification verb
 * (edit/modify/touch/write/change/alter/update/create/delete) sits in the
 * surrounding context window — otherwise it is everyday-English narration
 * ("these were out of scope for the autonomous run", "X is out of scope for this
 * PR") and is rejected.
 */
function classifyOutOfScope(text) {
  const m = OUT_OF_SCOPE_RE.exec(text);
  if (!m) return null;
  const idx = m.index;

  // Self-grounding action-anchored match → fire directly, no extra guard.
  if (!OUT_OF_SCOPE_ACTION_RE.test(m[0])) {
    // Bare narrative phrase — require a corroborating modification verb nearby.
    const guardStart = Math.max(0, idx - OUT_OF_SCOPE_CONTEXT_WINDOW);
    const guardEnd = Math.min(text.length, idx + m[0].length + OUT_OF_SCOPE_CONTEXT_WINDOW);
    const guardCtx = text.slice(guardStart, guardEnd);
    if (!OUT_OF_SCOPE_MODIFY_RE.test(guardCtx)) return null;
  }

  const ctx = text.slice(Math.max(0, idx - 40), Math.min(text.length, idx + 120));
  return {
    pattern: 'out-of-scope',
    bug: 'agent reports modifications outside declared scope',
    evidence: `match="${m[0]}" ctx="${ctx.slice(0, 160).replace(/\s+/g, ' ')}"`,
  };
}

/**
 * #487 — walk UP from `start` to the OUTERMOST git root.
 *
 * findProjectRoot() stops at the FIRST git root walking up from CWD. In a
 * nested-submodule monorepo (a consumer repo whose CWD is a submodule), that
 * first root is the SUBMODULE root, not the monorepo root — so a Write target
 * the agent wrote relative to the monorepo root (e.g. "plans/reports/x.md")
 * resolves under the wrong root and is falsely reported missing.
 *
 * This returns the outermost ancestor directory containing a `.git` entry
 * (file or dir — submodules use a `.git` FILE), or null if none is found.
 * Bounded walk (defensive against pathological depth).
 */
function outermostGitRoot(start) {
  let dir = start;
  let outermost = null;
  let safety = 0;
  while (dir && safety++ < 64) {
    let hasGit = false;
    try { hasGit = fs.existsSync(path.join(dir, '.git')); } catch { /* ignore */ }
    if (hasGit) outermost = dir;
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return outermost;
}

/**
 * #502 — app-root markers. In a monorepo the agent often writes a deliverable
 * with a path RELATIVE to an app subdirectory (e.g. "public/logo.svg" inside
 * apps/marketing-hub/), while the recorded prose only carries the relative
 * form. The file then resolves correctly under the app root but NOT under the
 * monorepo/repo root, producing a false "missing". These marker files identify
 * an app/package root.
 */
const APP_ROOT_MARKERS = ['package.json', 'tsconfig.json'];

/**
 * #502 — shallow, bounded scan for descendant app/package roots under `root`.
 * Returns directories (excluding `root` itself) that contain an app-root marker,
 * up to `maxDepth` levels deep. Skips heavy/irrelevant dirs (node_modules, .git,
 * dot-dirs) to keep the SubagentStop hook fast. Best-effort: any fs error on a
 * branch is swallowed so the walk never throws.
 */
function appRootsUnder(root, maxDepth = 3) {
  const found = [];
  if (!root || typeof root !== 'string') return found;
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'out', 'vendor', 'Library', 'Temp', 'obj', 'bin']);
  const walk = (dir, depth) => {
    if (depth > maxDepth) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (name.startsWith('.') || SKIP.has(name)) continue;
      const child = path.join(dir, name);
      let isAppRoot = false;
      for (const marker of APP_ROOT_MARKERS) {
        try { if (fs.existsSync(path.join(child, marker))) { isAppRoot = true; break; } } catch { /* ignore */ }
      }
      if (isAppRoot) found.push(child);
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

/**
 * #487 / #502 — candidate roots to resolve a relative Write target against, in
 * priority order, deduped. A relative deliverable is only declared MISSING when
 * it is absent under ALL candidate roots — this makes P4 robust to:
 *   - #487 the nested-submodule CWD gap where findProjectRoot() returns the
 *     submodule root instead of the monorepo root the agent wrote relative to;
 *   - #502 the plain single-repo / monorepo app-subdirectory gap where the
 *     deliverable lives at the repo root or under an app subdirectory while the
 *     recorded path is relative to a base that does not contain it.
 *
 * Order (most-to-least specific): explicit CLAUDE_PROJECT_DIR, the resolved
 * projectRoot (findProjectRoot), the process CWD, the outermost git root above
 * CWD/projectRoot (the monorepo root), and — for #502 — every descendant app/
 * package root (dir containing package.json / tsconfig.json) under those roots.
 */
function candidateProjectRoots(projectRoot) {
  const cwd = (() => { try { return process.cwd(); } catch { return null; } })();
  const baseRoots = [
    process.env.CLAUDE_PROJECT_DIR,
    projectRoot,
    cwd,
    cwd ? outermostGitRoot(cwd) : null,
    projectRoot ? outermostGitRoot(projectRoot) : null,
  ];

  const seen = new Set();
  const out = [];
  const push = (c) => {
    if (!c || typeof c !== 'string') return;
    if (seen.has(c)) return;
    seen.add(c);
    out.push(c);
  };

  for (const c of baseRoots) push(c);

  // #502 — augment with descendant app/package roots under each base root so a
  // path written relative to a monorepo app subdir (or a repo whose root holds
  // the file) is resolved. Scan only the outermost-ish roots already collected;
  // deduped via `seen`.
  for (const base of [...out]) {
    for (const appRoot of appRootsUnder(base)) push(appRoot);
  }

  return out;
}

/**
 * P4 — empty deliverable. Walks every claimed Write target in the text and
 * fires for each path that does not exist OR is smaller than the threshold.
 * Returns an array (may be empty); other classifiers return single result.
 *
 * IMPORTANT: this classifier MUST be called with UNSANITIZED text. Sanitization
 * replaces real filesystem paths (e.g. /home/alice/proj/foo.md) with placeholder
 * tokens (e.g. <HOME>/proj/foo.md), which would then fail `fs.statSync()` and
 * either skip P4 entirely or produce false positives on placeholder strings.
 * Evidence strings emitted by this function are sanitized by the caller
 * (detectFailures) before being persisted to the queue.
 */
function classifyEmptyDeliverable(text, projectRoot, threshold) {
  const findings = [];
  const seen = new Set();
  for (const re of WRITE_TARGET_RE_LIST) {
    // Reset lastIndex (regex objects retain state across calls)
    re.lastIndex = 0;
    let m;
    let safety = 0;
    while ((m = re.exec(text)) !== null && safety++ < 20) {
      let candidate = (m[1] || '').trim();
      if (!candidate || seen.has(candidate)) continue;

      // #397 — skip intention/future-tense framing ("I will write to X",
      // "let me create X", "next I'll save to X"). The path's absence is
      // expected for announced-but-not-yet-written work. Inspect the short
      // window immediately before the matched verb. Note: we do NOT add the
      // candidate to `seen` here, so a later genuine completion claim for the
      // same path in the same text can still fire.
      const before = text.slice(Math.max(0, m.index - INTENT_CONTEXT_WINDOW), m.index);
      if (INTENT_CONTEXT_RE.test(before)) continue;

      seen.add(candidate);

      // #487 — build the list of roots to resolve a RELATIVE candidate against.
      // Absolute / home-relative paths resolve to a single location; relative
      // paths are checked against every candidate root (CLAUDE_PROJECT_DIR,
      // findProjectRoot, CWD, outermost-git-root) so a nested-submodule CWD does
      // not falsely report a deliverable written relative to the monorepo root
      // as missing.
      let resolveRoots;
      let isHomeRelative = false;
      if (path.isAbsolute(candidate)) {
        resolveRoots = [null]; // sentinel — candidate is already absolute
      } else if (candidate.startsWith('~/')) {
        isHomeRelative = true;
        resolveRoots = [null];
      } else {
        resolveRoots = candidateProjectRoots(projectRoot);
        if (resolveRoots.length === 0) resolveRoots = [projectRoot];
      }

      // Try each candidate root; the FIRST root under which the file exists wins.
      // A deliverable is only flagged when it is absent (or near-empty) under
      // ALL candidate roots.
      let exists = false;
      let size = 0;
      let sawSafePath = false;
      for (const root of resolveRoots) {
        let resolved;
        if (root === null) {
          resolved = isHomeRelative
            ? path.join(os.homedir() || '', candidate.slice(2))
            : candidate;
        } else {
          resolved = path.join(root, candidate);
        }

        // Confine to project root(s) or home for safety — never stat arbitrary disk
        let safe;
        try {
          safe = safeResolve(resolved, [...resolveRoots.filter(Boolean), os.homedir(), os.tmpdir()]);
        } catch (e) {
          if (e instanceof SafePathError) continue;
          throw e;
        }
        sawSafePath = true;

        try {
          const stat = fs.statSync(safe);
          exists = true;
          size = stat.size;
          break; // found it under this root — stop trying further roots
        } catch { /* missing under this root — try the next */ }
      }

      // Every candidate resolution was rejected by safeResolve → skip the
      // candidate entirely (matches the pre-#487 behavior of a single unsafe path).
      if (!sawSafePath) continue;

      if (!exists) {
        findings.push({
          pattern: 'empty-deliverable',
          bug: `claimed Write target does not exist: ${candidate}`,
          evidence: `path="${candidate}" missing`,
        });
      } else if (size < threshold) {
        findings.push({
          pattern: 'empty-deliverable',
          bug: `claimed Write target is empty or near-empty: ${candidate}`,
          evidence: `path="${candidate}" bytes=${size}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Apply all 5 patterns. Returns flat array of findings.
 *   { pattern, bug, evidence }
 *
 * P1/P2/P3/P5 run on sanitized text (no path/secret sensitivity in their regex
 * triggers). P4 (empty-deliverable) MUST run on UNSANITIZED text because it
 * stat()s claimed Write targets from disk — sanitization would replace real
 * paths with placeholders before stat resolution. The caller is responsible
 * for passing the raw turn text alongside the sanitized text; if rawText is
 * omitted, P4 is skipped (fail-safe).
 *
 * Evidence strings emitted by P4 contain raw paths and must be sanitized by
 * the caller before being persisted to the queue. See callsite in main().
 */
function detectFailures(text, totalTokens, cfg, projectRoot, rawText, opts) {
  const findings = [];
  if (!text) return findings;

  // Prose-only patterns (P1 mid-task-stop, P2 skill-fallback, P5 out-of-scope)
  // are the ones prone to MAIN-loop false positives: they match narration the
  // main agent writes between tool calls. Gate them on a genuine sub-agent
  // termination — a present, non-"unknown" agent_type. When the SubagentStop
  // payload carries no real agent_type we are almost certainly reading the main
  // session transcript (observed: skill="agent:unknown" entries), so prose
  // patterns are suppressed. P3 (tool-unavailable, needs the literal
  // InputValidationError token) and P4 (empty-deliverable, disk-verified) are
  // self-grounding and run unconditionally.
  const genuineAgent = !!(opts && opts.genuineAgent);

  if (genuineAgent) {
    const r1 = classifyMidTaskStop(text, totalTokens, cfg.midTaskTokenThreshold, cfg.midTaskTokenCeiling);
    if (r1) findings.push(r1);

    const r2 = classifySkillFallback(text);
    if (r2) findings.push(r2);

    const r5 = classifyOutOfScope(text);
    if (r5) findings.push(r5);
  }

  const r3 = classifyToolUnavailable(text);
  if (r3) findings.push(r3);

  if (rawText) {
    const r4s = classifyEmptyDeliverable(rawText, projectRoot, cfg.emptyDeliverableBytes);
    for (const f of r4s) findings.push(f);
  }

  return findings;
}

/**
 * Write a crash log line. Never throws.
 */
function logCrash(err) {
  try {
    const logPath = path.join(defaultGlobalClaudeDir(), CRASH_LOG_FILENAME);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const line = `[${new Date().toISOString()}] ${err && err.stack ? err.stack : String(err)}\n`;
    fs.appendFileSync(logPath, line);
  } catch { /* truly give up */ }
}

function main() {
  try {
    if (!isTelemetryEnabled()) return 0;

    const resolved = resolveClaudeDir();
    if (!resolved) return 0;
    const claudeDir = resolved.claudeDir;

    const cfg = readConfig(claudeDir);
    if (!cfg.enabled) return 0;

    const hookData = parseHookStdin() || {};
    const timer = createHookTimer('workflow-failure-detector');

    // Validate transcript_path BEFORE reading — same defense-in-depth as lesson-collector
    const rawTranscriptPath = hookData.transcript_path;
    let transcriptPath = null;
    if (rawTranscriptPath) {
      try {
        transcriptPath = safeResolve(rawTranscriptPath, [os.tmpdir(), os.homedir()]);
      } catch (e) {
        if (e instanceof SafePathError) {
          timer.end({ outcome: 'skip', note: 'unsafe-transcript-path' });
          return 0;
        }
        throw e;
      }
    }

    if (!transcriptPath) {
      // Fall back to inline text if testing supplies it
      if (typeof hookData.text === 'string' && hookData.text) {
        // Test harness path — proceed with inline text below
      } else {
        timer.end({ outcome: 'skip', note: 'no-transcript-path' });
        return 0;
      }
    }

    const turn = transcriptPath
      ? extractFinalTurn(transcriptPath)
      : { text: hookData.text || '', totalTokens: hookData.total_tokens || 0 };

    if (!turn.text) {
      timer.end({ outcome: 'skip', note: 'no-turn-text' });
      return 0;
    }

    const home = os.homedir() || '';
    const cwd = process.cwd();
    const projectRoot = findProjectRoot();
    const scrubbed = sanitizeEvidence(turn.text, cwd, home);

    // A genuine isolated sub-agent termination carries a present, non-"unknown"
    // agent_type. Prose-only patterns (P1/P2/P5) are suppressed without it to
    // avoid matching main-loop narration. The test-harness inline-text path
    // (hookData.text set, no transcript) sets agent_type explicitly when it
    // wants to exercise the prose patterns.
    const rawAgentType = typeof hookData.agent_type === 'string' ? hookData.agent_type.trim() : '';
    const genuineAgent = rawAgentType.length > 0 && rawAgentType !== 'unknown';

    // Pass BOTH sanitized (for P1/P2/P3/P5) and raw (for P4 disk-stat) text.
    // P4 emits evidence containing real paths; sanitize each finding's bug +
    // evidence below before persisting.
    const findings = detectFailures(scrubbed, turn.totalTokens, cfg, projectRoot, turn.text, { genuineAgent });
    if (findings.length === 0) {
      timer.end({ outcome: 'skip', note: 'no-findings' });
      return 0;
    }

    // P4 findings carry raw paths in bug + evidence — sanitize per-finding so
    // the queue never persists user filesystem paths or secrets.
    for (const f of findings) {
      if (f.pattern === 'empty-deliverable') {
        f.bug = sanitizeEvidence(f.bug, cwd, home);
        f.evidence = sanitizeEvidence(f.evidence, cwd, home);
      }
    }

    // Scope dedup cache to workflow-failure (mirror of lesson-collector pattern)
    const cachePath = path.join(defaultGlobalClaudeDir(), CACHE_FILENAME);
    const prevCacheEnv = process.env.T1K_KIT_ERROR_CACHE_PATH;
    process.env.T1K_KIT_ERROR_CACHE_PATH = cachePath;
    const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

    const telemetryDir = ensureTelemetryDir();
    const queuePath = path.join(telemetryDir, QUEUE_FILENAME);
    const sessionId = computeSessionId();

    // Per-pattern rate limiter (separate counter file per pattern this session)
    const rateDir = path.join(os.tmpdir(), RATE_DIR_NAME);
    if (!fs.existsSync(rateDir)) {
      try { fs.mkdirSync(rateDir, { recursive: true }); } catch { /* ok */ }
    }
    function patternCounterFile(pattern) {
      return path.join(rateDir, `${sessionId}.${pattern}.count`);
    }
    function readPatternCount(pattern) {
      try {
        const p = patternCounterFile(pattern);
        if (!fs.existsSync(p)) return 0;
        return parseInt(fs.readFileSync(p, 'utf8'), 10) || 0;
      } catch { return 0; }
    }
    function writePatternCount(pattern, n) {
      try { fs.writeFileSync(patternCounterFile(pattern), String(n)); } catch { /* ok */ }
    }

    const isDryRun = process.env[DRY_RUN_ENV] === '1';
    const nowIso = new Date().toISOString();
    const agentType = (typeof hookData.agent_type === 'string' && hookData.agent_type) || 'unknown';

    // Origin defaults — workflow failures by definition belong to the kit that
    // owns the failing agent/skill. The queue processor uses kit + skill to
    // resolve repo; we provide best-effort here.
    const originKit = 'theonekit-core';
    const skillSlug = `agent:${agentType}`;

    let queuedThisRun = 0;
    let droppedDuplicate = 0;
    let droppedRateLimit = 0;
    const enqueued = [];

    for (const finding of findings) {
      const ptn = finding.pattern;
      const sessionCount = readPatternCount(ptn);
      if (sessionCount >= cfg.maxPerPatternPerSession) {
        droppedRateLimit++;
        logHook('workflow-failure-detector', { drop: 'rate-limited', pattern: ptn });
        continue;
      }

      const fp = fingerprint(
        { tool: 'workflow-failure', cmd: ptn, stderrHead: finding.evidence },
        { reason: ptn, originKit }
      );
      const dedup = checkAndRecord(fp, {
        reason: ptn,
        originKit,
        maxAgeDays: cfg.dedupeTTLDays,
      });

      if (dedup.isDuplicate) {
        droppedDuplicate++;
        logHook('workflow-failure-detector', { drop: 'duplicate', pattern: ptn, fp });
        continue;
      }

      const entry = {
        ts: nowIso,
        type: 'skill-bug',
        fingerprint: fp,
        kit: originKit,
        skill: skillSlug,
        payload: {
          bug: finding.bug,
          evidence: finding.evidence,
          pattern: ptn,
          agentType,
          sessionId,
        },
        sessionId,
        dryRun: isDryRun,
        submitted: false,
        submittedAt: null,
        prUrl: null,
        issueUrl: null,
        source: 'workflow-failure-detector',
      };

      try { fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }

      if (isDryRun) {
        try {
          const logPath = path.join(defaultGlobalClaudeDir(), '.workflow-failure-dry-run.log');
          const logDir = path.dirname(logPath);
          if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
          fs.appendFileSync(
            logPath,
            `[${nowIso}] DRY_RUN fp=${fp} pattern=${ptn} agent=${agentType}\n`
          );
        } catch { /* ok */ }
      }

      writePatternCount(ptn, sessionCount + 1);
      queuedThisRun++;
      enqueued.push({ pattern: ptn, fp });
    }

    // Restore the cache env so other hooks don't inherit our scoped path
    if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
    else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;

    if (queuedThisRun > 0) {
      const dryTag = isDryRun ? ' dryRun=1' : '';
      const patterns = enqueued.map(e => e.pattern).join(',');
      console.log(
        `[t1k:workflow-failure-detected] count=${queuedThisRun} patterns=${patterns} agent=${agentType}${dryTag}`
      );
    }

    logHook('workflow-failure-detector', {
      queued: queuedThisRun,
      duplicate: droppedDuplicate,
      rateLimited: droppedRateLimit,
      dryRun: isDryRun,
      agentType,
    });
    timer.end({ outcome: 'ok' });
    return 0;
  } catch (e) {
    logCrash(e);
    return 0; // fail-open
  }
}

// Spawned as a hook: run main and exit. Required as a module: just export.
if (require.main === module) {
  process.exit(main());
}

module.exports = {
  MID_TASK_TAIL_RE,
  SKILL_FALLBACK_RE,
  FALLBACK_FAILURE_CAUSE_RE,
  FALLBACK_DOMAIN_DENYLIST_RE,
  TOOL_VALIDATION_RE,
  TOOLSEARCH_RECOVERY_RE,
  OUT_OF_SCOPE_RE,
  OUT_OF_SCOPE_ACTION_RE,
  OUT_OF_SCOPE_MODIFY_RE,
  WRITE_TARGET_RE_LIST,
  readConfig,
  extractFinalTurn,
  extractTextFromEntry,
  sanitizeEvidence,
  classifyMidTaskStop,
  classifySkillFallback,
  classifyToolUnavailable,
  classifyOutOfScope,
  classifyEmptyDeliverable,
  outermostGitRoot,
  appRootsUnder,
  candidateProjectRoots,
  detectFailures,
  main,
};
