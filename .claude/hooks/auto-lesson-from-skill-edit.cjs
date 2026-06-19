#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * auto-lesson-from-skill-edit.cjs — PostToolUse hook for Edit / Write / MultiEdit.
 *
 * Closes the "AI forgot to emit a lesson marker" gap in the auto-lesson
 * pipeline. When the AI edits a skill's `references/*.md` gotcha file
 * (or appends a new section to SKILL.md) the hook reads the file's
 * `origin:` frontmatter (or its containing SKILL.md's frontmatter)
 * and appends a pre-built lesson entry to
 * `.claude/telemetry/pending-skill-updates.jsonl` — the same queue
 * `lesson-collector.cjs` Stop hook writes to.
 *
 * The next `UserPromptSubmit` hook's `lesson-queue-processor.cjs`
 * picks up the entry and emits the standard system-reminder asking
 * the AI to spawn the background `/t1k:sync-back` sub-agent, just as
 * if the AI had emitted the marker by hand.
 *
 * Pipeline (PostToolUse fires AFTER the Edit/Write tool completes):
 *   parse stdin → resolve file_path → match skill-ref glob →
 *   read SKILL.md frontmatter for kit/skill/module →
 *   detect new section heading via `git diff --unified=0 HEAD -- <path>` →
 *   sanitize → fingerprint + 7-day TTL dedup → rate-limit (5/session) →
 *   append queue entry → emit `[t1k:auto-lesson-from-skill-edit]` stdout
 *
 * Reuses (no duplicate utilities):
 *   - sanitize from lib/kit-error-sanitizer.cjs
 *   - fingerprint()/checkAndRecord() from lib/kit-error-dedup.cjs
 *   - parseHookStdin / resolveClaudeDir / ensureTelemetryDir / T1K
 *     constants from telemetry-utils.cjs
 *   - safeResolve from lib/safe-paths.cjs (path-traversal guard)
 *
 * Fail-open: any exception → process.exit(0), never block the user.
 *
 * Flag: same `features.autoLessonSync` block that gates `lesson-collector.cjs`.
 * Env override: T1K_AUTO_LESSON_FROM_EDIT=0 force-disables this hook only,
 *   for cases where Stop-hook marker collection is preferred (e.g., test runs).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

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

const QUEUE_FILENAME = 'pending-skill-updates.jsonl';
const CACHE_FILENAME = '.lesson-fingerprints.json';
const FEATURE_FLAG = 'autoLessonSync';
const HOOK_DISABLE_ENV = 'T1K_AUTO_LESSON_FROM_EDIT';
const MAX_PER_SESSION = 5;
const DEDUPE_TTL_DAYS = 7;

// Glob-like matcher: `.claude/skills/<slug>/references/*.md` or `.claude/skills/<slug>/SKILL.md`.
// Returns { skillDir, refFile } on match; null on miss. file_path may be absolute
// or relative to the project root.
function matchSkillRef(filePath, projectRoot) {
  if (typeof filePath !== 'string' || !filePath.endsWith('.md')) return null;
  const rel = path.isAbsolute(filePath)
    ? path.relative(projectRoot, filePath)
    : filePath;
  // Normalise Windows separators
  const norm = rel.split(path.sep).join('/');
  const m = norm.match(/^\.claude\/skills\/([^/]+)\/(?:(SKILL\.md)|references\/([^/]+\.md))$/);
  if (!m) return null;
  const slug = m[1];
  const refFile = m[2] ? 'SKILL.md' : `references/${m[3]}`;
  return {
    skillDir: path.join(projectRoot, '.claude', 'skills', slug),
    refFile,
    slug,
  };
}

// Lift kit / skill / module from SKILL.md frontmatter.
function readSkillFrontmatter(skillDir) {
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return null;
  let raw;
  try { raw = fs.readFileSync(skillMd, 'utf8'); } catch { return null; }
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) return null;
  const fm = fmMatch[1];
  const get = (key) => {
    const re = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm');
    const v = fm.match(re);
    return v ? v[1].replace(/^["']|["']$/g, '') : null;
  };
  return {
    name: get('name'),         // e.g. "t1k:unity:dots-core:ecs-core"
    origin: get('origin'),     // e.g. "theonekit-unity"
    repository: get('repository'),
    module: get('module'),     // e.g. "dots-core"
    version: get('version'),
  };
}

// Detect whether THIS edit added a new section heading (lines starting with `## ` or `### `).
// Returns the heading text if so, else null. Uses git diff against HEAD — falls back
// to "scan file for any section heading" if git isn't available or the file is new.
function detectNewSectionHeading(filePath) {
  try {
    const out = execFileSync(
      'git',
      ['diff', '--unified=0', 'HEAD', '--', filePath],
      { encoding: 'utf8', cwd: path.dirname(filePath), stdio: ['ignore', 'pipe', 'ignore'] }
    );
    if (!out) return null;
    const addedHeadings = [];
    for (const line of out.split('\n')) {
      if (!line.startsWith('+')) continue;
      if (line.startsWith('+++')) continue;
      const text = line.slice(1); // drop the `+`
      const h = text.match(/^#{2,3}\s+(.+?)\s*$/);
      if (h) addedHeadings.push(h[1]);
    }
    if (addedHeadings.length === 0) return null;
    // Prefer the first added heading — fix-up edits to existing sections rarely add headings.
    return addedHeadings[0];
  } catch {
    return null;
  }
}

// Resolve project root from cwd by walking up until a .claude/ dir is found.
function resolveProjectRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

function readAutoLessonFlag(claudeDir) {
  // Symmetric env kill switch: same convention as lesson-collector.cjs.
  const envValue = process.env[HOOK_DISABLE_ENV];
  if (envValue === '0' || envValue === 'false') return false;
  if (envValue === '1' || envValue === 'true') return true;
  // Fall through to the shared feature flag — gate on the same setting that
  // governs the marker-driven pipeline, so a single config switch turns the
  // whole auto-lesson system on/off.
  return readFeatureFlag(claudeDir, FEATURE_FLAG, false);
}

function computeSessionId() {
  // Reuse the same session derivation pattern as lesson-collector.cjs: per-tty +
  // per-cwd + per-ppid, hashed. Falls back to a date stamp if any source is missing.
  const crypto = require('crypto');
  const parts = [process.env.SHELL || '', process.cwd(), String(process.ppid || 0)];
  return crypto.createHash('md5').update(parts.join('|')).digest('hex').slice(0, 12);
}

function defaultGlobalClaudeDir() {
  return path.join(os.homedir() || '', '.claude');
}

function main() {
  try {
    if (!isTelemetryEnabled()) return 0;

    const hookData = parseHookStdin() || {};
    const toolName = hookData.tool_name;
    if (toolName !== 'Edit' && toolName !== 'Write' && toolName !== 'MultiEdit') return 0;

    const filePathRaw = hookData.tool_input && hookData.tool_input.file_path;
    if (!filePathRaw) return 0;

    const projectRoot = resolveProjectRoot(process.cwd());
    if (!projectRoot) return 0;

    const match = matchSkillRef(filePathRaw, projectRoot);
    if (!match) return 0;

    const resolved = resolveClaudeDir();
    if (!resolved) return 0;
    const claudeDir = resolved.claudeDir;

    if (!readAutoLessonFlag(claudeDir)) return 0;

    const timer = createHookTimer('auto-lesson-from-skill-edit');

    const fm = readSkillFrontmatter(match.skillDir);
    if (!fm || !fm.name || !fm.origin) {
      timer.end({ outcome: 'skip', note: 'no-frontmatter' });
      return 0;
    }

    // Resolve absolute file path under safeResolve for the git-diff probe.
    let absFilePath;
    try {
      absFilePath = safeResolve(filePathRaw, [projectRoot]);
    } catch (e) {
      if (e instanceof SafePathError) {
        timer.end({ outcome: 'skip', note: 'unsafe-path' });
        return 0;
      }
      throw e;
    }
    if (!fs.existsSync(absFilePath)) {
      timer.end({ outcome: 'skip', note: 'file-missing' });
      return 0;
    }

    const heading = detectNewSectionHeading(absFilePath);
    if (!heading) {
      timer.end({ outcome: 'skip', note: 'no-new-heading' });
      return 0;
    }

    // Build the lesson payload using the SAME shape as lesson-collector.cjs entries.
    // Sanitize the heading + frontmatter values before persisting.
    const home = os.homedir() || '';
    const cwd = process.cwd();
    const safeHeading = sanitizer.sanitizeContent
      ? sanitizer.sanitizeContent(heading, cwd, home)
      : heading;

    // Skill name like "t1k:unity:dots-core:ecs-core" → keep the last 2 segments
    // ("dots-core:ecs-core") to match the schema lesson-collector.cjs produces.
    const skillShort = fm.name.split(':').slice(-2).join(':');

    const reason =
      `Auto-emitted by auto-lesson-from-skill-edit hook — new section "${safeHeading}" added ` +
      `to ${match.refFile}. Propagate to ${fm.origin} so all consumers receive the gotcha.`;

    const marker = {
      type: 'lesson',
      kit: fm.origin,
      skill: skillShort,
      primary: safeHeading,
      payload: {
        fragment: match.refFile,
        reason,
        skillFullName: fm.name,
        skillModule: fm.module,
        skillRepository: fm.repository,
        skillVersion: fm.version,
        triggerTool: toolName,
        triggerFilePath: match.refFile,
        emittedBy: 'auto-lesson-from-skill-edit',
      },
    };

    // Dedup using the same cache as lesson-collector.cjs to prevent the AI emitting
    // a marker AND this hook firing for the same edit (double-PR risk). The
    // fingerprint is keyed by (skill, refFile, heading) so re-edits of the same
    // section within 7 days collapse to one queue entry.
    const cachePath = path.join(defaultGlobalClaudeDir(), CACHE_FILENAME);
    const prevCacheEnv = process.env.T1K_KIT_ERROR_CACHE_PATH;
    process.env.T1K_KIT_ERROR_CACHE_PATH = cachePath;
    const { fingerprint, checkAndRecord } = require('./lib/kit-error-dedup.cjs');

    const fp = fingerprint(
      { tool: 'lesson', cmd: 'auto-lesson', stderrHead: `${skillShort}|${match.refFile}|${safeHeading}` },
      { reason: 'lesson', originKit: fm.origin }
    );
    const dedup = checkAndRecord(fp, {
      reason: 'lesson',
      originKit: fm.origin,
      maxAgeDays: DEDUPE_TTL_DAYS,
    });

    if (prevCacheEnv === undefined) delete process.env.T1K_KIT_ERROR_CACHE_PATH;
    else process.env.T1K_KIT_ERROR_CACHE_PATH = prevCacheEnv;

    if (dedup.isDuplicate) {
      timer.end({ outcome: 'skip', note: 'duplicate', fp });
      return 0;
    }

    // Per-session rate limit (same cap as lesson-collector.cjs to keep the
    // combined pipeline noise budget predictable).
    const RATE_DIR_NAME = 't1k-lesson-sync';
    const rateDir = path.join(os.tmpdir(), RATE_DIR_NAME);
    if (!fs.existsSync(rateDir)) {
      try { fs.mkdirSync(rateDir, { recursive: true }); } catch { /* ok */ }
    }
    const sessionId = computeSessionId();
    const counterFile = path.join(rateDir, `${sessionId}.count`);
    let sessionCount = 0;
    try {
      if (fs.existsSync(counterFile)) {
        sessionCount = parseInt(fs.readFileSync(counterFile, 'utf8'), 10) || 0;
      }
    } catch { /* ok */ }

    if (sessionCount >= MAX_PER_SESSION) {
      timer.end({ outcome: 'skip', note: 'rate-limited' });
      return 0;
    }

    const telemetryDir = ensureTelemetryDir();
    const queuePath = path.join(telemetryDir, QUEUE_FILENAME);
    const nowIso = new Date().toISOString();

    const entry = {
      ts: nowIso,
      type: 'lesson',
      fingerprint: fp,
      kit: marker.kit,
      skill: marker.skill,
      payload: marker.payload,
      sessionId,
      dryRun: false,
      submitted: false,
      submittedAt: null,
      prUrl: null,
      issueUrl: null,
      emittedBy: 'auto-lesson-from-skill-edit',
    };

    try { fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n'); } catch { /* ok */ }
    try { fs.writeFileSync(counterFile, String(sessionCount + 1)); } catch { /* ok */ }

    console.log(
      `[t1k:auto-lesson-from-skill-edit] kit=${marker.kit} skill=${marker.skill} ` +
      `fragment="${match.refFile}" heading="${safeHeading.slice(0, 60)}" fp=${fp}`
    );

    timer.end({ outcome: 'queued', fp, kit: marker.kit, skill: marker.skill });
    return 0;
  } catch (err) {
    // Fail-open: never block tool execution because of a probe failure.
    try { logHook('auto-lesson-from-skill-edit', { error: err && err.message }); } catch { /* ok */ }
    return 0;
  }
}

process.exit(main());
