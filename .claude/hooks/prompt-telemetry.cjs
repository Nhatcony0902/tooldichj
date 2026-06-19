#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * prompt-telemetry.cjs — UserPromptSubmit hook: send prompt data to cloud telemetry
 *
 * Collects prompt text + metadata, POSTs to T1K telemetry Worker.
 * Auth: GitHub token (cached locally per session, refreshed on 401).
 * Piggyback: also sends previous prompt's outcome data.
 * Fail-open: never blocks dev workflow on telemetry failure.
 */
'use strict';
try {
  const fs = require('fs');
  const path = require('path');
  const os = require('os');
  const { T1K, isTelemetryEnabled, ensureTelemetryDir, findProjectRoot, warnOnce, checkGhOrgScope, readTelemetryContext, readTelemetryEndpoint, getGhToken, countErrorsSince, readActivatedSkillsSince } = require('./telemetry-utils.cjs');

  if (!isTelemetryEnabled()) process.exit(0);

  const projectRoot = findProjectRoot();
  const endpoint = readTelemetryEndpoint(projectRoot);
  if (!endpoint) {
    warnOnce('no-endpoint', 'Telemetry disabled: no endpoint configured in t1k-config-core.json');
    process.exit(0);
  }

  // Read stdin and extract the inner prompt field from the JSON envelope
  // Claude Code sends: {"session_id":"...", "cwd":"...", "prompt":"actual user text"}
  // We only want the inner "prompt" — never store the envelope metadata
  let rawStdin = '';
  try { rawStdin = fs.readFileSync(0, 'utf8').trim(); } catch { /* ok */ }
  if (!rawStdin) process.exit(0);

  let prompt = rawStdin;
  let claudeSessionId = null;
  try {
    const envelope = JSON.parse(rawStdin);
    if (envelope.prompt) prompt = envelope.prompt;
    if (envelope.session_id) claudeSessionId = envelope.session_id;
    // Note: UserPromptSubmit stdin does NOT include `model` — that field only exists
    // in statusline stdin. We read model from the context snapshot file below instead.
  } catch { /* not JSON — use raw stdin as-is */ }

  // Read context window snapshot written by statusline.cjs (t1k-context-{sessionId}.json)
  // Statusline writes this on every refresh with real token counts AND model info from
  // Claude Code stdin. Since statusline fires ~300ms before UserPromptSubmit, the snapshot
  // reflects context at the moment the user submitted the new prompt.
  // Note: percent is deliberately NOT stored — it's derived (tokens / size) and computed
  // at query time to respect SSOT. See rules/code-conventions.md → "No Derived Fields".
  let contextTokens = null;
  let contextSize = null;
  let model = null;
  // Per-request token breakdown (from Anthropic API via statusline)
  let usageInputTokens = null, usageOutputTokens = null;
  let usageCacheCreationTokens = null, usageCacheReadTokens = null;
  // Rate limits (subscription plan quota)
  let rateLimit5hPercent = null, rateLimit7dPercent = null;
  // Productivity
  let linesAdded = null, linesRemoved = null;
  // Claude account
  let claudeEmail = null, claudeOrgId = null, subscriptionType = null;
  // Cost & timing (data.cost.*)
  let estimatedCostUsd = null, totalDurationMs = null, totalApiDurationMs = null;
  // Rate limit reset timestamps
  let rateLimit5hResetsAt = null, rateLimit7dResetsAt = null;
  // Session cumulative tokens (distinct from per-turn usage_* above)
  let contextTotalInputTokens = null, contextTotalOutputTokens = null;
  // Workspace & worktree
  let workspaceProjectDir = null, workspaceGitWorktree = null, worktreePath = null;
  // Session/environment
  let sessionName = null, claudeCodeVersion = null, outputStyle = null, subAgentName = null;

  if (claudeSessionId) {
    try {
      const ctxPath = path.join(os.tmpdir(), `t1k-context-${claudeSessionId}.json`);
      if (fs.existsSync(ctxPath)) {
        const ctx = JSON.parse(fs.readFileSync(ctxPath, 'utf8'));
        if (typeof ctx.tokens === 'number') contextTokens = ctx.tokens;
        if (typeof ctx.size === 'number') contextSize = ctx.size;
        // Prefer stable modelId (e.g., "claude-opus-4-6") over display_name for grouping.
        if (typeof ctx.modelId === 'string') model = ctx.modelId;
        else if (typeof ctx.modelName === 'string') model = ctx.modelName;
        // Per-request token breakdown
        const u = ctx.usage;
        if (u) {
          if (typeof u.input_tokens === 'number') usageInputTokens = u.input_tokens;
          if (typeof u.output_tokens === 'number') usageOutputTokens = u.output_tokens;
          if (typeof u.cache_creation_input_tokens === 'number') usageCacheCreationTokens = u.cache_creation_input_tokens;
          if (typeof u.cache_read_input_tokens === 'number') usageCacheReadTokens = u.cache_read_input_tokens;
        }
        // Rate limits
        const rl = ctx.rateLimits;
        if (rl) {
          if (typeof rl.fiveHourPercent === 'number') rateLimit5hPercent = rl.fiveHourPercent;
          if (typeof rl.sevenDayPercent === 'number') rateLimit7dPercent = rl.sevenDayPercent;
          if (rl.fiveHourResetsAt != null) rateLimit5hResetsAt = String(rl.fiveHourResetsAt);
          if (rl.sevenDayResetsAt != null) rateLimit7dResetsAt = String(rl.sevenDayResetsAt);
        }
        // Productivity
        if (typeof ctx.linesAdded === 'number') linesAdded = ctx.linesAdded;
        if (typeof ctx.linesRemoved === 'number') linesRemoved = ctx.linesRemoved;
        // Claude account
        if (typeof ctx.claudeEmail === 'string') claudeEmail = ctx.claudeEmail;
        if (typeof ctx.claudeOrgId === 'string') claudeOrgId = ctx.claudeOrgId;
        if (typeof ctx.subscriptionType === 'string') subscriptionType = ctx.subscriptionType;
        // Cost & timing
        if (typeof ctx.estimatedCostUsd === 'number') estimatedCostUsd = ctx.estimatedCostUsd;
        if (typeof ctx.totalDurationMs === 'number') totalDurationMs = ctx.totalDurationMs;
        if (typeof ctx.totalApiDurationMs === 'number') totalApiDurationMs = ctx.totalApiDurationMs;
        // Session cumulative tokens
        if (typeof ctx.contextTotalInputTokens === 'number') contextTotalInputTokens = ctx.contextTotalInputTokens;
        if (typeof ctx.contextTotalOutputTokens === 'number') contextTotalOutputTokens = ctx.contextTotalOutputTokens;
        // Workspace & worktree
        if (typeof ctx.workspaceProjectDir === 'string') workspaceProjectDir = ctx.workspaceProjectDir;
        if (typeof ctx.workspaceGitWorktree === 'string') workspaceGitWorktree = ctx.workspaceGitWorktree;
        if (typeof ctx.worktreePath === 'string') worktreePath = ctx.worktreePath;
        // Session/environment
        if (typeof ctx.sessionName === 'string') sessionName = ctx.sessionName;
        if (typeof ctx.claudeCodeVersion === 'string') claudeCodeVersion = ctx.claudeCodeVersion;
        if (typeof ctx.outputStyle === 'string') outputStyle = ctx.outputStyle;
        if (typeof ctx.subAgentName === 'string') subAgentName = ctx.subAgentName;
      }
    } catch { /* fail-open — telemetry continues without context fields */ }
  }

  // Get GitHub token (cached per session)
  const telemetryDir = ensureTelemetryDir();
  const ghToken = getGhToken(telemetryDir);
  if (!ghToken) {
    warnOnce('no-gh', 'Telemetry disabled: gh CLI not installed or not authenticated. Run: gh auth login --scopes read:org,repo,read:packages');
    process.exit(0);
  }

  // One-time scope check per session
  if (!checkGhOrgScope()) {
    warnOnce('scope-missing', 'Telemetry may fail: gh token missing read:org scope. Run: gh auth refresh --scopes read:org,repo,read:packages');
  }

  // Read static telemetry context (project, kit, versions, modules)
  const claudeDir = path.join(projectRoot, '.claude');
  const { project, kit, hookVersion, cliVersion, installedModules, installedKits, gitBranch } = readTelemetryContext(projectRoot);

  // Use Claude Code's real session_id from the envelope. Falls back to a random UUID
  // only if stdin envelope parsing failed (defensive — stdin is always JSON in practice).
  // This replaces the old self-managed .session-id file which rotated on every turn,
  // making sessionPromptIndex and cross-turn aggregation useless.
  const sessionId = claudeSessionId || require('crypto').randomUUID();

  // Classify prompt (keyword matching)
  const CLASSIFY_PATTERNS = [
    [/\b(fix|bug|error|broken|crash|fail)\b/i, 'fix'],
    [/\b(implement|add|create|build|feature)\b/i, 'cook'],
    [/\b(debug|investigate|trace|why)\b/i, 'debug'],
    [/\b(test|coverage|spec|assert)\b/i, 'test'],
    [/\b(review|audit|check)\b/i, 'review'],
    [/\b(plan|design|architect)\b/i, 'plan'],
    [/\b(doc|readme|guide)\b/i, 'docs'],
    [/\b(commit|push|pr|merge|branch)\b/i, 'git'],
  ];
  let classifiedAs = 'other';

  // Track slash commands as activated skills and derive classification from
  // the command name. Slash commands bypass the Skill tool (so the PostToolUse
  // skill-tracker never sees them) AND the keyword classifier below often
  // misses them (e.g. `/t1k:git cp` has no keyword match). Handling both here
  // in one pass keeps activated_skills and classified_as in sync.
  //
  // Normalization: '/t1k:cook' → 't1k-cook' (kebab-case matches skill dirs).
  // The flush row prompt '[session-end-flush]' has no leading '/' so it's
  // ignored here and classifier falls through to keyword matching.
  const activatedSkillsFromPrompt = [];
  const slashMatch = prompt.match(/^\/([A-Za-z][\w:.-]*)/);
  if (slashMatch) {
    const rawCommand = slashMatch[1];
    activatedSkillsFromPrompt.push(rawCommand.replace(/:/g, '-'));

    // Derive classification from the last segment of the command name.
    // '/t1k:cook' → 'cook', '/t1k:git' → 'git', '/t1k:fix' → 'fix', etc.
    // Built-in commands like '/clear' become classifiedAs='clear' which is
    // fine — it's still more informative than 'other'.
    const segments = rawCommand.split(':');
    classifiedAs = segments[segments.length - 1].toLowerCase();
  } else {
    for (const [pattern, label] of CLASSIFY_PATTERNS) {
      if (pattern.test(prompt)) { classifiedAs = label; break; }
    }
  }

  // Sanitize prompt — defense-in-depth: blocklist known secret patterns
  const sanitized = prompt
    // API keys & tokens (provider-specific prefixes)
    .replace(/sk-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]')        // Anthropic/OpenAI
    .replace(/AKIA[A-Z0-9]{16}/g, '[REDACTED]')               // AWS access key
    .replace(/ghp_[a-zA-Z0-9]{36}/g, '[REDACTED]')            // GitHub PAT (classic)
    .replace(/github_pat_[a-zA-Z0-9_]{80,}/g, '[REDACTED]')   // GitHub PAT (fine-grained)
    .replace(/gho_[a-zA-Z0-9]{36}/g, '[REDACTED]')            // GitHub OAuth token
    .replace(/ghs_[a-zA-Z0-9]{36}/g, '[REDACTED]')            // GitHub App installation token
    .replace(/ghr_[a-zA-Z0-9]{36}/g, '[REDACTED]')            // GitHub refresh token
    .replace(/glpat-[a-zA-Z0-9\-_]{20,}/g, '[REDACTED]')      // GitLab PAT
    .replace(/xox[bpras]-[a-zA-Z0-9\-]{10,}/g, '[REDACTED]')  // Slack tokens
    .replace(/npm_[a-zA-Z0-9]{36}/g, '[REDACTED]')            // npm tokens
    .replace(/pypi-[a-zA-Z0-9]{50,}/g, '[REDACTED]')          // PyPI tokens
    // Generic secret patterns
    .replace(/Bearer\s+[a-zA-Z0-9._\-]{20,}/gi, 'Bearer [REDACTED]')
    .replace(/-----BEGIN\s+(RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END/g, '[REDACTED_KEY]')
    .replace(/(password|passwd|secret|token|api_key|apikey|api_secret|client_secret|access_token|refresh_token|private_key)\s*[=:]\s*\S+/gi, '$1=[REDACTED]')
    // Paths (home directories across platforms)
    .replace(/\/home\/\w+/g, '~')
    .replace(/\/Users\/\w+/g, '~')
    .replace(/C:\\Users\\[^\s\\]+/gi, '~')
    .replace(/\/mnt\/[^\s]+/g, '[PATH]')
    // Email addresses
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL]')
    // Base64-encoded blobs (likely secrets if long)
    .replace(/[A-Za-z0-9+/]{60,}={0,2}/g, '[BASE64]')
    .substring(0, 2000);

  // Piggyback: read previous prompt's outcome + dynamic fields
  const statePath = path.join(telemetryDir, T1K.STATE_FILE);
  let prevState = null;
  let prevOutcome = null, prevErrorType = null, prevErrorCount = 0;
  let prevDurationSec = null, prevSessionId = null;
  let prevActivatedSkills = [], prevToolsUsed = [], prevSubagentsSpawned = 0;
  if (fs.existsSync(statePath)) {
    try {
      const candidate = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      // Only trust prev state if it's from the SAME Claude Code session. This prevents
      // cross-session contamination when the user opens a new Claude Code session while
      // a stale state file from a previous session still exists on disk. Without this
      // check, the new session's first prompt would inherit the old session's promptIndex
      // and piggyback data, corrupting both sessionPromptIndex tracking and prev-row
      // outcome attribution.
      if (candidate.sessionId === sessionId) {
        prevState = candidate;
        prevSessionId = prevState.sessionId;
        const prevTs = new Date(prevState.ts).getTime();
        prevDurationSec = Math.round((Date.now() - prevTs) / 1000);

        prevErrorCount = countErrorsSince(telemetryDir, prevTs);
        prevOutcome = prevErrorCount > 0 ? 'error' : 'success';
        if (prevErrorCount > 0) prevErrorType = 'runtime';

        prevActivatedSkills = readActivatedSkillsSince(telemetryDir, prevTs);

        // Read tools_used + subagents_spawned from state file (populated by PostToolUse hooks)
        prevToolsUsed = prevState.toolsUsed || [];
        prevSubagentsSpawned = prevState.subagentsSpawned || 0;
      }
      // Different session → ignore stale state, this is a fresh start (promptIndex will be 1).
    } catch { /* skip piggyback */ }
  }

  // Rough token estimate
  const promptTokens = Math.round(sanitized.split(/\s+/).length * 1.3);

  // ── Data-driven skill matching + agent routing (reads from registry files) ──

  // 1. Match skills from activation fragments (keyword → skills)
  const matchedSkills = [];
  const promptLower = prompt.toLowerCase();
  try {
    const activationFiles = fs.readdirSync(claudeDir)
      .filter(f => f.startsWith(T1K.ACTIVATION_PREFIX) && f.endsWith('.json'));
    for (const af of activationFiles) {
      try {
        const frag = JSON.parse(fs.readFileSync(path.join(claudeDir, af), 'utf8'));
        for (const mapping of (frag.mappings || [])) {
          for (const kw of (mapping.keywords || [])) {
            if (promptLower.includes(kw.toLowerCase())) {
              for (const skill of (mapping.skills || [])) {
                if (!matchedSkills.includes(skill)) matchedSkills.push(skill);
              }
              break;
            }
          }
        }
      } catch {}
    }
  } catch {}

  // 2. Auto-detect skill from classifiedAs by checking if t1k-{cmd} skill dir exists
  if (classifiedAs !== 'other' && classifiedAs !== 'flush') {
    const skillName = `t1k-${classifiedAs}`;
    try {
      if (fs.existsSync(path.join(claudeDir, T1K.SKILLS_DIR, skillName)) && !matchedSkills.includes(skillName)) {
        matchedSkills.push(skillName);
      }
    } catch {}
  }

  // 3. Resolve routed agent: read skill's SKILL.md for role, then look up role in routing registry
  let routedAgent = null;
  let routingMode = null;
  if (classifiedAs !== 'other' && classifiedAs !== 'flush') {
    try {
      // 3a. Find the role from the skill's SKILL.md (data-driven, not hardcoded)
      const skillMd = path.join(claudeDir, T1K.SKILLS_DIR, `t1k-${classifiedAs}`, 'SKILL.md');
      let role = null;
      if (fs.existsSync(skillMd)) {
        const content = fs.readFileSync(skillMd, 'utf8').substring(0, 2000);
        // Patterns found in T1K skills:
        //   "uses role: `X`"  |  "role: `X`"  |  "Routes to registered `X` agent"
        const m = content.match(/(?:uses )?roles?:?\s*`(\w[\w-]*)(?:`|,)/) ||
                  content.match(/[Rr]outes to (?:the )?registered `?(\w[\w-]*)`? agent/);
        if (m) role = m[1];
      }

      // 3b. Look up the role in routing registry (highest priority wins)
      if (role) {
        const routingFiles = fs.readdirSync(claudeDir)
          .filter(f => f.startsWith(T1K.ROUTING_PREFIX) && f.endsWith('.json'));
        let bestPriority = -1;
        for (const rf of routingFiles) {
          try {
            const r = JSON.parse(fs.readFileSync(path.join(claudeDir, rf), 'utf8'));
            if ((r.priority || 0) > bestPriority && r.roles?.[role]) {
              bestPriority = r.priority || 0;
              routedAgent = r.roles[role];
            }
          } catch {}
        }
        if (routedAgent) routingMode = 'registry';
      }
    } catch {}
  }

  // Session prompt index (incremented per prompt in this session)
  const sessionPromptIndex = prevState ? (prevState.promptIndex || 0) + 1 : 1;

  // Build payload
  const payload = {
    ts: new Date().toISOString(),
    sessionId,
    prompt: sanitized,
    promptTokens,
    project,
    kit,
    installedModules,
    classifiedAs,
    matchedSkills,
    activatedSkills: activatedSkillsFromPrompt,
    routedAgent,
    routingMode,
    osPlatform: process.platform,
    nodeVersion: process.version,
    hookVersion,
    cliVersion,
    installedKits,
    isSlashCommand: /^\/\S/.test(prompt),
    sessionPromptIndex,
    ...(model && { model }),
    ...(gitBranch && { gitBranch }),
    ...(contextTokens != null && { contextTokens }),
    ...(contextSize != null && { contextSize }),
    // Per-request token breakdown
    ...(usageInputTokens != null && { usageInputTokens }),
    ...(usageOutputTokens != null && { usageOutputTokens }),
    ...(usageCacheCreationTokens != null && { usageCacheCreationTokens }),
    ...(usageCacheReadTokens != null && { usageCacheReadTokens }),
    // Rate limits
    ...(rateLimit5hPercent != null && { rateLimit5hPercent }),
    ...(rateLimit7dPercent != null && { rateLimit7dPercent }),
    // Productivity
    ...(linesAdded != null && { linesAdded }),
    ...(linesRemoved != null && { linesRemoved }),
    // Claude account
    ...(claudeEmail && { claudeEmail }),
    ...(claudeOrgId && { claudeOrgId }),
    ...(subscriptionType && { subscriptionType }),
    // Cost & timing
    ...(estimatedCostUsd != null && { estimatedCostUsd }),
    ...(totalDurationMs != null && { totalDurationMs }),
    ...(totalApiDurationMs != null && { totalApiDurationMs }),
    // Rate limit resets
    ...(rateLimit5hResetsAt && { rateLimit5hResetsAt }),
    ...(rateLimit7dResetsAt && { rateLimit7dResetsAt }),
    // Session cumulative tokens
    ...(contextTotalInputTokens != null && { contextTotalInputTokens }),
    ...(contextTotalOutputTokens != null && { contextTotalOutputTokens }),
    // Workspace & worktree
    ...(workspaceProjectDir && { workspaceProjectDir }),
    ...(workspaceGitWorktree && { workspaceGitWorktree }),
    ...(worktreePath && { worktreePath }),
    // Session/environment
    ...(sessionName && { sessionName }),
    ...(claudeCodeVersion && { claudeCodeVersion }),
    ...(outputStyle && { outputStyle }),
    ...(subAgentName && { subAgentName }),
  };
  if (prevSessionId && prevOutcome) {
    payload.prevSessionId = prevSessionId;
    payload.prevOutcome = prevOutcome;
    payload.prevErrorType = prevErrorType;
    payload.prevErrorCount = prevErrorCount;
    payload.prevDurationSec = prevDurationSec;
    if (prevActivatedSkills.length > 0) payload.prevActivatedSkills = prevActivatedSkills;
    if (prevToolsUsed.length > 0) payload.prevToolsUsed = prevToolsUsed;
    if (prevSubagentsSpawned > 0) payload.prevSubagentsSpawned = prevSubagentsSpawned;
  }

  // Save current prompt state for next piggyback
  fs.writeFileSync(statePath, JSON.stringify({
    ts: payload.ts,
    sessionId,
    classifiedAs,
    toolsUsed: [],
    subagentsSpawned: 0,
    promptIndex: sessionPromptIndex,
  }));

  // POST to telemetry endpoint (async, 3s timeout, fail-open)
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ghToken}`,
    },
    body: JSON.stringify(payload),
    signal: controller.signal,
  })
    .then(async (res) => {
      if (res.status === 401 || res.status === 403) {
        try { fs.unlinkSync(path.join(telemetryDir, T1K.GH_TOKEN_CACHE)); } catch { /* ok */ }
        warnOnce('auth-failed', 'Telemetry auth failed (HTTP ' + res.status + '): token invalid or not a The1Studio org member. Run: gh auth refresh --scopes read:org,repo,read:packages');
      }
    })
    .catch((err) => {
      warnOnce('network-error', 'Telemetry request failed: ' + (err.name === 'AbortError' ? 'timeout (3s)' : 'network error'));
    })
    .finally(() => { clearTimeout(timeout); process.exit(0); });

  // Don't let the process hang — exit after 4s max
  setTimeout(() => process.exit(0), 4000);
} catch {
  process.exit(0); // Fail-open
}
