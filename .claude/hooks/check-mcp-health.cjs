#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// check-mcp-health.cjs — SessionStart hook: validate required/recommended MCP servers
// Reads t1k-config-*.json → mcp section, checks against `claude mcp list` output.
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const { execSync } = require('child_process');
  const cwd = process.cwd();
  const {
    T1K, resolveClaudeDir, resolveProjectDir, detectProjectType, getModuleNames,
  } = require('./telemetry-utils.cjs');
  const { mcpApplies } = require('./lib/mcp-applies.cjs');
  const mcpCooldown = require('./lib/mcp-cooldown.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  // Dry-run / wrong-event safety (#503): SessionStart hook. The doctor's hook-runtime
  // dry-run sends a synthetic PreToolUse payload ({ tool_name:"Read", ... }). Recognize
  // a tool-event payload and no-op fast so the hook stays dry-run VALIDATED without
  // running `claude mcp` subprocesses for an event that isn't ours. Real SessionStart
  // payloads carry no `tool_name`.
  try {
    if (!process.stdin.isTTY) {
      const dryRunRaw = fs.readFileSync(0, 'utf8');
      if (dryRunRaw && JSON.parse(dryRunRaw).tool_name) process.exit(0);
    }
  } catch { /* no/invalid stdin payload → real SessionStart invocation, continue */ }
  const resolved = resolveClaudeDir();
  if (!resolved) process.exit(0);
  const { claudeDir, home } = resolved;
  const timer = createHookTimer('check-mcp-health');

  // ── Collect MCP requirements from all config fragments ──
  const required = [];
  const recommended = [];
  const optional = [];
  try {
    for (const f of fs.readdirSync(claudeDir).filter(f => f.startsWith(T1K.CONFIG_PREFIX) && f.endsWith('.json'))) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        if (!config.mcp) continue;
        if (Array.isArray(config.mcp.required)) {
          for (const entry of config.mcp.required) required.push(entry);
        }
        if (Array.isArray(config.mcp.recommended)) {
          for (const entry of config.mcp.recommended) recommended.push(entry);
        }
        if (Array.isArray(config.mcp.optional)) {
          for (const entry of config.mcp.optional) optional.push(entry);
        }
      } catch { /* skip malformed */ }
    }
  } catch { /* ok */ }

  if (required.length === 0 && recommended.length === 0 && optional.length === 0) process.exit(0);

  // ── Deduplicate by name ──
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter(e => { if (seen.has(e.name)) return false; seen.add(e.name); return true; });
  };
  const reqList = dedup(required);
  const recList = dedup(recommended);
  const optList = dedup(optional);

  // ── Build the session context ONCE for the appliesWhen gate ──
  // projectType/framework ← detectProjectType (SSOT in telemetry-utils);
  // isGlobalOnly ← resolveProjectDir().globalOnly (the field actually returned —
  //   resolveClaudeDir() has no such flag, validation N5);
  // installedModules ← getModuleNames(meta) parsing metadata.json exactly ONCE
  //   (~150KB; getModuleNames normalizes the object-map + filesystem fallback).
  // Fail-open throughout: any read error leaves the safe defaults (gate applies).
  const ctx = (() => {
    let projectType = 'unknown', framework = '';
    try { ({ projectType, framework } = detectProjectType(cwd)); } catch { /* defaults */ }
    let isGlobalOnly = false;
    try { isGlobalOnly = resolveProjectDir().globalOnly === true; } catch { /* default false */ }
    let installedModules = [];
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(claudeDir, T1K.METADATA_FILE), 'utf8'));
      installedModules = getModuleNames(meta, claudeDir);
    } catch {
      // metadata.json absent/corrupt — fall back to a filesystem module scan.
      try { installedModules = getModuleNames({}, claudeDir); } catch { installedModules = []; }
    }
    return { projectType, framework, isGlobalOnly, installedModules };
  })();

  // Filter each tier through the appliesWhen gate. A malformed entry returns
  // false (mcpApplies fail-open) → skipped with a one-line stderr note; never
  // crashes the SessionStart chain.
  const gate = (arr) => arr.filter(e => {
    try {
      return mcpApplies(e, ctx);
    } catch (err) {
      try { process.stderr.write(`[t1k:mcp] skip malformed entry (${e && e.name}): ${err && err.message}\n`); } catch { /* ignore */ }
      return false;
    }
  });
  const gatedReq = gate(reqList);
  const gatedRec = gate(recList);
  const gatedOpt = gate(optList);

  // ── Get connected MCP servers ──
  let connectedServers = new Set();
  // Map name(lower) → full raw line so fork checks can inspect the command/URL
  let serverLines = new Map();
  // #391 — `claude mcp list` blocks until ALL registered MCP servers report
  // status; a server stuck "connecting" (e.g. clickup) can hang the call past
  // the harness SessionStart budget (30s in hook-runner.cjs), so the runner's
  // own spawnSync kills the whole node process → `spawnSync ... ETIMEDOUT`,
  // `exitCode: null` telemetry noise on every session start.
  //
  // Two guards keep the probe well under the harness budget:
  //   1. MCP_PROBE_TIMEOUT_MS (default 8s, ≪ 30s) bounds the wait. Even if the
  //      probe times out we still fail-open (the catch below exits 0) — a slow
  //      server just means the health hints are skipped this session.
  //   2. killSignal: 'SIGKILL' — the default SIGTERM can be swallowed by a
  //      child that's blocked on a hung socket, leaving the node process alive
  //      until the harness kills it. SIGKILL force-terminates so the timeout
  //      actually fires inside THIS process, before the harness budget.
  // Override the bound with T1K_MCP_PROBE_TIMEOUT_MS for slow environments.
  const MCP_PROBE_TIMEOUT_MS = (() => {
    const raw = parseInt(process.env.T1K_MCP_PROBE_TIMEOUT_MS || '', 10);
    return Number.isFinite(raw) && raw > 0 ? raw : 8000;
  })();
  try {
    const output = execSync('claude mcp list', {
      encoding: 'utf8',
      timeout: MCP_PROBE_TIMEOUT_MS,
      killSignal: 'SIGKILL',
      maxBuffer: 1024 * 1024,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    // Parse output lines: "name: command/url - status"
    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      // Match pattern: "server-name: ..." or just extract first word/token before ":"
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 0) {
        const name = trimmed.substring(0, colonIdx).trim();
        // Check if connected (contains "Connected" or does NOT contain "Needs authentication" or "Error")
        const isConnected = trimmed.includes('Connected') || (!trimmed.includes('Needs authentication') && !trimmed.includes('Error'));
        if (isConnected) connectedServers.add(name.toLowerCase());
        serverLines.set(name.toLowerCase(), trimmed);
      }
    }
  } catch {
    // If claude mcp list fails, skip MCP health check silently
    process.exit(0);
  }

  // ── Fork-required check (reads consumer's Packages/manifest.json) ──
  // For entries that declare `fork.required: true`, verify both halves of the
  // install: (1) the registered MCP server command line contains the expected
  // fork marker, and (2) the Unity package URL in Packages/manifest.json
  // resolves to the fork. Pure data-driven — no kit-specific strings here.
  function readManifestDeps() {
    try {
      const manifestPath = path.join(cwd, 'Packages', 'manifest.json');
      if (!fs.existsSync(manifestPath)) return null;
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      return (m && typeof m === 'object' && m.dependencies && typeof m.dependencies === 'object') ? m.dependencies : null;
    } catch { return null; }
  }
  function checkForkInstall(entry) {
    const fk = entry && entry.fork;
    if (!fk || fk.required !== true) return null; // not fork-gated
    const checks = (fk.checks && typeof fk.checks === 'object') ? fk.checks : {};
    const result = { manifestOk: null, serverCmdOk: null, missingHints: [] };

    // Half 1 — Unity-side UPM package
    if (fk.unityPackageId && checks.manifestUrlContains) {
      const deps = readManifestDeps();
      if (deps === null) {
        // Not a Unity project (no Packages/manifest.json) — skip silently; the
        // [t1k:mcp] line for the server below is the actionable signal.
        result.manifestOk = 'not-unity-project';
      } else {
        const url = typeof deps[fk.unityPackageId] === 'string' ? deps[fk.unityPackageId] : '';
        result.manifestOk = url.includes(checks.manifestUrlContains);
        if (!result.manifestOk) result.missingHints.push('upm');
      }
    }

    // Half 2 — registered MCP server command line
    if (checks.mcpServerCmdContains) {
      const line = serverLines.get(entry.name.toLowerCase()) || '';
      result.serverCmdOk = line.includes(checks.mcpServerCmdContains);
      if (!result.serverCmdOk) result.missingHints.push('server');
    }
    return result;
  }

  // ── Also check global MCP config files as fallback ──
  const mcpConfigPaths = [
    path.join(home || '', '.claude', 'mcp.json'),
    path.join(cwd, '.mcp.json'),
  ];
  for (const mcpPath of mcpConfigPaths) {
    try {
      const mcpConfig = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
      if (mcpConfig.mcpServers) {
        for (const name of Object.keys(mcpConfig.mcpServers)) {
          connectedServers.add(name.toLowerCase());
        }
      }
    } catch { /* ok */ }
  }

  // ── Emit unified [t1k:mcp] tags ──
  // Escape user-config-supplied strings before interpolation into a
  // newline-delimited tag stream. Tags are parsed by AI on attribute
  // boundaries; a stray `"` in installCmd or purpose would corrupt the
  // stream. This is fail-open: never throw on a bad fragment.
  function safeAttr(v) {
    if (v == null) return '';
    return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\r?\n/g, ' ');
  }
  // scope defaults to "user" (the global ~/.claude install) when unset. Emitted
  // on every line and used as the cooldown key for tier=optional.
  const scopeOf = (entry) => (entry && (entry.scope === 'project' || entry.scope === 'user')) ? entry.scope : 'user';

  const lines = [];
  for (const entry of gatedReq) {
    const scope = scopeOf(entry);
    const fork = checkForkInstall(entry);
    const serverConnected = connectedServers.has(entry.name.toLowerCase());
    if (!serverConnected) {
      lines.push(`[t1k:mcp] action=install tier=required name="${safeAttr(entry.name)}" scope=${scope} purpose="${safeAttr(entry.purpose)}" cmd="${safeAttr(entry.installCmd)}"`);
      continue;
    }
    // Server is registered. If a fork is required, verify both halves.
    if (fork && (fork.manifestOk === false || fork.serverCmdOk === false)) {
      const help = Array.isArray(entry.fork && entry.fork.installHelp) ? entry.fork.installHelp.join(' || ') : '';
      lines.push(
        `[t1k:mcp] action=install-fork tier=required name="${safeAttr(entry.name)}" scope=${scope} ` +
        `purpose="${safeAttr(entry.purpose)}" ` +
        `repo="${safeAttr(entry.fork.repo)}" branch="${safeAttr(entry.fork.branch)}" ` +
        `missing="${safeAttr(fork.missingHints.join(','))}" ` +
        `help="${safeAttr(help)}"`
      );
    } else {
      lines.push(`[t1k:mcp] action=ok tier=required name="${safeAttr(entry.name)}" scope=${scope}`);
    }
  }
  for (const entry of gatedRec) {
    const scope = scopeOf(entry);
    if (connectedServers.has(entry.name.toLowerCase())) {
      lines.push(`[t1k:mcp] action=ok tier=recommended name="${safeAttr(entry.name)}" scope=${scope}`);
    } else {
      lines.push(`[t1k:mcp] action=install tier=recommended name="${safeAttr(entry.name)}" scope=${scope} purpose="${safeAttr(entry.purpose)}" cmd="${safeAttr(entry.installCmd)}"`);
    }
  }
  for (const entry of gatedOpt) {
    const scope = scopeOf(entry);
    if (connectedServers.has(entry.name.toLowerCase())) {
      // action=ok is never cooled and never written to the cooldown state.
      lines.push(`[t1k:mcp] action=ok tier=optional name="${safeAttr(entry.name)}" scope=${scope}`);
    } else {
      // tier=optional + would-emit-install ⇒ apply the 7-day cooldown (D5).
      // Suppress within the window; otherwise emit and record the reminder.
      // Fail-open: any cooldown error falls through to remind.
      let suppressed = false;
      try { suppressed = mcpCooldown.inCooldown(scope, entry.name); } catch { suppressed = false; }
      if (suppressed) continue;
      lines.push(`[t1k:mcp] action=install tier=optional name="${safeAttr(entry.name)}" scope=${scope} purpose="${safeAttr(entry.purpose)}" cmd="${safeAttr(entry.installCmd)}"`);
      try { mcpCooldown.recordReminded(scope, entry.name); } catch { /* fail-open */ }
    }
  }

  // Count suggestions for telemetry. install-fork is a stricter variant of
  // install — counted separately so dashboards can track fork-migration drift.
  const suggested = lines.filter(l => l.includes('action=install') || l.includes('action=install-fork')).length;
  for (const line of lines) {
    const m = line.match(/action=(install(?:-fork)?)/);
    if (!m) continue;
    const nameMatch = line.match(/name="([^"]+)"/);
    const tierMatch = line.match(/tier=(\w+)/);
    if (nameMatch) {
      logHook('check-mcp-health', { suggest: nameMatch[1], tier: tierMatch ? tierMatch[1] : 'unknown', action: m[1] });
    }
  }

  if (lines.length > 0) {
    console.log(lines.join('\n'));
  }

  timer.end({ outcome: 'ok', suggested: suggested });
  process.exit(0);
} catch (e) {
  // fail-open: never block session start
  try {
    const { logHookCrash: _lhc } = require('./hook-logger.cjs');
    _lhc('check-mcp-health', e);
  } catch { /* truly fail-open */ }
  process.exit(0);
}
