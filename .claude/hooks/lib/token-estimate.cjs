#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// token-estimate.cjs — Shared token-budget utilities.
//
// Exports:
//   estimateTokens(content: string) → number
//     Char/4 heuristic — matches the inline formula previously in
//     check-claude-md-bloat.cjs and the release-time gate
//     validate-context-window-budget.cjs in theonekit-release-action.
//
//   sumTokens(paths: string[]) → number
//     Reads each file and sums estimates. Skips missing files with a console
//     log (not a throw) so callers get a partial sum rather than a hard fail.
//
// Cross-platform: no /dev/stdin, no 2>/dev/null, uses path.join().

'use strict';

const fs   = require('node:fs');
const path = require('node:path');

const CHARS_PER_TOKEN = 4;

/**
 * Estimate token count using the char/4 heuristic.
 * @param {string} content
 * @returns {number}
 */
function estimateTokens(content) {
  if (!content) return 0;
  return Math.ceil(content.length / CHARS_PER_TOKEN);
}

/**
 * Read each file in `paths`, estimate its token count, and return the sum.
 * Files that do not exist or cannot be read are skipped with a console log.
 * @param {string[]} paths  — absolute or CWD-relative file paths
 * @returns {number}
 */
function sumTokens(paths) {
  let total = 0;
  for (const filePath of paths) {
    if (!fs.existsSync(filePath)) {
      console.log(`[token-estimate] sumTokens: skip (missing) ${filePath}`);
      continue;
    }
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
      console.log(`[token-estimate] sumTokens: skip (read error) ${filePath} — ${err.message}`);
      continue;
    }
    total += estimateTokens(content);
  }
  return total;
}

module.exports = { estimateTokens, sumTokens };
