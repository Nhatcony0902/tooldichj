#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * Validates t1k:fix/t1k:cook review artifacts before finalize and external
 * ship-like actions. Hook mode is opt-in and crash fail-open. Manual CLI mode
 * always validates and returns non-zero when the gate blocks.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveArtifactDir } = require('./workflow-artifact-gate/artifact-locator.cjs');
const { detectStage, isHardStage } = require('./workflow-artifact-gate/stage-detector.cjs');
const { validateArtifacts } = require('./workflow-artifact-gate/validator.cjs');

/**
 * Disable-path resolution (#337). Three independent mechanisms; ANY truthy result disables the gate:
 *
 *   1. settings.json   — `t1k.workflowArtifactGate.disabled: true` in
 *                        <cwd>/.claude/settings.json OR ~/.claude/settings.json.
 *                        Project setting wins over global if both exist.
 *   2. file marker     — `<cwd>/.claude/t1k-artifact-gate.disabled` OR
 *                        `~/.claude/t1k-artifact-gate.disabled` (empty file).
 *   3. env var         — `T1K_WORKFLOW_ARTIFACT_GATE_DISABLED=1` (legacy;
 *                        parent-shell-only, does NOT propagate through the
 *                        sub-agent spawn harness — kept for in-shell scripts).
 *
 * Mechanisms 1 + 2 survive sub-agent spawn because they're file-based; settings
 * walked by every subagent that traverses the project tree, and file markers
 * live on disk regardless of process boundaries. Use 1 or 2 for batch tooling
 * that fans out subagents (e.g. /t1k:triage --yolo).
 *
 * Returns { disabled: boolean, source?: string } so the caller can log which
 * mechanism tripped (useful when operators forget a stale marker).
 */
function isGateDisabled(cwd) {
  // 1. settings.json (project takes priority over global)
  for (const root of [cwd, os.homedir()]) {
    if (!root) continue;
    const settingsPath = path.join(root, '.claude', 'settings.json');
    if (!fs.existsSync(settingsPath)) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      const flag = raw && raw.t1k && raw.t1k.workflowArtifactGate && raw.t1k.workflowArtifactGate.disabled;
      if (flag === true) return { disabled: true, source: settingsPath };
    } catch {
      // ignore malformed settings.json
    }
  }
  // 2. file marker (presence-only; contents ignored)
  for (const root of [cwd, os.homedir()]) {
    if (!root) continue;
    const markerPath = path.join(root, '.claude', 't1k-artifact-gate.disabled');
    if (fs.existsSync(markerPath)) return { disabled: true, source: markerPath };
  }
  // 3. legacy env var (kept for in-shell ergonomics; does NOT propagate to subagents)
  if (process.env.T1K_WORKFLOW_ARTIFACT_GATE_DISABLED === '1') {
    return { disabled: true, source: 'env:T1K_WORKFLOW_ARTIFACT_GATE_DISABLED' };
  }
  return { disabled: false };
}

function parseArgs(argv) {
  const args = {};
  for (let i = 2; i < argv.length; i += 1) {
    const item = argv[i];
    if (item === '--stage') args.stage = argv[++i];
    else if (item === '--artifact-dir') args.artifactDir = argv[++i];
    else if (item === '--json') args.json = true;
  }
  return args;
}

function readPayload() {
  const input = fs.readFileSync(0, 'utf8').trim();
  if (!input) return {};
  return JSON.parse(input);
}

/**
 * Load T1K config from .claude/t1k-config-base.json and merge any
 * .claude/t1k-config-{kit}.json fragments at higher priority.
 * Engine kits may add their own hardStages / softStages / commandPatterns.
 * Returns null if no .claude/ directory exists (global-only mode).
 */
function loadGateConfig(cwd) {
  const configFiles = [];

  // Global-only mode: if cwd has no .claude/, the gate is a no-op.
  // Hooks may be installed globally (~/.claude/) but invoked from any cwd;
  // when cwd is not a T1K-managed project, skip silently to avoid surprising
  // users who don't know the gate exists.
  const claudeDir = path.join(cwd, '.claude');
  if (!fs.existsSync(claudeDir)) {
    return null;
  }

  // Discover all t1k-config-*.json in .claude/
  try {
    const entries = fs.readdirSync(claudeDir);
    for (const entry of entries) {
      if (/^t1k-config-.+\.json$/.test(entry)) {
        configFiles.push(path.join(claudeDir, entry));
      }
    }
  } catch {
    // ignore readdir failures
  }

  // Sort: t1k-config-base.json first, then kit fragments alphabetically.
  // Base ships defaults; kit fragments add union (additive, not override).
  configFiles.sort((a, b) => {
    const aIsBase = path.basename(a) === 't1k-config-base.json';
    const bIsBase = path.basename(b) === 't1k-config-base.json';
    if (aIsBase && !bIsBase) return -1;
    if (!aIsBase && bIsBase) return 1;
    return a.localeCompare(b);
  });

  const merged = {};
  for (const configPath of configFiles) {
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      const gate = raw.workflowArtifactGate;
      if (!gate || typeof gate !== 'object') continue;
      // Snapshot the already-merged array fields BEFORE Object.assign() so we
      // can union them with the incoming fragment. Without the snapshot,
      // Object.assign would clobber the prior arrays (override semantics) — the
      // contract here is union (additive) so engine kits extend rather than
      // replace the base set. Naming: `priorMergedHardStages` etc. signals
      // "what was already in `merged` before this fragment landed", which is
      // the precondition for the union below.
      const priorMergedHardStages = merged.hardStages;
      const priorMergedSoftStages = merged.softStages;
      const priorMergedCommandPatterns = merged.commandPatterns;
      // Object.assign covers scalar fields (enabled, highRiskAutoStop, etc.).
      // Arrays handled separately below via union (additive, not override).
      Object.assign(merged, gate);
      if (Array.isArray(gate.hardStages) && Array.isArray(priorMergedHardStages)) {
        merged.hardStages = Array.from(new Set([...priorMergedHardStages, ...gate.hardStages]));
      }
      if (Array.isArray(gate.softStages) && Array.isArray(priorMergedSoftStages)) {
        merged.softStages = Array.from(new Set([...priorMergedSoftStages, ...gate.softStages]));
      }
      if (Array.isArray(gate.commandPatterns) && Array.isArray(priorMergedCommandPatterns)) {
        // Patterns: concat (no dedup — duplicates are harmless, ordering matters)
        merged.commandPatterns = priorMergedCommandPatterns.concat(gate.commandPatterns);
      }
    } catch {
      // ignore malformed config fragments
    }
  }
  return merged;
}

function formatIssues(issues) {
  return issues.map((issue) => {
    const file = issue.file ? ` ${issue.file}` : '';
    const field = issue.field ? ` ${issue.field}` : '';
    return `- ${issue.type}:${file}${field} - ${issue.message}`;
  }).join('\n');
}

function messageFor(result, locator) {
  const lines = [
    `Workflow artifact gate: ${result.status.toUpperCase()} for ${result.stage}.`,
    `Artifact dir: ${result.artifactDir || '<not resolved>'} (${locator.source || 'none'}).`
  ];
  if (locator.reasons?.length) lines.push(`Locator: ${locator.reasons.join('; ')}.`);
  if (result.errors.length) lines.push('Blocking issues:\n' + formatIssues(result.errors));
  if (result.warnings.length) lines.push('Warnings:\n' + formatIssues(result.warnings));
  lines.push('Manual check: node .claude/hooks/workflow-artifact-gate.cjs --stage ' +
    `${result.stage} --artifact-dir <dir>`);
  return lines.join('\n');
}

function emitSoft(message, event) {
  console.log(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: event || 'UserPromptSubmit',
      additionalContext: message
    }
  }));
}

function emitBlock(message) {
  console.log(JSON.stringify({ continue: false, decision: 'block', reason: message }));
}

function runValidation({ cwd, stage, artifactDir, config }) {
  const locator = resolveArtifactDir({ cwd, artifactDir });
  const result = validateArtifacts({
    artifactDir: locator.artifactDir,
    stage,
    config
  });
  return { result, locator, message: messageFor(result, locator) };
}

function main() {
  const args = parseArgs(process.argv);
  const manual = Boolean(args.stage);
  const payload = manual ? {} : readPayload();
  const cwd = payload.cwd || process.cwd();

  // Disable resolution (#337): settings.json / file marker / env var.
  // Settings + file marker survive sub-agent spawn (env var does not).
  // Emit the source on stderr so operators notice stale markers.
  const disabled = isGateDisabled(cwd);
  if (disabled.disabled) {
    console.error(`[workflow-artifact-gate] disabled via ${disabled.source}`);
    process.exit(0);
  }
  const gateConfig = loadGateConfig(cwd);

  // Global-only mode: cwd has no .claude/ → loadGateConfig returns null → no-op.
  // This prevents the gate from surprise-blocking commands in non-T1K dirs
  // (the hook may be installed globally but used from anywhere).
  if (!manual && gateConfig === null) {
    process.exit(0);
  }
  if (!manual && gateConfig && gateConfig.enabled === false) {
    process.exit(0);
  }

  // gateConfig is null only when global-only mode triggered above, which exits
  // before reaching here. From here on it's always a real object.
  const config = gateConfig;
  const stage = args.stage || detectStage(payload, config);
  if (!stage) process.exit(0);
  const { result, message } = runValidation({
    cwd,
    stage,
    artifactDir: args.artifactDir,
    config
  });

  if (manual) {
    console.log(args.json ? JSON.stringify(result, null, 2) : message);
    process.exit(result.status === 'block' ? 2 : 0);
  }

  if (result.status === 'block') {
    emitBlock(message);
    process.exit(2);
  }
  if (result.status === 'warn' || !isHardStage(stage, config)) {
    emitSoft(message, payload.hook_event_name);
  }
  process.exit(0);
}

try {
  main();
} catch {
  process.exit(0);
}

module.exports = { parseArgs, runValidation, messageFor, isGateDisabled };
