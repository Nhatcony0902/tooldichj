#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// generate-baseline-context.cjs — SessionStart hook: output installed kit/module context
// Discovers kits from t1k-config-*.json fragments (uniform, no special-casing).
// Shows installed modules, available modules, and cross-kit dependencies.
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const cwd = process.cwd();
  const { resolveClaudeDir, isT1KMetadata } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  const resolved = resolveClaudeDir();
  if (!resolved) process.exit(0);
  const { claudeDir, isGlobalOnly, home } = resolved;
  const baseDir = isGlobalOnly ? home : cwd;
  // Timer created early but end() called at last exit — after any stdout output
  const _timer = createHookTimer('generate-baseline-context');

  // ── Ensure project .claude/.gitignore has T1K entries ──
  // Guard: only modify gitignore in confirmed T1K projects (not global-only, not HOME)
  if (!isGlobalOnly && fs.existsSync(path.join(claudeDir, 'metadata.json'))) {
    const T1K_MARKER = '# TheOneKit ephemeral files';
    const gitignorePath = path.join(claudeDir, '.gitignore');
    try {
      const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, 'utf8') : '';
      if (!existing.includes(T1K_MARKER)) {
        const t1kEntries = `\n${T1K_MARKER}\nsession-state/\ntelemetry/\n.update-check-cache\nhooks/.logs/\n.*-update.zip\n.t1k-resolved-config.json\n`;
        fs.appendFileSync(gitignorePath, t1kEntries);
      }
    } catch { /* fail-open */ }
  }

  function readJson(p) { try { return JSON.parse(fs.readFileSync(path.join(baseDir, p), 'utf8')); } catch { return null; } }
  function readText(p) { try { return fs.readFileSync(path.join(baseDir, p), 'utf8').trim(); } catch { return null; } }
  function stripV(v) { return v && v.startsWith('v') ? v.slice(1) : v; }

  // ── Discover installed kits from config fragments (uniform for all kits including core) ──
  const installedKits = [];
  try {
    for (const f of fs.readdirSync(claudeDir).filter(f => f.startsWith('t1k-config-') && f.endsWith('.json'))) {
      try {
        const config = JSON.parse(fs.readFileSync(path.join(claudeDir, f), 'utf8'));
        const kitName = config.kitName || config.kit || f.replace('t1k-config-', '').replace('.json', '');
        installedKits.push({ kitName, repo: config.repos?.primary, priority: config.priority || 0 });
      } catch { /* skip */ }
    }
  } catch { /* ok */ }
  installedKits.sort((a, b) => a.priority - b.priority); // core (p10) first, kits (p90) after

  // Only trust metadata.json if it's T1K-shape — otherwise CK metadata's `kits.engineer`
  // would leak into the kit/module display.
  const rawMeta = readJson('.claude/metadata.json');
  const meta = isT1KMetadata(rawMeta) ? rawMeta : null;
  const registry = readJson('.claude/t1k-modules.json');
  const lines = [];

  // ── Show discovered kits ──
  if (installedKits.length > 0) {
    // Group modules by kit — match config kitName against module kit field
    // Config uses short names ("unity"), modules use full names ("theonekit-unity")
    const kitsData = meta?.kits || {};
    const v2Modules = meta?.modules || {};
    const allModules = Object.entries(meta?.installedModules || {}).map(([name, entry]) => ({
      name, kit: entry.kit || 'unknown', version: stripV(entry.version),
    }));

    for (const { kitName, priority } of installedKits) {
      // Match: kitName "unity" matches module kit "theonekit-unity" or "unity"
      const variants = [kitName, `theonekit-${kitName}`, kitName.replace('theonekit-', '')];
      const modules = allModules.filter(m => variants.includes(m.kit));

      // Resolve version from multiple sources
      let version = '?';
      if (modules.length > 0) version = modules[0].version || '?';
      const shortKey = kitName.replace('theonekit-', '');
      if (kitsData[shortKey]?.version) version = stripV(kitsData[shortKey].version);
      if (meta?.name === kitName || meta?.name === `theonekit-${kitName}`) version = stripV(meta?.version) || version;

      const displayName = kitName.startsWith('theonekit-') ? kitName : `theonekit-${kitName}`;
      if (modules.length > 0) {
        lines.push(`[t1k:context] Kit: ${displayName} v${version} | Modules (${modules.length}): ${modules.map(m => m.name).join(', ')}`);
      } else if (priority <= 10) {
        lines.push(`[t1k:context] Kit: ${displayName} v${version} (infrastructure)`);
      } else {
        // Kit detected from config but no modules — might be flat or just installed
        lines.push(`[t1k:context] Kit: ${displayName} v${version}`);
      }
    }

    // Also show v2 modules if no v3 installedModules
    if (!meta?.installedModules && Object.keys(v2Modules).length > 0) {
      lines.push(`[t1k:context] Modules (${Object.keys(v2Modules).length}): ${Object.keys(v2Modules).join(', ')}`);
    }
  }

  // ── Available (uninstalled) modules ──
  const { getModuleNames } = require('./telemetry-utils.cjs');
  const installedSet = new Set(getModuleNames(meta));
  if (registry?.modules) {
    const available = Object.keys(registry.modules).filter(m => !installedSet.has(m));
    if (available.length > 0) {
      lines.push(`[t1k:context] Available modules (not installed): ${available.join(', ')}`);
    }
  }

  // ── Cross-kit dependencies from presets ──
  if (registry?.presets) {
    const crossKit = new Map();
    for (const preset of Object.values(registry.presets)) {
      if (typeof preset !== 'object' || !preset.crossKitModules) continue;
      for (const ref of preset.crossKitModules) {
        const [kit, mod] = ref.split(':');
        if (!kit || !mod || installedSet.has(mod)) continue;
        if (!crossKit.has(kit)) crossKit.set(kit, new Set());
        crossKit.get(kit).add(mod);
      }
    }
    for (const [kit, modules] of crossKit) {
      lines.push(`[t1k:context] Cross-kit dependency (${kit}): ${[...modules].join(', ')} — install with: t1k modules preset <name>`);
    }
  }

  // ── Global-only mode suggestion (always emit, even if no kits detected) ──
  if (isGlobalOnly) {
    lines.push('[t1k:global-only] T1K running from global install — core skills available. Run `t1k init` for project-level config.');
  }

  if (lines.length > 0) {
    const modulesCount = (meta && meta.installedModules) ? Object.keys(meta.installedModules).length : 0;
    const kitNames = installedKits.map(k => k.kitName).join(', ');
    _timer.end({ outcome: 'ok', kits: kitNames, modules: modulesCount });
    logHook('generate-baseline-context', { kit: kitNames, modules: modulesCount });
    console.log(lines.join('\n'));
    process.exit(0);
  }

  // ── Fallback: .t1k-module-summary.txt ──
  const summary = readText('.t1k-module-summary.txt');
  if (summary) {
    const fallbackLines = [];
    for (const line of summary.split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const [kit, version, preset, modules] = line.split('|');
      if (!kit) continue;
      const parts = [`Kit: ${kit} v${stripV(version) || '?'}`];
      if (preset) parts.push(`preset: ${preset}`);
      if (modules) parts.push(`Modules: ${modules}`);
      fallbackLines.push(`[t1k:context] ${parts.join(' | ')}`);
    }
    if (fallbackLines.length > 0) {
      _timer.end({ outcome: 'ok-fallback' });
      console.log(fallbackLines.join('\n'));
    } else {
      _timer.end({ outcome: 'empty' });
    }
  } else {
    _timer.end({ outcome: 'empty' });
  }

  process.exit(0);
} catch (e) {
  try { require('./hook-logger.cjs').logHookCrash('generate-baseline-context', e); } catch { /* ok */ }
  process.exit(0); // fail-open
}
