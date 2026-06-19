#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * unresolved-question-linter.cjs — UserPromptSubmit hook.
 *
 * Enforces ~/.claude/rules/always-ask-on-unresolved.md by scanning the previous
 * assistant turn for prose-style unresolved questions and emitting a strong
 * system-reminder so the AI converts them to AskUserQuestion before proceeding.
 *
 * Detects:
 *   - "Open Questions" / "Unresolved Questions" / "Pending Decisions" headers
 *   - Inline phrases: "Pick #N and answer...", "unless you object", "which approach do you prefer"
 *   - Numbered question lists: 3+ sequential lines ending in "?"
 *
 * Heuristic — tuned for false-negative tolerance over false-positive risk.
 * If pattern fires on legitimate prose, AI can dismiss; if pattern misses a
 * real violation, AI self-polices via the rule (next-turn pickup).
 *
 * Fail-open: any exception → process.exit(0), never block the user.
 */
'use strict';

const fs = require('fs');

const VIOLATION_PATTERNS = [
  { name: 'open_questions_header', re: /^#{1,4}\s*open\s+questions?\s*$/im },
  { name: 'unresolved_header', re: /^#{1,4}\s*unresolved\s+(questions?|items?|decisions?)\s*$/im },
  { name: 'pending_decisions_header', re: /^#{1,4}\s*pending\s+(decisions?|questions?)\s*$/im },
  { name: 'bold_open_questions', re: /\*\*open\s+questions?\*\*/i },
  { name: 'pick_and_answer', re: /\bpick\s+#?\d+\s+and\s+answer/i },
  { name: 'unless_object', re: /\bunless\s+you\s+(object|disagree|say\s+otherwise)\b/i },
  { name: 'inline_open_questions', re: /\bopen\s+questions?\s+(before|to\s+resolve|remaining|for\s+you)\b/i },
  { name: 'tbd_marker', re: /\b(TBD|TODO|FIXME)\s*[:\-]\s*\S/m },
];

function hasNumberedQuestionList(text) {
  const lines = text.split('\n');
  let run = 0;
  for (const line of lines) {
    if (/^\s*\d+\.\s+.{8,}\?\s*$/.test(line)) {
      run++;
      if (run >= 3) return true;
    } else if (line.trim() !== '') {
      run = 0;
    }
  }
  return false;
}

function detectViolations(text) {
  const found = [];
  for (const { name, re } of VIOLATION_PATTERNS) {
    if (re.test(text)) found.push(name);
  }
  if (hasNumberedQuestionList(text)) found.push('numbered_question_list');
  return found;
}

function extractLastAssistantTurn(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return '';
  try {
    const raw = fs.readFileSync(transcriptPath, 'utf8');
    const lines = raw.trim().split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry || (entry.type !== 'assistant' && entry.role !== 'assistant')) continue;
      const parts = [];
      const candidates = [entry.message, entry, entry.delta];
      for (const c of candidates) {
        if (!c) continue;
        if (typeof c.content === 'string') parts.push(c.content);
        else if (Array.isArray(c.content)) {
          for (const block of c.content) {
            if (block && typeof block === 'object' && typeof block.text === 'string') {
              parts.push(block.text);
            }
          }
        }
      }
      const text = parts.join('\n').trim();
      if (text) return text;
    }
  } catch { /* fall through */ }
  return '';
}

function main() {
  try {
    const stdin = fs.readFileSync(0, 'utf8').trim();
    if (!stdin) return 0;
    let payload;
    try { payload = JSON.parse(stdin); } catch { return 0; }

    const text = extractLastAssistantTurn(payload.transcript_path);
    if (!text) return 0;

    // Skip if previous turn already invoked AskUserQuestion — the rule is satisfied.
    if (/AskUserQuestion|<tool_use[^>]*name="AskUserQuestion"/i.test(text)) return 0;

    const violations = detectViolations(text);
    if (violations.length === 0) return 0;

    const list = violations.slice(0, 4).join(', ');
    process.stdout.write(
      `[t1k:unresolved-questions-detected] count=${violations.length} patterns="${list}"\n\n` +
      `RULE VIOLATION (~/.claude/rules/always-ask-on-unresolved.md): your previous ` +
      `assistant turn contained prose-style unresolved questions. All open questions, ` +
      `TBDs, "Open Questions" sections, or numbered ?-lists MUST be batched into ` +
      `AskUserQuestion before proceeding past them. Re-read your previous turn and ` +
      `convert remaining unresolved items to AskUserQuestion calls before answering ` +
      `the current user prompt.\n`
    );

    return 0;
  } catch {
    return 0;
  }
}

process.exit(main() || 0);
