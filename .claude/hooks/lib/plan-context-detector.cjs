// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * plan-context-detector.cjs — Detect if /t1k:plan is the active Skill-tool context
 *
 * Reads the last ~64 KB of the transcript JSONL and scans in reverse to find
 * the most recent `Skill` tool_use entry. Returns true iff that entry invoked
 * the plan skill. Fail-open: any I/O or parse error returns false.
 *
 * Cross-platform: no shell commands, uses fs + path only.
 * Standalone — no external dependencies.
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** Maximum bytes to tail-read from the transcript to bound memory usage. */
const TAIL_BYTES = 64 * 1024; // 64 KB

/**
 * Normalise a skill name to a canonical short form.
 * Strips leading 't1k:' or 't1k-' prefix.
 * @param {string} raw
 * @returns {string}
 */
function normaliseSkillName(raw) {
  if (typeof raw !== 'string') return '';
  if (raw.startsWith('t1k:')) return raw.slice(4);
  if (raw.startsWith('t1k-')) return raw.slice(4);
  return raw;
}

/** Canonical names that mean "the plan skill is active". */
const PLAN_SKILL_NAMES = new Set(['plan', 't1k:plan', 't1k-plan']);

/**
 * Determine whether the /t1k:plan skill is the most recently active skill in the
 * given transcript file.
 *
 * Algorithm:
 * 1. Tail-read the last TAIL_BYTES of the JSONL file.
 * 2. Split on newlines, parse each line as JSON (skip invalid).
 * 3. Scan in reverse order (newest first).
 * 4. Return true on the first `Skill` tool_use whose skill name is a plan name.
 * 5. Return false on any other `Skill` tool_use (a different skill took over).
 * 6. Return false if no `Skill` tool_use is found in the window.
 *
 * @param {string|null|undefined} transcriptPath
 * @returns {boolean}
 */
function isPlanContextActive(transcriptPath) {
  try {
    if (!transcriptPath || typeof transcriptPath !== 'string') return false;
    if (!fs.existsSync(transcriptPath)) return false;

    const stat = fs.statSync(transcriptPath);
    const fileSize = stat.size;
    if (fileSize === 0) return false;

    // Tail-read: open file, seek to max(0, fileSize - TAIL_BYTES), read remainder
    const readStart = Math.max(0, fileSize - TAIL_BYTES);
    const readLength = fileSize - readStart;
    const buf = Buffer.alloc(readLength);
    const fd = fs.openSync(transcriptPath, 'r');
    let bytesRead = 0;
    try {
      bytesRead = fs.readSync(fd, buf, 0, readLength, readStart);
    } finally {
      fs.closeSync(fd);
    }

    const raw = buf.toString('utf8', 0, bytesRead);
    const lines = raw.split('\n');

    // Parse valid JSON lines (skip empty / partial first line from mid-file read)
    const entries = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        entries.push(JSON.parse(trimmed));
      } catch {
        // skip unparseable lines (first line may be a partial record)
      }
    }

    // Scan in reverse — newest first
    for (let i = entries.length - 1; i >= 0; i--) {
      const entry = entries[i];
      if (!entry || typeof entry !== 'object') continue;

      // Claude Code transcript JSONL uses type="tool_use" with name="Skill"
      // for Skill tool invocations. The skill name is in entry.input.skill.
      if (entry.type === 'tool_use' && entry.name === 'Skill') {
        const skillRaw = entry.input && entry.input.skill;
        if (!skillRaw) return false; // Skill call without a skill name — not plan
        const normalised = normaliseSkillName(String(skillRaw));
        if (PLAN_SKILL_NAMES.has(skillRaw) || PLAN_SKILL_NAMES.has('t1k:' + normalised)) {
          return true;
        }
        return false; // A different skill took over
      }
    }

    return false; // No Skill tool_use found in the window
  } catch {
    return false; // Fail-open: any error → not plan context
  }
}

module.exports = { isPlanContextActive };
