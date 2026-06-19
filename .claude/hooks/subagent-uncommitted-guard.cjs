#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * subagent-uncommitted-guard.cjs — SubagentStop enforcement backstop (#508).
 *
 * `rules/agent-completion-discipline.md` mandates "commit before you summarize"
 * and a 150K-token checkpoint, but the rule is ADVISORY — nothing enforces it.
 * Write-capable sub-agents routinely tail-stop with completed edits left
 * UNCOMMITTED (issue #508: a general-purpose agent ran to 243K tokens and
 * exited with nothing landed; reproduced 4× in one 2026-06-15 cook session).
 *
 * This hook is the BACKSTOP the rule lacked. On SubagentStop, if the working
 * tree carries uncommitted TRACKED changes, it emits a `[t1k:agent-stopped-dirty]`
 * warning so the parent orchestrator verifies + commits the work (exactly the
 * manual recovery the coordinator did 4× that session) — and, behind an opt-in
 * flag, takes a non-destructive `git stash create` snapshot so the work can
 * never be lost.
 *
 * Conservative-Pick (opt-in · warn-first · reversible):
 *   - WARN is default-on, gated by `features.subagentUncommittedGuard` (default
 *     true → disableable kill-switch). Pure stdout; never blocks the agent.
 *   - SNAPSHOT is default-OFF, gated by `features.autoSnapshotOnSubagentStop`.
 *     Uses `git stash create` + `git stash store` — does NOT touch the working
 *     tree, index, or HEAD; the snapshot is recoverable via `git stash list`.
 *
 * False-positive guards (only fire for a sub-agent that COULD have written):
 *   - Skip when `agent_type` is absent / "unknown" — a missing agent_type on
 *     SubagentStop means we're likely reading the MAIN-session transcript,
 *     where pre-existing parent WIP is normal (mirrors workflow-failure-detector).
 *   - Skip known READ-ONLY built-ins (Explore, Plan) — they have no Edit/Write
 *     tools, so a dirty tree at their stop is pre-existing parent work, not theirs.
 *   - `--untracked-files=no` — ignore scratch/log noise; only tracked edits count.
 *
 * Fail-open: any exception → exit 0. Never disrupts the agent lifecycle.
 *
 * AI-driven design: emits a FACT (tree dirty at sub-agent stop, with sample
 * paths). It does NOT decide what to commit — the parent reasons over the warning.
 */
'use strict';

const { execFileSync } = require('child_process');
const {
  parseHookStdin,
  findProjectRoot,
  resolveClaudeDir,
  readFeatureFlag,
} = require('./telemetry-utils.cjs');

// Read-only built-in agents have no Edit/Write tools — a dirty tree at their
// stop is never their doing. Kept inline (tiny, hook-local) to avoid a
// cross-repo dependency on the model-router's _is_readonly_agent helper.
const READONLY_AGENTS = new Set(['Explore', 'Plan']);

/**
 * Tracked (non-untracked) working-tree changes at `cwd`. Empty array when the
 * tree is clean OR `cwd` is not a git repo (git errors → []).
 * @param {string} cwd
 * @returns {string[]} porcelain lines (e.g. " M path", "A  path")
 */
function trackedDirty(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    return out.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Best-effort, non-destructive snapshot of the dirty tree. `git stash create`
 * builds a stash commit object WITHOUT touching the tree/index/HEAD; `git stash
 * store` records it in the stash list so it survives GC. Returns the short SHA
 * or null.
 * @param {string} cwd
 * @param {string} agent
 * @returns {string|null}
 */
function snapshot(cwd, agent) {
  try {
    const sha = execFileSync('git', ['stash', 'create', `t1k-wip: ${agent} subagent-stop`], {
      cwd, encoding: 'utf8', timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    }).trim();
    if (!sha) return null;
    execFileSync('git', ['stash', 'store', '-m', `t1k-wip ${agent} subagent-stop`, sha], {
      cwd, timeout: 8000, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true,
    });
    return sha.slice(0, 9);
  } catch {
    return null;
  }
}

function main() {
  const data = parseHookStdin() || {};

  const agentType = typeof data.agent_type === 'string' ? data.agent_type.trim() : '';
  // Suppress when we can't attribute the stop to a real, write-capable sub-agent.
  if (!agentType || agentType === 'unknown' || READONLY_AGENTS.has(agentType)) return;

  let cwd;
  try { cwd = process.cwd(); } catch { return; }
  const root = findProjectRoot(cwd) || cwd;
  // resolveClaudeDir() returns { claudeDir, isGlobalOnly, home } | null (no args).
  const { claudeDir } = resolveClaudeDir() || {};

  // Kill-switch (default ON). Disable via features.subagentUncommittedGuard:false.
  // A null claudeDir → readFeatureFlag falls back to the default (guard stays on).
  if (!readFeatureFlag(claudeDir, 'subagentUncommittedGuard', true)) return;

  const dirty = trackedDirty(root);
  if (dirty.length === 0) return; // clean tree → silent (the good path)

  const sample = dirty.slice(0, 5).map(l => l.slice(3)).join(', ');
  const more = dirty.length > 5 ? ', …' : '';
  console.log(
    `[t1k:agent-stopped-dirty agent=${agentType} files=${dirty.length} sample="${sample}${more}"] ` +
    'uncommitted tracked changes present at sub-agent stop — verify and COMMIT them before proceeding ' +
    '(per rules/agent-completion-discipline.md: commit before you summarize).'
  );

  // Opt-in non-destructive safety net (default OFF).
  if (readFeatureFlag(claudeDir, 'autoSnapshotOnSubagentStop', false)) {
    const sha = snapshot(root, agentType);
    if (sha) {
      console.log(`[t1k:agent-stopped-dirty] snapshot saved as git stash ${sha} — recover via 'git stash list'.`);
    }
  }
}

try {
  main();
} catch {
  /* fail-open: never disrupt the agent lifecycle */
} finally {
  process.exit(0);
}
