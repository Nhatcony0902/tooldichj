#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * unity-process-guard.cjs - Block AI from killing / quitting the Unity Editor
 *
 * PreToolUse hook for Bash + MCP execute_menu_item.
 * Hard-blocks (exit 2):
 *   - kill/pkill/killall targeting Unity, UnityHub, UnityShaderCompiler, AssetImportWorker
 *   - kill <pid> where the pid's process name contains "Unity"
 *   - mcp__UnityMCP__execute_menu_item with menu_path containing "Quit" or "Reimport All"
 *
 * Dormant for non-Unity users: the Bash regex requires Unity-family process
 * names in the command; the MCP matcher only fires when Unity MCP is installed.
 *
 * Rationale: see theonekit-unity/.claude/rules/unity-forbidden-operations.md
 *
 * No approval flow — must be removed from settings.json with explicit user consent.
 * Ships with theonekit-core per Phase D / Gate #22 (validate-kits-ship-no-hooks).
 */
'use strict';
try {
  const { execSync } = require('child_process');
  const { parseHookStdin } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');

  const UNITY_PROCESS_PATTERNS = [
    /\bUnity\b/i,
    /\bUnityHub\b/i,
    /\bUnityShaderCompiler\b/i,
    /\bAssetImportWorker\b/i,
    /\bUnityLicensingClient\b/i,
  ];

  const FORBIDDEN_MENU_FRAGMENTS = [
    'Quit',           // File/Quit, Edit/Quit, etc.
    'Reimport All',   // Assets/Reimport All
    'Exit',           // File/Exit on some Unity builds
  ];

  function processNameForPid(pid) {
    try {
      const out = execSync(`ps -p ${pid} -o comm=`, {
        encoding: 'utf8', timeout: 1500,
        stdio: ['pipe', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } catch { return null; }
  }

  function isUnityProcessName(name) {
    if (!name) return false;
    return UNITY_PROCESS_PATTERNS.some(rx => rx.test(name));
  }

  function blockBash(cmd, reason, fixHint) {
    console.error(`
\x1b[31mUNITY GUARD BLOCK\x1b[0m: ${reason}

  \x1b[33mCommand:\x1b[0m ${cmd}

  The Unity Editor process is user-owned. You may not terminate, quit, or restart it.
  See \x1b[34m.claude/rules/unity-forbidden-operations.md\x1b[0m for context.

  \x1b[34mWhat to do instead:\x1b[0m ${fixHint}
  \x1b[90mTip: If you genuinely need Unity restarted, ask the user via AskUserQuestion — they'll do it.\x1b[0m
`);
  }

  function blockMenu(menuPath, reason) {
    console.error(`
\x1b[31mUNITY GUARD BLOCK\x1b[0m: ${reason}

  \x1b[33mMenu path:\x1b[0m ${menuPath}

  This menu item is forbidden by \x1b[34m.claude/rules/unity-forbidden-operations.md\x1b[0m.

  \x1b[90mTip: For asset recovery, prefer targeted alternatives:\x1b[0m
    \x1b[32mmanage_asset(action="reimport", path="Assets/...")\x1b[0m  (single asset)
    \x1b[32mrm -rf Library/BurstCache Library/Bee/artifacts Library/ScriptAssemblies\x1b[0m  (Burst cache)
    \x1b[32mrefresh_unity(mode="force", compile="request", wait_for_ready=true)\x1b[0m  (script recompile)
`);
  }

  const hookData = parseHookStdin();
  if (!hookData) process.exit(0);

  const { tool_name: toolName, tool_input: toolInput } = hookData;
  const timer = createHookTimer('unity-process-guard', { tool: toolName });

  // ─── User-authorized escape hatch ────────────────────────────────────────
  // The Unity Editor is user-owned and the AI never kills it on its own. The
  // SINGLE exception (see unity-forbidden-operations.md § "Narrow exception —
  // explicit user-authorized termination"): when the USER directly requests
  // quit/close/terminate/restart in-session, the AI prepends the explicit
  // marker T1K_ALLOW_UNITY_KILL=1 to that one command. Its presence is the
  // on-the-record signal that this kill was user-ordered. Scope is this single
  // command (inline env) or session (exported env) — not a permanent disable.
  const userAuthorizedKill =
    process.env.T1K_ALLOW_UNITY_KILL === '1' ||
    (toolName === 'Bash' &&
      /\bT1K_ALLOW_UNITY_KILL=1\b/.test(String(toolInput?.command || '')));
  if (userAuthorizedKill) {
    logHook('unity-process-guard', { decision: 'allow', pattern: 'user-authorized-termination', tool: toolName });
    timer.end({ outcome: 'allow-authorized' });
    process.exit(0);
  }

  // Strip quoted regions and heredoc bodies so prose containing "kill ... Unity"
  // inside `git commit -m "..."` / `echo '...'` / `cat <<EOF ... EOF` does NOT
  // trigger the guard. Only executable command tokens should match.
  function stripQuotedRegions(s) {
    let out = s;
    // Heredocs: <<EOF ... EOF (any tag), strip body
    out = out.replace(/<<-?\s*['"]?([A-Za-z_][A-Za-z0-9_]*)['"]?[\s\S]*?^\1\s*$/gm, '');
    // Single-quoted strings (no escape processing inside)
    out = out.replace(/'(?:[^'\\]|\\.)*'/g, "''");
    // Double-quoted strings (allow backslash-escaped quotes)
    out = out.replace(/"(?:[^"\\]|\\.)*"/g, '""');
    return out;
  }

  // ─── Case 1: Bash command targeting Unity processes ──────────────────────
  if (toolName === 'Bash' && toolInput?.command) {
    const rawCmd = String(toolInput.command);
    const cmd = stripQuotedRegions(rawCmd);

    // pkill / killall with Unity in the pattern
    const pkillMatch = cmd.match(/\b(?:pkill|killall)\b[^\n;&|]*?\b(Unity|UnityHub|UnityShaderCompiler|AssetImportWorker|UnityLicensingClient)\b/i);
    if (pkillMatch) {
      logHook('unity-process-guard', { decision: 'block', pattern: 'pkill-unity', match: pkillMatch[1] });
      timer.end({ outcome: 'blocked', blocked: 1 });
      blockBash(rawCmd, `Refusing to ${pkillMatch[0].split(/\s+/)[0]} a Unity-family process.`,
        'Investigate why MCP appears disconnected. The editor is almost certainly still alive — see the "MCP timeout ≠ bridge disconnect" decision tree.');
      process.exit(2);
    }

    // kill <pid>  — resolve pid and check process name
    const killPidMatches = [...cmd.matchAll(/\bkill\s+(?:-[A-Z0-9]+\s+)*(\d+)/g)];
    for (const m of killPidMatches) {
      const pid = m[1];
      const procName = processNameForPid(pid);
      if (isUnityProcessName(procName)) {
        logHook('unity-process-guard', { decision: 'block', pattern: 'kill-pid-unity', pid, procName });
        timer.end({ outcome: 'blocked', blocked: 1 });
        blockBash(rawCmd, `Refusing to kill PID ${pid} — process name is "${procName}" (Unity-family).`,
          'If MCP appears disconnected, run pgrep -af "Unity.*<your-project>" to confirm the editor is alive. Then ask the user to click Window > MCP for Unity > Start Session.');
        process.exit(2);
      }
    }

    // pkill -f / pgrep -f patterns that match Unity (catch -9 -f variants)
    const pkillFMatch = cmd.match(/\b(?:pkill|killall)\b[^\n;&|]*?-f[^\n;&|]*?(["']?)(Unity|AssetImportWorker)\1/i);
    if (pkillFMatch) {
      logHook('unity-process-guard', { decision: 'block', pattern: 'pkill-f-unity', match: pkillFMatch[2] });
      timer.end({ outcome: 'blocked', blocked: 1 });
      blockBash(rawCmd, `Refusing to pkill -f a Unity-family process pattern.`,
        'The editor is user-owned. Ask the user to handle restart if truly necessary.');
      process.exit(2);
    }
  }

  // ─── Case 2: MCP execute_menu_item with forbidden menu path ──────────────
  if (toolName === 'mcp__UnityMCP__execute_menu_item' && toolInput?.menu_path) {
    const menuPath = String(toolInput.menu_path);
    const hit = FORBIDDEN_MENU_FRAGMENTS.find(frag => menuPath.includes(frag));
    if (hit) {
      logHook('unity-process-guard', { decision: 'block', pattern: 'mcp-menu', menuPath, fragment: hit });
      timer.end({ outcome: 'blocked', blocked: 1 });
      blockMenu(menuPath, `Menu path contains forbidden fragment "${hit}".`);
      process.exit(2);
    }
  }

  timer.end({ outcome: 'allow' });
  process.exit(0);
} catch (err) {
  // Fail-open: never let a guard bug block legitimate work.
  try {
    const { logHookCrash } = require('./hook-logger.cjs');
    logHookCrash('unity-process-guard', err);
  } catch { /* swallow */ }
  process.exit(0);
}
