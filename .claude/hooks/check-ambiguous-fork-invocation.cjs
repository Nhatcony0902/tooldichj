#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// check-ambiguous-fork-invocation.cjs — UserPromptSubmit hook
//
// Purpose:
//   Detect /t1k:* slash-command invocations that target forked-context skills
//   AND contain ambiguous reference words (e.g. "above", "plan B", "that one").
//   Forked skills run in a fresh subagent with ZERO prior conversation history,
//   so unresolved references cause the receiver to either say "I don't see X"
//   (round-trip waste) or hallucinate (silent wrong output). This hook nudges
//   Claude to RESOLVE the references first — via the t1k:resolve-context skill
//   or by manually constructing a Fork Context Brief per rules/fork-context-brief.md.
//
// Trigger:
//   UserPromptSubmit — runs on every user prompt before the model sees it.
//
// Output:
//   - If forked-skill invocation AND ambiguity match AND no explicit path arg
//     → emit [t1k:fork-brief-reminder] + [t1k:fork-brief-candidates] block to
//     stdout (the harness surfaces stdout from UserPromptSubmit hooks as
//     system-reminder text). The candidates block contains pre-extracted
//     Tier-2 facts (recent plans + reports from filesystem, capped at top 5/3
//     by HANDOFF.md / plan.md mtime DESC). Hook performs NO git shell-out and
//     does NOT touch transcript / memory — those tiers require AI judgment
//     and stay in t1k:resolve-context.
//   - Otherwise → silent (no stdout).
//
// Fail-open behavior (per rules/security.md):
//   - Any internal exception is swallowed; log to stderr and exit 0.
//   - This hook NEVER blocks the prompt (never returns exit code 2).
//     It is RESOLUTIVE (nudges Claude to resolve) not INTERROGATIVE (does not ask).
//
// Related:
//   - rules/fork-context-brief.md — the FCB protocol this hook enforces
//   - skills/t1k-resolve-context/SKILL.md — helper skill for senders
//
// Self-tests (verbatim expected behavior):
//   echo '{"prompt":"/t1k:team review plan B above","cwd":"/tmp"}'           → emits reminder (+ candidates if cwd has plans/)
//   echo '{"prompt":"/t1k:team plans/x/plan.md phase 2"}'                     → silent (explicit path suppresses ORDINAL_PATTERNS)
//   echo '{"prompt":"/t1k:team plans/x/plan.md above"}'                       → reminder (AMBIGUITY_PATTERNS fire regardless of path — "above" is conversation-dependent)
//   echo '{"prompt":"/t1k:cook plans/260523-1224-x/","cwd":"/tmp"}'           → silent (path arg + no ambiguity word)
//   echo '{"prompt":"what time is it","cwd":"/tmp"}'                          → silent (no slash command)
//   echo '{"prompt":"/t1k:fix bug above"}'                                    → silent (t1k:fix is not context:fork)
//   echo '{"prompt":"/t1k:cook the plan above","cwd":"<repo with plans/>"}'   → emits reminder + candidates block (Tier-2 facts)
'use strict';

try {
  const fs = require('fs');
  const path = require('path');

  // ---------------------------------------------------------------------------
  // Discover forked-context skills at hook startup by scanning the kit's
  // skills directory for `context: fork` in SKILL.md frontmatter. Per
  // ~/.claude/rules/code-conventions.md "Data-Driven Over Hardcoded" — the
  // allowlist is the ground truth, not a duplicated literal.
  //
  // Search order (first hit wins): $CLAUDE_PROJECT_DIR/.claude/skills, then
  // $HOME/.claude/skills (global), then bail with empty set.
  // Scan completes in <15ms on ~60 skills (synchronous readdir is fine).
  // ---------------------------------------------------------------------------
  function discoverForkedSkills() {
    const candidates = [
      process.env.CLAUDE_PROJECT_DIR ? path.join(process.env.CLAUDE_PROJECT_DIR, '.claude', 'skills') : null,
      process.env.HOME ? path.join(process.env.HOME, '.claude', 'skills') : null,
    ].filter(Boolean);
    const found = new Set();
    for (const root of candidates) {
      if (!fs.existsSync(root)) continue;
      let entries;
      try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        const skillFile = path.join(root, e.name, 'SKILL.md');
        if (!fs.existsSync(skillFile)) continue;
        let head;
        try { head = fs.readFileSync(skillFile, 'utf-8').slice(0, 1500); } catch { continue; }
        // Frontmatter only (between leading `---` markers); skip body
        const fmEnd = head.indexOf('\n---', 3);
        const fm = fmEnd > 0 ? head.slice(0, fmEnd) : head;
        if (!/^\s*context:\s*fork\s*$/m.test(fm)) continue;
        const nameMatch = fm.match(/^\s*name:\s*([t1k][^\s]+)/m);
        if (nameMatch) found.add(nameMatch[1].toLowerCase());
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------------
  // Tier-2 fact extraction — deterministic filesystem scan, no shell-out.
  // Per ~/.claude/rules/ai-driven-design.md: hooks emit FACTS, AI does
  // SYNTHESIS. The recent-plans + recent-reports lists give Claude concrete
  // starting points for Brief construction without a second tool call for
  // simple cases. Deeper tiers (git log, transcript, MEMORY.md) stay in
  // t1k:resolve-context where AI can reason over them.
  //
  // Caps: top 5 plan dirs + top 3 reports. Each readdir is wrapped in
  // try/catch (filesystem can race during writes). Total wall-clock <50ms
  // on typical repos (~30 plan dirs).
  // ---------------------------------------------------------------------------
  function humanizeAge(ms) {
    const mins = Math.round(ms / 60000);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.round(mins / 60);
    if (hours < 48) return `${hours}h ago`;
    return `${Math.round(hours / 24)}d ago`;
  }

  function extractTier2Facts(cwd) {
    const facts = { recent_plans: [], recent_reports: [] };
    if (!cwd || typeof cwd !== 'string') return facts;

    const plansDir = path.join(cwd, 'plans');
    try {
      if (fs.existsSync(plansDir) && fs.statSync(plansDir).isDirectory()) {
        const candidates = [];
        for (const e of fs.readdirSync(plansDir, { withFileTypes: true })) {
          if (!e.isDirectory()) continue;
          const dir = path.join(plansDir, e.name);
          const planMd = path.join(dir, 'plan.md');
          if (!fs.existsSync(planMd)) continue;
          const handoffMd = path.join(dir, 'HANDOFF.md');
          let mtime;
          try {
            mtime = fs.existsSync(handoffMd)
              ? fs.statSync(handoffMd).mtimeMs
              : fs.statSync(planMd).mtimeMs;
          } catch { continue; }
          candidates.push({ name: e.name, mtime });
        }
        candidates.sort((a, b) => b.mtime - a.mtime);
        facts.recent_plans = candidates.slice(0, 5).map((c) => ({
          name: c.name,
          age: humanizeAge(Date.now() - c.mtime),
        }));
      }
    } catch { /* fail-open: missing plans/ is normal */ }

    const reportsDir = path.join(cwd, 'plans', 'reports');
    try {
      if (fs.existsSync(reportsDir) && fs.statSync(reportsDir).isDirectory()) {
        const files = [];
        for (const e of fs.readdirSync(reportsDir, { withFileTypes: true })) {
          if (!e.isFile() || !e.name.endsWith('.md')) continue;
          let mtime;
          try { mtime = fs.statSync(path.join(reportsDir, e.name)).mtimeMs; } catch { continue; }
          files.push({ name: e.name, mtime });
        }
        files.sort((a, b) => b.mtime - a.mtime);
        facts.recent_reports = files.slice(0, 3).map((f) => ({
          name: f.name,
          age: humanizeAge(Date.now() - f.mtime),
        }));
      }
    } catch { /* fail-open */ }

    return facts;
  }

  // ---------------------------------------------------------------------------
  // emitBriefStats — fires when an incoming FCB block is detected in the
  // prompt. Instead of bailing silently, emit a one-line stats marker so
  // the telemetry pipeline can measure Brief-consumption coverage and
  // estimate tokens saved per field (avoids re-investigation round trips).
  //
  // Field-presence test: look for `field:\n  <non-empty content>` at start of
  // line (YAML-style multiline value). Single-line values like `field: val`
  // are NOT counted because they may be placeholders. This is intentionally
  // conservative — false negatives are acceptable; false positives are not.
  //
  // PER_OP_EST is a rough token estimate per field. Values are intentionally
  // round numbers — precision here adds no value; order-of-magnitude does.
  // ---------------------------------------------------------------------------
  function emitBriefStats(briefBody, command) {
    const fieldsPresent = [];
    const PER_OP_EST = {
      user_decisions: 500,        // avoided AskUserQuestion
      investigation_state: 3000,  // avoided full re-investigation
      tool_inventory: 1500,       // avoided ToolSearch + metadata re-read + MCP discovery
      artifacts: 2000,            // avoided fuzzy plan resolution
    };
    let estTokensSaved = 0;
    for (const field of Object.keys(PER_OP_EST)) {
      // Field present if it has a colon at start-of-line and is followed by non-empty content
      const re = new RegExp(`^${field}:\\s*\\n(?:\\s+\\S)`, 'm');
      if (re.test(briefBody)) {
        fieldsPresent.push(field);
        estTokensSaved += PER_OP_EST[field];
      }
    }
    if (fieldsPresent.length === 0) return; // empty Brief → no stats
    const line = `[t1k:fork-brief-stats] fork=${command} fields_present=[${fieldsPresent.join(',')}] est_tokens_saved=${estTokensSaved}`;
    console.log(line);
  }

  // ---------------------------------------------------------------------------
  // extractToolInventory — deterministic filesystem reads, no shell-out.
  // Provides pre-extracted Tier-2 context (installed modules, MCP servers,
  // current git branch) so the receiver's Brief can include tool_inventory
  // without a second ToolSearch or metadata-read round-trip.
  //
  // All reads are best-effort (try/catch each). Returns empty arrays / null
  // for any field that is unavailable. Total wall-clock target: <30ms.
  // session_age_min is always null here — only the sender skill knows the
  // session start time; receiver should populate or leave absent.
  // ---------------------------------------------------------------------------
  function extractToolInventory(cwd) {
    const inv = { installed_modules: [], mcp_available: [], git_branch: null, cwd, session_age_min: null };
    if (!cwd || typeof cwd !== 'string') return inv;

    // installed_modules: .claude/metadata.json → data.installedModules[]
    try {
      const metaPath = path.join(cwd, '.claude', 'metadata.json');
      const metaRaw = fs.readFileSync(metaPath, 'utf-8');
      const meta = JSON.parse(metaRaw);
      if (Array.isArray(meta.installedModules)) {
        inv.installed_modules = meta.installedModules;
      }
    } catch { /* fail-open */ }

    // mcp_available: .claude/settings.json → Object.keys(data.mcpServers || {})
    try {
      const settingsPath = path.join(cwd, '.claude', 'settings.json');
      const settingsRaw = fs.readFileSync(settingsPath, 'utf-8');
      const settings = JSON.parse(settingsRaw);
      inv.mcp_available = Object.keys(settings.mcpServers || {});
    } catch { /* fail-open */ }

    // git_branch: .git/HEAD → ref: refs/heads/<branch>
    try {
      const headPath = path.join(cwd, '.git', 'HEAD');
      const headContent = fs.readFileSync(headPath, 'utf-8').trim();
      const branchMatch = headContent.match(/^ref: refs\/heads\/(.+)$/);
      if (branchMatch) inv.git_branch = branchMatch[1];
    } catch { /* fail-open */ }

    return inv;
  }

  // ---------------------------------------------------------------------------
  // Ambiguity patterns — case-insensitive. Each pattern is anchored on word
  // boundaries to limit false positives (e.g. "above" but not "aboveboard").
  // ---------------------------------------------------------------------------
  const AMBIGUITY_PATTERNS = [
    /\babove\b/i,
    /\bbelow\b/i,
    /\bprevious\b/i,
    /\bthe one\b/i,
    /\bthat (plan|report|file|idea|approach|option|fix|bug|change)\b/i,
    /\bplan [a-z](?![a-z])/i,
    /\bas (we|i) (discussed|said|agreed)\b/i,
    /\bjust (made|created|wrote|drafted)\b/i,
    /\bwe (just|already)\b/i,
  ];
  // Patterns that are AMBIGUOUS only without a path arg (ordinal phrases).
  // We keep these separate so the path-suppression logic stays explicit.
  const ORDINAL_PATTERNS = [
    /\boption [0-9]+\b/i,
    /\bround [0-9]+\b/i,
    /\bphase [0-9]+\b/i,
    /\blast\b/i,
  ];

  // ---------------------------------------------------------------------------
  // Counter-pattern: does the prompt include an EXPLICIT artifact reference?
  // If yes, suppress the reminder — the user already gave grounding.
  //  - file path (relative or absolute)
  //  - markdown / json / cjs / ts / py / sh file extension
  //  - explicit flag args like --file or --plan
  //  - URL
  // ---------------------------------------------------------------------------
  function hasExplicitPath(text) {
    return (
      /\b(?:\.{1,2}\/|\/)?[A-Za-z0-9_.-]*\/[A-Za-z0-9._\/-]+/.test(text) || // a/b/c path
      /\b[\w-]+\.(md|json|cjs|ts|tsx|js|jsx|py|sh|yml|yaml|toml)\b/i.test(text) || // file.ext
      /--(file|plan|path|dir|report|spec)[=\s]/i.test(text) || // --flag
      /https?:\/\/\S+/i.test(text) // url
    );
  }

  // ---------------------------------------------------------------------------
  // Read stdin JSON: { prompt, session_id, transcript_path, cwd, ... }
  // ---------------------------------------------------------------------------
  let payload = {};
  try {
    const raw = fs.readFileSync(0, 'utf-8');
    if (raw && raw.trim()) payload = JSON.parse(raw);
  } catch {
    process.exit(0); // unreadable stdin → silent
  }

  const prompt = typeof payload.prompt === 'string' ? payload.prompt.trim() : '';
  if (!prompt) process.exit(0);

  // ---------------------------------------------------------------------------
  // Detect forked-skill invocation. Must START with /t1k:<name>.
  // ---------------------------------------------------------------------------
  const slashMatch = prompt.match(/^\/(t1k:[a-z0-9-]+)(?:\s|$)/i);
  if (!slashMatch) process.exit(0);
  const command = slashMatch[1].toLowerCase();
  const forked = discoverForkedSkills();
  if (forked.size === 0 || !forked.has(command)) process.exit(0);

  // ---------------------------------------------------------------------------
  // If prompt contains a Fork Context Brief, emit stats then exit.
  // Brief present = sender already grounded the receiver; no reminder needed.
  // Instead of silently bailing, emit [t1k:fork-brief-stats] so the
  // telemetry pipeline can track Brief-consumption coverage over time.
  // ---------------------------------------------------------------------------
  const briefMatch = prompt.match(/=== FORK CONTEXT BRIEF ===([\s\S]*?)=== END BRIEF ===/);
  if (briefMatch) {
    // Brief present → emit stats (no reminder needed, sender already grounded)
    emitBriefStats(briefMatch[1], command);
    process.exit(0);
  }

  // ---------------------------------------------------------------------------
  // Skip if the user supplied an explicit artifact reference (path / file).
  // ORDINAL_PATTERNS only apply when no path is present (phase 2 + plans/x/
  // means the path disambiguates).
  // ---------------------------------------------------------------------------
  const explicitPath = hasExplicitPath(prompt);

  const matches = [];
  for (const pat of AMBIGUITY_PATTERNS) {
    const m = prompt.match(pat);
    if (m && !matches.includes(m[0].toLowerCase())) {
      matches.push(m[0].toLowerCase());
      if (matches.length >= 3) break;
    }
  }
  if (!explicitPath) {
    for (const pat of ORDINAL_PATTERNS) {
      if (matches.length >= 3) break;
      const m = prompt.match(pat);
      if (m && !matches.includes(m[0].toLowerCase())) matches.push(m[0].toLowerCase());
    }
  }
  if (matches.length === 0) process.exit(0);
  if (explicitPath && matches.length === 0) process.exit(0);

  // ---------------------------------------------------------------------------
  // Emit reminder + Tier-2 candidates block. Multi-line so Claude can use the
  // pre-extracted facts directly in a Brief without a second tool call.
  // ---------------------------------------------------------------------------
  const quoted = matches.map((s) => `"${s}"`).join(', ');
  const lines = [
    `[t1k:fork-brief-reminder] /${command} invocation contains ambiguous references (${quoted}). ` +
      `Forked skills cannot see prior conversation. BEFORE invoking, construct a Fork Context Brief ` +
      `per rules/fork-context-brief.md Rule 1. Resolutive over interrogative — do not pass the prompt through as-is.`,
  ];

  const cwdForFacts = typeof payload.cwd === 'string' ? payload.cwd : process.env.CLAUDE_PROJECT_DIR || '';
  const facts = extractTier2Facts(cwdForFacts);
  if (facts.recent_plans.length > 0 || facts.recent_reports.length > 0) {
    lines.push(
      `[t1k:fork-brief-candidates] Pre-extracted Tier-2 facts (filesystem only). ` +
        `If the ambiguous reference matches one of these, cite it as an absolute path in the Brief's artifacts: section. ` +
        `For Tier-3+ (transcript / git / MEMORY.md) call t1k:resolve-context.`,
    );
    if (facts.recent_plans.length > 0) {
      lines.push('  recent_plans (newest first):');
      for (const p of facts.recent_plans) {
        lines.push(`    - plans/${p.name} (${p.age})`);
      }
    }
    if (facts.recent_reports.length > 0) {
      lines.push('  recent_reports (newest first):');
      for (const r of facts.recent_reports) {
        lines.push(`    - plans/reports/${r.name} (${r.age})`);
      }
    }
  }
  // ---------------------------------------------------------------------------
  // Tool-inventory block (Phase 1) — emit pre-extracted filesystem facts so
  // the Brief author can include a tool_inventory: section without extra tool
  // calls. Emitted only when at least one useful field is non-empty.
  // ---------------------------------------------------------------------------
  const inventory = extractToolInventory(cwdForFacts);
  if (inventory.installed_modules.length > 0 || inventory.mcp_available.length > 0 || inventory.git_branch) {
    lines.push(
      `[t1k:fork-tool-inventory] Pre-extracted Tier-2 facts (filesystem only). ` +
        `If the receiver needs to discover tools/modules/MCPs/branch, these are authoritative for this invocation. ` +
        `Re-verify only if session_age_min > 30 (sender-populated; absent here means receiver decides).`,
    );
    if (inventory.installed_modules.length > 0) {
      lines.push(`  installed_modules: [${inventory.installed_modules.join(', ')}]`);
    }
    if (inventory.mcp_available.length > 0) {
      lines.push(`  mcp_available: [${inventory.mcp_available.join(', ')}]`);
    }
    if (inventory.git_branch) {
      lines.push(`  git_branch: ${inventory.git_branch}`);
    }
    lines.push(`  cwd: ${inventory.cwd}`);
  }

  console.log(lines.join('\n'));
  process.exit(0);
} catch (e) {
  try { process.stderr.write(`[check-ambiguous-fork-invocation] crash: ${e && e.message ? e.message : e}\n`); } catch { /* ok */ }
  process.exit(0); // fail-open
}
