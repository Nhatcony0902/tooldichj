// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=t1k-extended | protected=true
'use strict';
/**
 * adapter-discovery.cjs — Frontmatter-based adapter discovery for t1k diagram tooling.
 *
 * Algorithm (per adapter-contract.md §Discovery):
 *   1. Resolve global + project scopes via resolveProjectDir() + home dir.
 *   2. Read metadata.json → installedModules[*].skills[] (SSOT — no disk scan outside list).
 *   3. Pre-filter skills by candidate regex (performance pre-filter only).
 *   4. Parse SKILL.md frontmatter → validate t1k-adapter block.
 *   5. Run detect.cjs per candidate — keep exit-0 results.
 *   6. Invoke list-capabilities.cjs — runtime output is authoritative capabilities.
 *   7. Group by engine. Resolve conflicts: highest priority → alphabetical module → hard error.
 *
 * Cross-scope: project-scope entries win on name conflict over global entries.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const {
  resolveProjectDir,
  getHomeDir,
  isT1KMetadata,
  getModuleEntries,
  T1K,
} = require(path.resolve(__dirname, '../../../hooks/telemetry-utils.cjs'));

// ── Constants ──────────────────────────────────────────────────────────────

/** Candidate pre-filter regex — performance only, NOT authoritative for engine identity. */
const CANDIDATE_REGEX = /(^|-)(?:assembly|script|service)-graph$/;

/** Max directory walk depth (bounded for security). */
const MAX_WALK_DEPTH = 5;

/** Max skills to scan per scope (guard against pathological metadata). */
const MAX_SKILLS_PER_SCOPE = 500;

/** Prototype pollution guard — keys that MUST NOT appear in frontmatter objects. */
const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// ── Inline YAML frontmatter parser ────────────────────────────────────────

/**
 * Parse YAML frontmatter from file content.
 * Handles only the subset needed for SKILL.md: string scalars, int scalars,
 * arrays of strings, and one level of nested mapping (t1k-adapter block).
 *
 * Returns parsed object or null if no frontmatter present.
 * Throws on structurally malformed YAML within the frontmatter block.
 *
 * @param {string} content
 * @returns {object|null}
 */
function parseFrontmatter(content) {
  if (typeof content !== 'string') return null;
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/);
  if (!match) return null;
  const yamlBlock = match[1];
  return _parseYamlBlock(yamlBlock, 0);
}

/**
 * Parse a flat YAML block (indented at `baseIndent` spaces).
 * Supports: string scalars, integer scalars, boolean scalars,
 * inline arrays [a, b, c], block sequences (- item), nested mappings.
 *
 * @param {string} block - raw YAML text
 * @param {number} baseIndent - indent level of this block
 * @returns {object}
 */
function _parseYamlBlock(block, baseIndent) {
  const result = {};
  const lines = block.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (!trimmed || trimmed.startsWith('#')) { i++; continue; }
    if (indent < baseIndent) break; // dedented — end of this block

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) { i++; continue; }

    const key = trimmed.slice(0, colonIdx).trim();
    const rest = trimmed.slice(colonIdx + 1).trimStart();

    if (DANGEROUS_KEYS.has(key)) {
      throw new Error(`Frontmatter prototype pollution rejected: key '${key}'`);
    }

    if (!rest) {
      // Nested block or sequence follows on next lines
      const childLines = [];
      i++;
      while (i < lines.length) {
        const nextLine = lines[i];
        const nextTrimmed = nextLine.trimStart();
        const nextIndent = nextLine.length - nextTrimmed.length;
        if (!nextTrimmed || nextTrimmed.startsWith('#')) { i++; continue; }
        if (nextIndent <= indent) break;
        childLines.push(nextLine);
        i++;
      }
      if (childLines.length > 0 && childLines[0].trimStart().startsWith('- ')) {
        result[key] = childLines
          .map(l => l.trimStart().replace(/^-\s*/, '').trim())
          .filter(Boolean);
      } else {
        const childBlock = childLines.join('\n');
        result[key] = _parseYamlBlock(childBlock, indent + 1);
      }
      continue;
    }

    if (rest.startsWith('[') && rest.endsWith(']')) {
      // Inline array: [a, b, c]
      result[key] = rest.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean);
    } else {
      result[key] = _parseScalar(rest);
    }
    i++;
  }
  return result;
}

/**
 * Parse a YAML scalar value: boolean, integer, or string.
 * Strips optional surrounding quotes.
 *
 * @param {string} raw
 * @returns {boolean|number|string}
 */
function _parseScalar(raw) {
  const s = raw.trim().replace(/^["']|["']$/g, '');
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return parseInt(s, 10);
  return s;
}

// ── Core public API ────────────────────────────────────────────────────────

/**
 * Parse a single SKILL.md file and return the t1k-adapter frontmatter block,
 * or null if absent / invalid.
 *
 * @param {string} skillMdPath - absolute path to SKILL.md
 * @returns {{ engine: string, capabilities: string[], priority: number }|null}
 */
function parseAdapterFrontmatter(skillMdPath) {
  let content;
  try {
    content = fs.readFileSync(skillMdPath, 'utf8');
  } catch (err) {
    return null;
  }

  let frontmatter;
  try {
    frontmatter = parseFrontmatter(content);
  } catch {
    return null; // malformed YAML
  }
  if (!frontmatter) return null;

  const block = frontmatter['t1k-adapter'];
  if (!block) return null;
  if (block === false || block === 'false') return null; // explicit opt-out

  if (typeof block !== 'object' || Array.isArray(block)) return null;
  return block;
}

/**
 * Validate a parsed t1k-adapter block has all required fields.
 *
 * @param {object} block
 * @returns {{ valid: boolean, reason: string|null }}
 */
function _validateAdapterBlock(block) {
  if (!block || typeof block !== 'object') {
    return { valid: false, reason: 'invalid-schema' };
  }
  if (typeof block.engine !== 'string' || !block.engine.trim()) {
    return { valid: false, reason: 'missing-engine' };
  }
  if (!Array.isArray(block.capabilities)) {
    return { valid: false, reason: 'capabilities-not-array' };
  }
  if (typeof block.priority !== 'number' || !Number.isInteger(block.priority)) {
    return { valid: false, reason: 'missing-priority' };
  }
  return { valid: true, reason: null };
}

/**
 * Read metadata.json from a given .claude/ dir and return skill entries.
 * Returns empty array if metadata absent or not T1K-shape.
 *
 * @param {string} claudeDir
 * @returns {{ skillName: string, moduleName: string }[]}
 */
function _readSkillsFromMetadata(claudeDir) {
  const metaPath = path.join(claudeDir, T1K.METADATA_FILE);
  if (!fs.existsSync(metaPath)) return [];

  let meta;
  try {
    meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  } catch {
    return [];
  }

  if (!isT1KMetadata(meta)) return [];

  const moduleEntries = getModuleEntries(meta);
  const skills = [];
  let count = 0;

  for (const modEntry of moduleEntries) {
    if (count >= MAX_SKILLS_PER_SCOPE) break;

    // installedModules entries may be objects with a `skills` array
    const modDetails = meta.installedModules?.[modEntry.name];
    const skillList = Array.isArray(modDetails?.skills) ? modDetails.skills : [];

    for (const skillName of skillList) {
      if (count >= MAX_SKILLS_PER_SCOPE) break;
      skills.push({ skillName, moduleName: modEntry.name });
      count++;
    }
  }

  return skills;
}

/**
 * Resolve the SKILL.md path for a given skill name under a .claude/ dir.
 *
 * @param {string} claudeDir
 * @param {string} skillName
 * @returns {string} absolute path to SKILL.md
 */
function _skillMdPath(claudeDir, skillName) {
  return path.join(claudeDir, T1K.SKILLS_DIR, skillName, 'SKILL.md');
}

/**
 * Run detect.cjs for a skill and return whether it matched (exit 0).
 *
 * @param {string} skillDir - absolute path to skill directory
 * @param {string} skillName - for diagnostics
 * @returns {boolean}
 */
function _runDetect(skillDir, skillName) {
  const detectScript = path.join(skillDir, 'scripts', 'detect.cjs');
  if (!fs.existsSync(detectScript)) {
    process.stderr.write(`Skipping ${skillName}: scripts/detect.cjs not found\n`);
    return false;
  }
  try {
    execFileSync(process.execPath, [detectScript], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10000,
    });
    return true; // exit 0
  } catch {
    return false; // non-zero exit
  }
}

/**
 * Run list-capabilities.cjs for a skill and return the runtime capability list.
 * Falls back to the frontmatter-declared capabilities on any error.
 *
 * @param {string} skillDir - absolute path to skill directory
 * @param {string} skillName - for diagnostics
 * @param {string[]} declaredCapabilities - frontmatter fallback
 * @returns {string[]}
 */
function _runListCapabilities(skillDir, skillName, declaredCapabilities) {
  const capScript = path.join(skillDir, 'scripts', 'list-capabilities.cjs');
  if (!fs.existsSync(capScript)) {
    process.stderr.write(`Warning: ${skillName}: scripts/list-capabilities.cjs not found — using frontmatter capabilities\n`);
    return declaredCapabilities;
  }
  try {
    const output = execFileSync(process.execPath, [capScript], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      timeout: 10000,
      encoding: 'utf8',
    });
    const parsed = JSON.parse(output.trim());
    if (Array.isArray(parsed)) return parsed;
    process.stderr.write(`Warning: ${skillName}: list-capabilities.cjs returned non-array — using frontmatter capabilities\n`);
    return declaredCapabilities;
  } catch {
    process.stderr.write(`Warning: ${skillName}: list-capabilities.cjs failed — using frontmatter capabilities\n`);
    return declaredCapabilities;
  }
}

/**
 * Scan candidates from one scope. Returns raw candidate entries (pre-detect).
 *
 * @param {string} claudeDir
 * @param {'global'|'project'} scope
 * @returns {{ candidates: object[], skipped: object[] }}
 */
function _scanScope(claudeDir, scope) {
  const candidates = [];
  const skipped = [];

  const skills = _readSkillsFromMetadata(claudeDir);

  for (const { skillName, moduleName } of skills) {
    if (!CANDIDATE_REGEX.test(skillName)) continue; // pre-filter

    const skillMdPath = _skillMdPath(claudeDir, skillName);
    if (!fs.existsSync(skillMdPath)) {
      skipped.push({ file: skillMdPath, reason: 'skill-md-not-found', skillName, scope });
      continue;
    }

    let rawBlock;
    try {
      const content = fs.readFileSync(skillMdPath, 'utf8');
      let fm;
      try {
        fm = parseFrontmatter(content);
      } catch {
        skipped.push({ file: skillMdPath, reason: 'malformed-frontmatter', skillName, scope });
        process.stderr.write(`Skipping ${skillName}: malformed YAML frontmatter\n`);
        continue;
      }
      if (!fm) {
        skipped.push({ file: skillMdPath, reason: 'no-frontmatter', skillName, scope });
        process.stderr.write(`Skipping ${skillName}: missing t1k-adapter frontmatter block\n`);
        continue;
      }
      const block = fm['t1k-adapter'];
      if (!block) {
        skipped.push({ file: skillMdPath, reason: 'no-adapter-block', skillName, scope });
        process.stderr.write(`Skipping ${skillName}: missing or invalid t1k-adapter frontmatter\n`);
        continue;
      }
      if (block === false || block === 'false') {
        skipped.push({ file: skillMdPath, reason: 'explicit-opt-out', skillName, scope });
        continue; // deliberate non-adapter — silent skip
      }
      rawBlock = block;
    } catch {
      skipped.push({ file: skillMdPath, reason: 'read-error', skillName, scope });
      continue;
    }

    const { valid, reason } = _validateAdapterBlock(rawBlock);
    if (!valid) {
      skipped.push({ file: skillMdPath, reason: reason || 'invalid-schema', skillName, scope });
      process.stderr.write(`Skipping ${skillName}: missing or invalid t1k-adapter frontmatter\n`);
      continue;
    }

    candidates.push({
      skillName,
      moduleName,
      engine: rawBlock.engine,
      capabilities: rawBlock.capabilities,
      priority: rawBlock.priority,
      skillDir: path.join(claudeDir, T1K.SKILLS_DIR, skillName),
      skillMdPath,
      scope,
    });
  }

  return { candidates, skipped };
}

/**
 * Discover all installed adapter skills across global and project scopes.
 * Steps 1–4 from the algorithm (metadata read + frontmatter parse + validate).
 * Does NOT run detect.cjs or list-capabilities.cjs.
 *
 * Exposed for T3a (CI gate) which only needs the schema-validation layer.
 *
 * @returns {{
 *   byEngine: Record<string, object[]>,
 *   skipped: object[],
 *   scopes: string[],
 * }}
 */
function listAllMatches() {
  const scopes = [];
  const allCandidates = [];
  const allSkipped = [];

  const { globalClaudeDir, projectClaudeDir } = _resolveScopes();

  if (globalClaudeDir) {
    const { candidates, skipped } = _scanScope(globalClaudeDir, 'global');
    allCandidates.push(...candidates);
    allSkipped.push(...skipped);
    scopes.push('global');
  }

  if (projectClaudeDir && projectClaudeDir !== globalClaudeDir) {
    const { candidates, skipped } = _scanScope(projectClaudeDir, 'project');
    allCandidates.push(...candidates);
    allSkipped.push(...skipped);
    if (!scopes.includes('project')) scopes.push('project');
  }

  // De-dupe: project-scope wins on same skill name
  const deduped = _dedupeBySkillName(allCandidates);

  return {
    byEngine: _groupByEngine(deduped),
    skipped: allSkipped,
    scopes,
  };
}

/**
 * Full discovery pipeline: metadata read → frontmatter → detect → capabilities.
 * Returns only adapters that passed detect.cjs, grouped by engine.
 *
 * @returns {{
 *   byEngine: Record<string, object[]>,
 *   skipped: object[],
 *   scopes: string[],
 * }}
 */
function discoverAdapters() {
  const { byEngine: rawByEngine, skipped, scopes } = listAllMatches();

  const resolvedByEngine = {};

  for (const [engine, candidates] of Object.entries(rawByEngine)) {
    const passing = [];
    for (const candidate of candidates) {
      const detected = _runDetect(candidate.skillDir, candidate.skillName);
      if (!detected) {
        skipped.push({ file: candidate.skillMdPath, reason: 'detect-failed', skillName: candidate.skillName, scope: candidate.scope });
        continue;
      }
      const runtimeCaps = _runListCapabilities(
        candidate.skillDir, candidate.skillName, candidate.capabilities
      );
      passing.push({ ...candidate, capabilities: runtimeCaps });
    }
    if (passing.length > 0) {
      resolvedByEngine[engine] = passing;
    }
  }

  return { byEngine: resolvedByEngine, skipped, scopes };
}

/**
 * Given an engine name, return the best adapter (priority-ordered conflict resolution).
 * Throws a hard error when two adapters tie on both priority AND module name.
 *
 * @param {string} engineName
 * @returns {object|null} resolved adapter or null if none installed
 */
function resolveAdapter(engineName) {
  const { byEngine } = discoverAdapters();
  const candidates = byEngine[engineName];
  if (!candidates || candidates.length === 0) return null;
  if (candidates.length === 1) return candidates[0];

  // Emit notice for multi-adapter decision (per T3 algorithm step 9)
  process.stderr.write(
    `[adapter-discovery] Multiple adapters for engine '${engineName}' — resolving by priority:\n` +
    candidates.map(c => `  - ${c.skillName} (module: ${c.moduleName}, priority: ${c.priority})`).join('\n') + '\n'
  );

  return _resolveConflict(engineName, candidates);
}

// ── Internal helpers ───────────────────────────────────────────────────────

/**
 * Resolve global and project .claude/ directory paths.
 *
 * @returns {{ globalClaudeDir: string|null, projectClaudeDir: string|null }}
 */
function _resolveScopes() {
  const home = getHomeDir();
  const globalClaudeDir = home ? path.join(home, T1K.CLAUDE_DIR) : null;
  const validGlobal = globalClaudeDir && fs.existsSync(globalClaudeDir) ? globalClaudeDir : null;

  const projectCtx = resolveProjectDir();
  const projectClaudeDir = projectCtx.t1kDir && fs.existsSync(projectCtx.t1kDir)
    ? projectCtx.t1kDir
    : null;

  // If project .claude/ is the same as global (global-only mode), don't double-scan
  const effectiveProject = (projectClaudeDir && projectClaudeDir !== validGlobal)
    ? projectClaudeDir
    : null;

  return { globalClaudeDir: validGlobal, projectClaudeDir: effectiveProject };
}

/**
 * De-duplicate candidates across scopes: project-scope entry wins on same skill name.
 *
 * @param {object[]} candidates
 * @returns {object[]}
 */
function _dedupeBySkillName(candidates) {
  const byName = new Map();
  for (const c of candidates) {
    const existing = byName.get(c.skillName);
    if (!existing || c.scope === 'project') {
      byName.set(c.skillName, c);
    }
  }
  return [...byName.values()];
}

/**
 * Group a flat candidate list by engine.
 *
 * @param {object[]} candidates
 * @returns {Record<string, object[]>}
 */
function _groupByEngine(candidates) {
  const groups = {};
  for (const c of candidates) {
    if (!groups[c.engine]) groups[c.engine] = [];
    groups[c.engine].push(c);
  }
  return groups;
}

/**
 * Resolve conflict when 2+ adapters declare the same engine.
 * Priority desc → alphabetical module name → hard error.
 *
 * @param {string} engine
 * @param {object[]} candidates - must have length >= 2
 * @returns {object}
 */
function _resolveConflict(engine, candidates) {
  const sorted = [...candidates].sort((a, b) => {
    if (b.priority !== a.priority) return b.priority - a.priority;
    return a.moduleName.localeCompare(b.moduleName);
  });

  const winner = sorted[0];
  const runnerUp = sorted[1];

  if (winner.priority === runnerUp.priority && winner.moduleName === runnerUp.moduleName) {
    throw new Error(
      `Multiple adapters declare engine '${engine}' with identical priority and module name — ` +
      `one must increase priority. Conflicting: ${winner.skillName}, ${runnerUp.skillName}`
    );
  }

  return winner;
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  discoverAdapters,
  resolveAdapter,
  listAllMatches,
  parseAdapterFrontmatter,
};
