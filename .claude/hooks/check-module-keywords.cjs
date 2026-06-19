#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// check-module-keywords.cjs — UserPromptSubmit hook: warn about uninstalled modules
// Reads metadata.json (SSOT) for installed state, t1k-modules-keywords-*.json or
// t1k-modules.json for keyword-to-module mapping. Outputs [t1k:module-suggest] lines.
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const { T1K, resolveClaudeDir, getModuleNames } = require('./telemetry-utils.cjs');
  const { logHook, createHookTimer, logHookCrash } = require('./hook-logger.cjs');
  const resolved = resolveClaudeDir();
  if (!resolved) process.exit(0);
  const claudeDir = resolved.claudeDir;
  const timer = createHookTimer('check-module-keywords');

  // Read user prompt from stdin (non-blocking with timeout)
  let prompt = '';
  try { prompt = fs.readFileSync(0, 'utf8').trim().toLowerCase(); } catch { /* ok */ }
  if (!prompt) { timer.end({ outcome: 'skip', note: 'empty-prompt' }); process.exit(0); }
  // Hash prompt for telemetry (never log raw user text)
  const promptHash = crypto.createHash('sha256').update(prompt).digest('hex').slice(0, 16);

  // Build installed modules set from metadata.json (SSOT)
  const installed = new Set();
  const metaPath = path.join(claudeDir, 'metadata.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      for (const name of getModuleNames(meta)) installed.add(name);
    } catch { /* ok */ }
  }

  // Fallback: also check .t1k-module-summary.txt
  const baseDir = resolved.isGlobalOnly ? resolved.home : process.cwd();
  const summaryPath = path.join(baseDir, '.t1k-module-summary.txt');
  if (installed.size === 0 && fs.existsSync(summaryPath)) {
    try {
      const text = fs.readFileSync(summaryPath, 'utf8');
      for (const line of text.split('\n')) {
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|');
        const modules = (parts[3] || '').split(',').map(s => s.trim()).filter(Boolean);
        for (const m of modules) installed.add(m);
      }
    } catch { /* ok */ }
  }

  if (installed.size === 0) process.exit(0); // no modular kit installed

  // Build keyword→module map from multiple sources
  // Source 1: t1k-modules-keywords-*.json (CI-generated, preferred)
  // Source 2: t1k-modules.json activation mappings (source-repo fallback)
  const keywordMap = new Map(); // keyword (lowercase) → module name

  // Source 1: keyword files
  try {
    const files = fs.readdirSync(claudeDir).filter(f => f.startsWith('t1k-modules-keywords-') && f.endsWith('.json'));
    for (const file of files) {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(claudeDir, file), 'utf8'));
        const keywords = data.keywords || data;
        for (const [key, val] of Object.entries(keywords)) {
          if (key.startsWith('_')) continue; // skip meta fields (_generated, _kitName, etc.)
          if (Array.isArray(val)) {
            // Format: module → keywords[] (from generate-module-keywords.cjs)
            for (const kw of val) keywordMap.set(kw.toLowerCase(), key);
          } else if (typeof val === 'string') {
            // Format: keyword → module (alternative/legacy format)
            keywordMap.set(key.toLowerCase(), val);
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* ok */ }

  // Source 2: t1k-modules.json (activation mappings in each module)
  if (keywordMap.size === 0) {
    const modulesPath = path.join(claudeDir, 't1k-modules.json');
    if (fs.existsSync(modulesPath)) {
      try {
        const registry = JSON.parse(fs.readFileSync(modulesPath, 'utf8'));
        for (const [modName, mod] of Object.entries(registry.modules || {})) {
          // Extract keywords from activation mappings
          const activation = mod.activation || {};
          for (const mapping of (activation.mappings || [])) {
            for (const kw of (mapping.keywords || [])) {
              keywordMap.set(kw.toLowerCase(), modName);
            }
          }
          // Also use skill names as keywords (split by dash, min 4 chars to avoid false positives)
          for (const skill of (mod.skills || [])) {
            const parts = skill.replace(/^(unity|cocos|rn|t1k)-/, '').split(/[-_]/);
            for (const part of parts) {
              if (part.length >= 4) keywordMap.set(part.toLowerCase(), modName);
            }
          }
        }
      } catch { /* ok */ }
    }
  }

  if (keywordMap.size === 0) process.exit(0); // no keyword data

  // Match prompt keywords against uninstalled modules
  const warned = new Set();
  let count = 0;
  const MAX_WARNINGS = 3;
  const MIN_KEYWORD_LENGTH = 5; // skip short generic keywords (e.g., "task", "dots")

  for (const [keyword, modName] of keywordMap) {
    if (count >= MAX_WARNINGS) break;
    if (keyword.length < MIN_KEYWORD_LENGTH) continue; // too short, likely false positive
    if (installed.has(modName)) continue; // already installed
    if (warned.has(modName)) continue; // already warned
    // Use word boundary matching to avoid false positives (e.g., "unit" in "unity")
    const re = new RegExp(`\\b${keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    if (!re.test(prompt)) continue;

    warned.add(modName);
    count++;
    logHook('check-module-keywords', { match: keyword, module: modName, prompt: promptHash });
    console.log(`[t1k:module-suggest] keyword="${keyword}" module="${modName}" action="t1k modules add ${modName}"`);
  }

  timer.end({ outcome: 'ok', matches: count, prompt: promptHash });
  process.exit(0);
} catch (e) {
  try { require('./hook-logger.cjs').logHookCrash('check-module-keywords', e); } catch { /* ok */ }
  process.exit(0); // fail-open
}
