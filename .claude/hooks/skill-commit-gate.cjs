#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * skill-commit-gate.cjs - Block git commit when kit-origin skill files are staged but not synced
 *
 * PreToolUse hook for Bash tool.
 * When `git commit` is detected and .claude/skills/ files with a known T1K origin are staged,
 * blocks with a reminder to run /t1k:sync-back --dry-run first.
 *
 * Bypasses:
 * - Project-specific skills (no origin or unknown origin) — #17
 * - Bulk kit updates via .claude/.skip-commit-gate marker — #16
 *
 * Standalone — no shared lib dependencies. Ships with theonekit-core.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const { parseHookStdin, resolveProjectDir } = require('./telemetry-utils.cjs');

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;

  // Only check Bash commands
  if (toolName !== 'Bash' || !toolInput?.command) process.exit(0);

  const cmd = toolInput.command.trim();

  // Only check git commit commands
  if (!/git\s+commit/.test(cmd)) process.exit(0);

  // #167: Recognize inline env-var prefixes in the Bash command itself.
  // Claude Code spawns hooks in the harness's environment, NOT in the
  // spawned-bash subprocess's env, so `T1K_SKIP_COMMIT_GATE=1 git commit ...`
  // never reaches process.env. The command string IS available to the hook,
  // so we parse the inline-prefix form directly. Two equivalent ways to set
  // each flag: `export` before launching Claude Code (process.env path) OR
  // inline-prefix on the bash command (this path).
  const hasInlineFlag = (name) => {
    const re = new RegExp(`(?:^|\\s)${name}=(?:1|true)(?=\\s)`, 'i');
    return re.test(cmd);
  };

  const debug = process.env.T1K_DEBUG_COMMIT_GATE === '1' || hasInlineFlag('T1K_DEBUG_COMMIT_GATE');
  const dlog = (msg) => { if (debug) console.error(`\x1b[35m[commit-gate:debug]\x1b[0m ${msg}`); };

  // #62 + #167: Env-var bypass — accept either the inherited process env (set
  // via `export T1K_SKIP_COMMIT_GATE=1` before launching Claude Code) OR the
  // inline-prefix form on the bash command (`T1K_SKIP_COMMIT_GATE=1 git commit ...`).
  // Cross-platform alternative to the .skip-commit-gate marker file; survives
  // nested .claude/ layouts and CI contexts where path resolution is unreliable.
  if (process.env.T1K_SKIP_COMMIT_GATE === '1' || hasInlineFlag('T1K_SKIP_COMMIT_GATE')) {
    console.error('\x1b[36m[skip-commit-gate]\x1b[0m T1K_SKIP_COMMIT_GATE=1 — skipping sync-back gate.');
    process.exit(0);
  }

  // #16/#62: Skip gate if marker file exists. Resolve via resolveProjectDir()
  // so nested .claude/ layouts (parent project + child Vite/RN subproject)
  // pick the correct kit-rooted .claude/ instead of whatever the hook's spawn
  // CWD happens to be. resolveProjectDir() honors T1K_HOOK_DIR (set by
  // hook-runner) and CLAUDE_PROJECT_DIR before walking up — exactly the right
  // semantics here.
  const proj = resolveProjectDir();
  const t1kDir = proj && proj.t1kDir;
  const candidatePaths = [];
  if (t1kDir) candidatePaths.push(path.join(t1kDir, '.skip-commit-gate'));
  candidatePaths.push(path.join('.claude', '.skip-commit-gate')); // legacy CWD-relative fallback

  let markerHit = null;
  for (const p of candidatePaths) {
    dlog(`marker probe: ${p} exists=${fs.existsSync(p)}`);
    if (fs.existsSync(p)) { markerHit = p; break; }
  }
  if (markerHit) {
    try { fs.unlinkSync(markerHit); } catch { /* ignore cleanup failure */ }
    console.error(`\x1b[36m[skip-commit-gate]\x1b[0m Marker detected at ${markerHit} — kit update commit, skipping sync-back gate.`);
    process.exit(0);
  }

  // Get staged files
  let stagedFiles;
  try {
    const output = execSync('git diff --cached --name-only --diff-filter=M', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 5000,
    });
    stagedFiles = output.trim().split('\n').filter(Boolean);
  } catch {
    process.exit(0);
  }

  // Check if any staged files are under .claude/skills/
  const stagedSkillFiles = stagedFiles.filter(f => f.startsWith('.claude/skills/'));
  if (stagedSkillFiles.length === 0) process.exit(0);

  // Skip gate if we're in the origin kit repo (sync-back doesn't apply)
  try {
    const metadata = JSON.parse(fs.readFileSync('.claude/metadata.json', 'utf8'));
    const remoteUrl = execSync('git remote get-url origin', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (metadata.repository && remoteUrl.includes(metadata.repository)) {
      process.exit(0); // Origin repo — sync-back not needed
    }
  } catch {
    // Can't determine origin — fall through to gate
  }

  // #17: Filter to only kit-origin skills (project-specific skills pass through)
  // Build set of known T1K kit names from t1k-config-*.json fragments + metadata.json
  const knownKits = new Set();
  try {
    const claudeDir = '.claude';
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      if (/^t1k-config-.*\.json$/.test(entry)) {
        try {
          const cfg = JSON.parse(fs.readFileSync(path.join(claudeDir, entry), 'utf8'));
          if (cfg.kitName) knownKits.add(cfg.kitName);
        } catch { /* skip unreadable config */ }
      }
    }
    // Also read metadata.json for the current kit name
    try {
      const metadata = JSON.parse(fs.readFileSync(path.join(claudeDir, 'metadata.json'), 'utf8'));
      if (metadata.name) knownKits.add(metadata.name);
    } catch { /* skip */ }
  } catch { /* skip — can't read .claude/ dir */ }

  // For each staged skill file, check the skill's SKILL.md for origin frontmatter
  const kitSkillFiles = stagedSkillFiles.filter(f => {
    // Extract skill directory name: .claude/skills/<skill-name>/...
    const parts = f.split('/');
    if (parts.length < 3) return false;
    const skillDir = parts.slice(0, 3).join('/'); // .claude/skills/<name>
    const skillMdPath = path.join(skillDir, 'SKILL.md');
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
      if (!fmMatch) return false; // No frontmatter → project-specific
      const originMatch = fmMatch[1].match(/^origin:\s*(.+)$/m);
      if (!originMatch) return false; // No origin field → project-specific
      const origin = originMatch[1].trim();
      return knownKits.size === 0 || knownKits.has(origin); // Gate only known kit origins
    } catch {
      return false; // Can't read SKILL.md → treat as project-specific
    }
  });

  if (kitSkillFiles.length === 0) process.exit(0);

  // Block — kit-origin skill files need sync-back check
  console.error(`
\x1b[33mSYNC-BACK GATE\x1b[0m: Kit-origin skill files staged for commit:

${kitSkillFiles.map(f => `  \x1b[33m!\x1b[0m ${f}`).join('\n')}

  \x1b[34mBefore committing:\x1b[0m Run /t1k:sync-back --dry-run
  If changes are generic (not project-specific), run /t1k:sync-back to create PR.
  If already synced or project-specific, proceed with the commit.
`);
  process.exit(2); // Block — requires user approval to proceed
} catch {
  process.exit(0); // Fail-open
}
