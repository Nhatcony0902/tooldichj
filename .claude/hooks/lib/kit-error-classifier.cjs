// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * kit-error-classifier.cjs — Determine if a tool error is T1K kit-related.
 *
 * Broad classifier rules (first match wins):
 *   1. T1K command: Bash with `t1k` or `/t1k:` in the command
 *   2. T1K agent: Task with subagent_type matching .claude/agents/*.md
 *   3. T1K skill: Skill with name starting with t1k- or t1k:
 *   4. Stack trace path: error mentions .claude/hooks/, .claude/skills/, .claude/agents/
 *   5. Origin metadata: file in stack trace has T1K origin metadata
 *   6. Required MCP: tool name matches mcp__{github|context7|sequential-thinking|memory}__*
 *
 * Returns: { isKit, reason, originKit, originRepo, originModule }
 *
 * Fail-open: on any exception, returns { isKit: false }.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { findProjectRoot, getHomeDir } = require('../telemetry-utils.cjs');

const REQUIRED_MCPS = new Set(['github', 'context7', 'sequential-thinking', 'memory']);

// Origin comment marker — split to prevent CI inject-origin-metadata from
// misidentifying this regex as an origin header and deleting the line.
// See rules/no-inject-origin-collision.md.
const _ORIGIN_MARKER = 't1k-' + 'origin';
const ORIGIN_COMMENT_RE = new RegExp(
  '(?:^|\\n)\\s*(?:\\/\\/|#)\\s*' + _ORIGIN_MARKER +
  ':\\s*kit=([^|\\s]+)\\s*\\|\\s*repo=([^|\\s]+)\\s*\\|\\s*module=([^|\\s]+)'
);

// Cache agent names per-process (refreshed on each classification since dir reads are cheap)
let _agentCache = null;
let _agentCacheDir = null;

/**
 * Read .claude/agents/ directory and return a Set of agent names (without .md).
 * Re-reads on each call — small dir, cheap, avoids staleness when user installs kits.
 */
function loadAgentNames() {
  try {
    const root = findProjectRoot();
    const agentsDir = path.join(root, '.claude', 'agents');
    if (_agentCache && _agentCacheDir === agentsDir) {
      return _agentCache;
    }
    if (!fs.existsSync(agentsDir)) {
      _agentCache = new Set();
      _agentCacheDir = agentsDir;
      return _agentCache;
    }
    const names = new Set();
    for (const f of fs.readdirSync(agentsDir)) {
      if (f.endsWith('.md')) names.add(f.replace(/\.md$/, ''));
    }
    _agentCache = names;
    _agentCacheDir = agentsDir;
    return names;
  } catch {
    return new Set();
  }
}

/**
 * Extract file paths referenced in a tool result (stack traces, error output).
 * Returns an array of candidate file paths (absolute or relative).
 */
function extractFilePaths(str) {
  if (!str || typeof str !== 'string') return [];
  const paths = new Set();
  // Match .claude/... paths specifically (highest signal)
  const t1kRe = /[\w~.\-/]*\.claude\/[\w\-./]+/g;
  let m;
  let safety = 0;
  while ((m = t1kRe.exec(str)) !== null && safety++ < 30) {
    paths.add(m[0]);
  }
  // Generic file paths with extensions
  const genRe = /([/~.][\w\-./]+\.(cjs|js|mjs|ts|md|json|sh|py|yml|yaml))/g;
  safety = 0;
  while ((m = genRe.exec(str)) !== null && safety++ < 30) {
    paths.add(m[1]);
  }
  return Array.from(paths);
}

/**
 * Parse T1K origin metadata from a file on disk.
 * Returns { kit, repo, module } or null if not a T1K file.
 */
function readOriginMetadata(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return null;
    const stat = fs.statSync(filePath);
    if (!stat.isFile() || stat.size > 1024 * 1024) return null; // skip big files
    // Only read first 2KB — metadata is always at the top
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(2048);
    const bytes = fs.readSync(fd, buf, 0, 2048, 0);
    fs.closeSync(fd);
    const head = buf.slice(0, bytes).toString('utf8');

    const ext = path.extname(filePath).toLowerCase();

    // JSON: look for "_origin" key
    if (ext === '.json') {
      const m = head.match(/"_origin"\s*:\s*\{[^}]*"kit"\s*:\s*"([^"]+)"[^}]*"repository"\s*:\s*"([^"]+)"(?:[^}]*"module"\s*:\s*("[^"]*"|null))?/);
      if (m) {
        const mod = m[3] && m[3] !== 'null' ? m[3].replace(/"/g, '') : null;
        return { kit: m[1], repo: m[2], module: mod };
      }
    }

    // MD: frontmatter block
    if (ext === '.md') {
      const fmMatch = head.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const fm = fmMatch[1];
        const kit = (fm.match(/^origin:\s*(\S+)/m) || [])[1];
        const repo = (fm.match(/^repository:\s*(\S+)/m) || [])[1];
        const mod = (fm.match(/^module:\s*(\S+)/m) || [])[1];
        if (kit) {
          return {
            kit,
            repo: repo || null,
            module: mod && mod !== 'null' ? mod : null,
          };
        }
      }
    }

    const commentMatch = head.match(ORIGIN_COMMENT_RE);
    if (commentMatch) {
      return {
        kit: commentMatch[1],
        repo: commentMatch[2],
        module: commentMatch[3] !== 'null' ? commentMatch[3] : null,
      };
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve a relative or ~ path to an absolute path.
 */
function resolvePath(p) {
  if (!p) return null;
  if (p.startsWith('~')) {
    const home = getHomeDir();
    return home ? path.join(home, p.slice(1)) : null;
  }
  if (p.startsWith('.')) {
    return path.resolve(process.cwd(), p);
  }
  if (path.isAbsolute(p)) return p;
  return path.resolve(process.cwd(), p);
}

/**
 * Core classifier: returns { isKit, reason, originKit, originRepo, originModule }.
 * @param {object} args
 * @param {string} [args.toolName]
 * @param {object} [args.toolInput]
 * @param {string|object} [args.toolResult]
 * @param {string} [args.projectRoot]
 */
function isKitError({ toolName, toolInput, toolResult, projectRoot } = {}) {
  try {
    const result = {
      isKit: false,
      reason: null,
      originKit: null,
      originRepo: null,
      originModule: null,
    };

    // Rule 1: T1K command (Bash)
    if (toolName === 'Bash' && toolInput?.command) {
      const cmd = String(toolInput.command);
      if (/\bt1k\b|\/t1k:/.test(cmd)) {
        return { ...result, isKit: true, reason: 't1k-command' };
      }
    }

    // Rule 2: T1K agent (Task tool spawning a registered agent)
    if (toolName === 'Task' && toolInput?.subagent_type) {
      const agentNames = loadAgentNames();
      if (agentNames.has(toolInput.subagent_type)) {
        return { ...result, isKit: true, reason: 't1k-agent' };
      }
    }

    // Rule 3: T1K skill invocation
    if (toolName === 'Skill' && toolInput?.skill) {
      const skill = String(toolInput.skill);
      if (skill.startsWith('t1k-') || skill.startsWith('t1k:')) {
        return { ...result, isKit: true, reason: 'skill-invocation' };
      }
    }

    // Rule 6: Required MCP failure (check before stack-trace rules for explicit tools)
    if (toolName && toolName.startsWith('mcp__')) {
      const mcpName = toolName.slice(5).split('__')[0];
      if (REQUIRED_MCPS.has(mcpName)) {
        return { ...result, isKit: true, reason: 'required-mcp' };
      }
    }

    // Rules 4 & 5 work off the tool result string
    const resultStr = typeof toolResult === 'string' ? toolResult :
      (toolResult ? JSON.stringify(toolResult) : '');

    // Rule 4: Stack trace mentions .claude/ kit directories
    if (/\.claude\/(hooks|skills|agents|rules)\//.test(resultStr)) {
      // Try to enrich with origin metadata before returning
      const paths = extractFilePaths(resultStr);
      for (const p of paths) {
        const abs = resolvePath(p);
        if (!abs) continue;
        const origin = readOriginMetadata(abs);
        if (origin) {
          return {
            isKit: true,
            reason: 'origin-metadata',
            originKit: origin.kit,
            originRepo: origin.repo,
            originModule: origin.module,
          };
        }
      }
      return { ...result, isKit: true, reason: 'stack-trace-path' };
    }

    // Rule 5: Any file in stack trace has T1K origin metadata
    const paths = extractFilePaths(resultStr);
    for (const p of paths) {
      const abs = resolvePath(p);
      if (!abs) continue;
      const origin = readOriginMetadata(abs);
      if (origin) {
        return {
          isKit: true,
          reason: 'origin-metadata',
          originKit: origin.kit,
          originRepo: origin.repo,
          originModule: origin.module,
        };
      }
    }

    return result;
  } catch {
    return { isKit: false, reason: null, originKit: null, originRepo: null, originModule: null };
  }
}

module.exports = {
  isKitError,
  _loadAgentNames: loadAgentNames,
  _readOriginMetadata: readOriginMetadata,
  _extractFilePaths: extractFilePaths,
};
