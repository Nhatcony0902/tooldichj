#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * kit-owned-file-modified.cjs — PostToolUse hook: nudge sync-back after edits to kit-owned files.
 *
 * Closes #273 (skill-sync-reminder only matched .claude/skills/, missed
 * rules/, agents/, modules/, hooks/, and any kit-owned file living
 * outside the conventional .claude/ subtree).
 *
 * Detection (either signal is sufficient — combined approach A + C from #273):
 *   A) Path-based: file under .claude/{rules,agents,modules,hooks,skills}/
 *   C) Metadata-based: file's first ~20 lines contain a kit-origin marker —
 *      - YAML frontmatter `origin: <kit>` (.md skill/agent/rule files)
 *      - JSON `_origin.kit` field (module.json files)
 *      - Comment `t1k-origin: kit=<kit>` (.cjs hook files)
 *
 * When matched, emits ONE line per edit:
 *   [t1k:sync-back-suggested kit="<kit>" file="<rel-path>" reason="kit-owned file modified"]
 * AND appends a JSONL row to .claude/telemetry/sync-back-suggestions-<sessionKey>.jsonl
 * so the SessionEnd rollup (sync-back-rollup.cjs) can emit ONE consolidated
 * summary at session-end instead of per-edit nag spam (combined approach E).
 *
 * Non-blocking (PostToolUse cannot block). Fail-open: any exception → exit 0.
 *
 * Reuses (no duplicate utilities):
 *   - parseHookStdin, findProjectRoot, ensureTelemetryDir, computeTeammateSessionKey,
 *     T1K constants from telemetry-utils.cjs
 */
'use strict';

const fs = require('fs');
const path = require('path');

try {
  const {
    parseHookStdin,
    findProjectRoot,
    ensureTelemetryDir,
    computeTeammateSessionKey,
  } = require('./telemetry-utils.cjs');

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;
  if (!['Edit', 'Write', 'MultiEdit'].includes(toolName)) process.exit(0);

  const filePath = toolInput?.file_path || '';
  if (!filePath) process.exit(0);

  // ── Signal A: path-based detection ──
  // Match .claude/{rules,agents,modules,hooks,skills}/ as a path segment
  // (cross-platform — accept both / and \).
  const PATH_REGEX = /[/\\]\.claude[/\\](rules|agents|modules|hooks|skills)[/\\]/;
  const pathMatch = PATH_REGEX.test(filePath);

  // ── Signal C: metadata-based detection ──
  // Parse first ~20 lines for kit-origin markers in any of three forms.
  let metadataKit = null;
  try {
    if (fs.existsSync(filePath)) {
      const head = fs.readFileSync(filePath, 'utf8').split('\n').slice(0, 20).join('\n');
      metadataKit = extractKitFromMetadata(head);
    }
  } catch { /* fail-open on read error */ }

  if (!pathMatch && !metadataKit) process.exit(0);

  // Resolve kit name: prefer metadata, fallback to project's metadata.json `kitName`,
  // last resort: 'unknown'.
  const projectRoot = findProjectRoot();
  let kit = metadataKit || readProjectKitName(projectRoot) || 'unknown';

  // Make file path relative to project root for cleaner output.
  const relPath = path.relative(projectRoot, filePath) || filePath;

  // Emit the per-edit marker (rollup hook will consolidate at Stop).
  console.log(
    `[t1k:sync-back-suggested kit="${kit}" file="${relPath}" reason="kit-owned file modified"]`
  );

  // Append to per-session queue so sync-back-rollup.cjs can summarize.
  try {
    const telemetryDir = ensureTelemetryDir();
    const sessionKey = computeTeammateSessionKey();
    const queuePath = path.join(telemetryDir, `sync-back-suggestions-${sessionKey}.jsonl`);
    const entry = {
      ts: new Date().toISOString(),
      kit,
      file: relPath,
      tool: toolName,
    };
    fs.appendFileSync(queuePath, JSON.stringify(entry) + '\n');
  } catch { /* queue write failure is non-critical; per-edit marker still emitted */ }

  process.exit(0);
} catch {
  process.exit(0); // Fail-open
}

/**
 * Extract kit name from a file head matching any of three formats:
 *   YAML frontmatter: `origin: <kit>`
 *   JSON:             `"_origin": { "kit": "<kit>", ... }` or `"t1k-origin": "<kit>"`
 *   JS line comment:  `// t1k-origin: kit=<kit> | ...`
 *
 * Returns the kit string (e.g. 'theonekit-core') or null if no marker found.
 */
function extractKitFromMetadata(head) {
  // JS comment form: `t1k-origin: kit=<kit>`
  const commentMatch = head.match(/t1k-origin:\s*kit=([\w-]+)/);
  if (commentMatch) return commentMatch[1];
  // JSON _origin block: `"kit": "<kit>"` near `"_origin"` (loose proximity check)
  const jsonOriginMatch = head.match(/"_origin"\s*:\s*\{[^}]*?"kit"\s*:\s*"([\w-]+)"/s);
  if (jsonOriginMatch) return jsonOriginMatch[1];
  // YAML frontmatter `origin: <kit>` (must be a top-level key, not nested)
  // Accept either bare or quoted value.
  const yamlOriginMatch = head.match(/^origin:\s*["']?([\w-]+)["']?\s*$/m);
  if (yamlOriginMatch) return yamlOriginMatch[1];
  // YAML frontmatter `_origin: <kit>` (alt form)
  const yamlUnderscoreMatch = head.match(/^_origin:\s*["']?([\w-]+)["']?\s*$/m);
  if (yamlUnderscoreMatch) return yamlUnderscoreMatch[1];
  return null;
}

/**
 * Read the project's .claude/metadata.json `name` / `kitName` field for a kit
 * fallback when the edited file lacks its own origin metadata (e.g., a hook
 * recently added without the boilerplate line). Returns null on any failure.
 */
function readProjectKitName(projectRoot) {
  try {
    const metaPath = path.join(projectRoot, '.claude', 'metadata.json');
    if (!fs.existsSync(metaPath)) return null;
    const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    return meta.name || meta.kitName || null;
  } catch {
    return null;
  }
}
