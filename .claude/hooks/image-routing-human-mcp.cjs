#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// image-routing-human-mcp.cjs — UserPromptSubmit hook.
//
// When the user's prompt carries an attached/pasted image, inject a standing
// instruction to analyze it via the human-mcp MCP server's `eyes` tool instead
// of Claude's native vision. Ships enabled by default (opt-out): set
// `features.imageAnalysisRouting: false` in t1k-config-core.json to disable.
//
// Graceful fallback: the reminder is only injected when the human-mcp MCP server
// is actually registered in the user's config. When human-mcp is NOT installed,
// the hook stays silent so Claude's built-in native vision handles the image
// normally — no "install/restart" nag for consumers who never set up human-mcp.
//
// Fail-open: any error → exit 0 (never block a prompt).
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

function emit(additionalContext) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext,
    },
  }));
}

// Opt-out check. Default ON (absent/unreadable config → feature stays enabled,
// consistent with "opt-out default in core"). Only an explicit `false` disables.
function isDisabled() {
  try {
    const { resolveClaudeDir } = require('./telemetry-utils.cjs');
    const resolved = resolveClaudeDir();
    if (!resolved || !resolved.claudeDir) return false;
    const cfgPath = path.join(resolved.claudeDir, 't1k-config-core.json');
    if (!fs.existsSync(cfgPath)) return false;
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    return cfg && cfg.features && cfg.features.imageAnalysisRouting === false;
  } catch {
    return false; // fail-open to enabled
  }
}

// True only when the human-mcp MCP server is registered somewhere the user's
// Claude Code would load it from. When absent, the hook stays silent so native
// vision handles the image (graceful fallback for consumers without human-mcp).
// Checks the standard MCP-registration locations; a `"human-mcp":` server key in
// any of them counts. Fail-open to FALSE (no nag) on any read error.
function isHumanMcpInstalled() {
  try {
    const home = os.homedir();
    const cwd = process.cwd();
    const candidates = [
      path.join(home, '.claude.json'),              // user + local-scope MCP (claude mcp add)
      path.join(cwd, '.mcp.json'),                  // project-scope MCP
      path.join(cwd, '.claude', 'settings.json'),   // project settings (mcpServers)
      path.join(home, '.claude', 'settings.json'),  // global settings (mcpServers)
    ];
    for (const f of candidates) {
      try {
        if (!fs.existsSync(f)) continue;
        // A registered server appears as a JSON key: "human-mcp": { ... }
        if (/"human-mcp"\s*:/.test(fs.readFileSync(f, 'utf8'))) return true;
      } catch { /* skip unreadable candidate */ }
    }
    return false;
  } catch {
    return false; // fail-open: absent → silent → native vision
  }
}

try {
  const raw = fs.readFileSync(0, 'utf8');
  let input = {};
  try { input = JSON.parse(raw); } catch { process.exit(0); }

  if (isDisabled()) process.exit(0);

  const prompt = typeof input.prompt === 'string' ? input.prompt : '';

  // Signals that an image is attached to this prompt:
  //  - Claude Code's pasted-image cache path (~/.claude/image-cache/...)
  //  - the "[Image #N]" / "[Image: source: ...]" markers it injects
  const hasImage = /image-cache[\\/]/i.test(prompt)
    || /\[Image\s*#?\d/i.test(prompt)
    || /\[Image:\s*source:/i.test(prompt);

  if (!hasImage) process.exit(0);

  // Graceful fallback: if human-mcp isn't installed, stay silent and let Claude's
  // native vision handle the image — don't nag consumers who never set it up.
  if (!isHumanMcpInstalled()) process.exit(0);

  emit(
    '[image-routing] An image is attached to this prompt. Per TheOneKit\'s default '
    + 'image-analysis routing, analyze ALL provided images using the human-mcp MCP '
    + 'server\'s `mcp__human-mcp__eyes_analyze` tool (or `eyes_compare` / '
    + '`eyes_read_document` as appropriate) instead of relying on native vision. '
    + 'Pass the image-cache file path to the tool. If `mcp__human-mcp__eyes_analyze` '
    + 'is NOT loaded in this session (human-mcp is registered but loads at session '
    + 'start), tell the user to restart Claude Code, then route the analysis through '
    + 'it. To disable this routing, set `features.imageAnalysisRouting: false` in '
    + 't1k-config-core.json.'
  );
  process.exit(0);
} catch {
  process.exit(0);
}
