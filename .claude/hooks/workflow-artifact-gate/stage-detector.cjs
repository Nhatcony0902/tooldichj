// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
// `pr` removed from HARD_PROMPT vs CK — handled separately with verb-context
// requirement to avoid the noun-form false positive ("this PR looks good").
//
// ASYMMETRY (issue #324 item 5): `release` is included here (PROMPT detection)
// but intentionally has NO matching pattern in detectCommandStage() below.
// Rationale: as a PROMPT verb ("let's release v2"), `release` is reliably a
// hard-stage intent; as a COMMAND token it appears in too many benign contexts
// (`gh release list`, `git tag release-v1`, jq queries) for a bare-word regex
// to be safe. Real release commands are caught via `gh release create` (line 73)
// and `npm/pnpm/yarn publish` (line 76). `ship` shows the same asymmetry: hard
// prompt verb, never a standalone command token.
const HARD_PROMPT = ['ship', 'push', 'deploy', 'publish', 'release'];
const SOFT_PROMPT = ['finalize', 'commit'];
// PR requires explicit action verb context to be treated as a hard-stage intent.
const PR_VERB = /\b(?:open|create|merge|ready|raise|submit|land|file)\s+(?:a\s+|the\s+)?(?:pr|pull request)\b/i;

// ReDoS guard (#323) — cap on the input length user-supplied commandPatterns are
// tested against. Backtracking blow-up is a function of input length; bounding it
// keeps even a missed-risky pattern from hanging the process for tens of seconds.
const REDOS_INPUT_CAP = 2000;

// Static detector for the dominant ReDoS class: a quantified group whose content
// ALSO contains a quantifier (nested quantifier) — e.g. `(a+)+`, `(a*)*`,
// `([a-z]+)*`, `(\d+){2,}`, `(.+)+?`. These cause catastrophic backtracking that
// `new RegExp(...)` compiles fine and `try/catch` never sees (it's a match-time
// hang, not a SyntaxError). Built-in patterns are trusted; only user-supplied
// `commandPatterns` from kit config are screened. Conservative — requires a
// quantifier BOTH inside and after the group, so plain `(deploy|ship)` /
// `(gh release)` extension patterns are unaffected.
const NESTED_QUANTIFIER_RE = /\([^()]*[*+}][^()]*\)\??[*+{]/;
function isReDoSRisky(pattern) {
  return NESTED_QUANTIFIER_RE.test(pattern);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasVerb(text, verbs) {
  const joined = verbs.map(escapeRegex).join('|');
  // Negation window extended from {0,2} to {0,4} vs CK upstream — natural
  // English often has 3-4 words between negation and verb (e.g. "don't please
  // note that push is blocked" should NOT trigger the gate).
  const negated = new RegExp(`\\b(?:do not|don'?t|never|not)\\s+(?:\\w+\\s+){0,4}(?:${joined})\\b`, 'i');
  if (negated.test(text)) return false;
  return new RegExp(`\\b(?:${joined})\\b`, 'i').test(text);
}

// Mirrors hasVerb's negation guard for the PR_VERB early-return path.
// Without this, "don't merge the PR" would trigger as stage 'pr' because
// PR_VERB regex has no negation awareness on its own.
const PR_NEGATED = /\b(?:do not|don'?t|never|not)\s+(?:\w+\s+){0,4}(?:open|create|merge|ready|raise|submit|land|file)\s+(?:a\s+|the\s+)?(?:pr|pull request)\b/i;

function detectPromptStage(prompt) {
  const text = String(prompt || '');
  if (!text.trim()) return null;
  // PR with explicit action verb takes priority — "create a PR" / "land the pull request".
  // Negation guard mirrors hasVerb's protection so "don't merge the PR" doesn't trigger.
  if (PR_VERB.test(text) && !PR_NEGATED.test(text)) return 'pr';
  if (hasVerb(text, HARD_PROMPT)) {
    if (/\bpush\b/i.test(text)) return 'push';
    if (/\bdeploy|publish\b/i.test(text)) return 'deploy';
    return 'ship';
  }
  if (hasVerb(text, SOFT_PROMPT)) {
    if (/\bcommit\b/i.test(text)) return 'commit';
    return 'finalize';
  }
  return null;
}

function stripQuotedStrings(text) {
  // Strip single-quoted strings and double-quoted strings so command-pattern
  // matchers below don't trigger on STRINGS inside echo/printf/jq/grep args.
  // Example: `echo "git push origin main"` should NOT be detected as a push.
  // Caveat: this is a simple lexer, not a full shell parser — nested escapes
  // and heredocs may slip through. Acceptable for a gate that fails-open on
  // crash and is a defence-in-depth layer (the real protection is artifact
  // existence + validation, not command-string heuristics).
  return text
    .replace(/'[^']*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""');
}

function detectCommandStage(command, extraPatterns = []) {
  const raw = String(command || '').trim();
  if (!raw) return null;
  const text = stripQuotedStrings(raw);
  // `(?:\.exe)?` added vs CK to handle Windows where `git.exe push` is common.
  // Caveat: full-path quoted invocations like `"C:\Program Files\Git\cmd\git.exe" push`
  // are stripped by stripQuotedStrings and slip through — acceptable for a
  // defence-in-depth gate (the real protection is artifact validation, not
  // command-string heuristics).
  const git = String.raw`\bgit(?:\.exe)?(?:\s+(?:-[A-Za-z](?:\s+\S+)?|--git-dir=\S+|--work-tree=\S+))*\s+`;
  if (new RegExp(`${git}commit\\b`, 'i').test(text)) return 'commit';
  if (new RegExp(`${git}push\\b`, 'i').test(text)) return 'push';
  // `gh pr edit --ready` transitions draft to ready (functionally same as `gh pr ready`).
  if (/\bgh\s+pr\s+(?:create|merge|ready|edit)\b/i.test(text)) return 'pr';
  if (/\bgh\s+release\s+create\b/i.test(text)) return 'ship';
  if (/\bwrangler\s+(?:pages\s+)?deploy\b/i.test(text)) return 'deploy';
  if (/\b(?:vercel|netlify|firebase|fly|railway)\s+(?:deploy|up)\b/i.test(text)) return 'deploy';
  if (/\b(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:deploy|publish)\b/i.test(text)) return 'deploy';

  // Extension point — engine kits add patterns via `t1k-config-{kit}.json`
  // `workflowArtifactGate.commandPatterns: [{stage: "deploy", pattern: "regex"}]`.
  // Patterns evaluated AFTER built-in ones (defence in depth via union, not override).
  // Malformed regex is silently ignored — never crash the gate on user config.
  //
  // ReDoS guard (#323): `try/catch` only catches compile-time SyntaxError, NOT
  // catastrophic backtracking at match time (e.g. `(a+)+z` hangs the process for
  // tens of seconds). Two layers: (1) reject patterns with nested/overlapping
  // quantifiers at use-time with a surfaced warning (errors over silent hangs);
  // (2) cap the matched input so even a missed-risky pattern can't backtrack
  // catastrophically on a long command.
  const reDoSText = text.length > REDOS_INPUT_CAP ? text.slice(0, REDOS_INPUT_CAP) : text;
  for (const entry of extraPatterns) {
    if (!entry || typeof entry.pattern !== 'string' || typeof entry.stage !== 'string') continue;
    if (isReDoSRisky(entry.pattern)) {
      // Surface, don't silently skip — a hanging gate is worse than a loud reject.
      process.stderr.write(
        `[workflow-artifact-gate] skipping ReDoS-risky commandPattern (nested/overlapping quantifier): ${entry.pattern}\n`,
      );
      continue;
    }
    try {
      if (new RegExp(entry.pattern, 'i').test(reDoSText)) return entry.stage;
    } catch { /* ignore malformed user regex */ }
  }

  // NOTE: removed CK's `/\b(?:ship|release)\b/` fallback — it false-positives
  // on bare-word "ship" anywhere in the command. The specific patterns above
  // (plus extraPatterns for engine kits) cover real ship/deploy actions.
  return null;
}

function detectStage(payload = {}, config = {}) {
  if (payload.stage) return String(payload.stage);

  // Scope by event: for tool events (PreToolUse:Bash etc.), inspect the
  // ACTUAL command being run — never the unrelated user prompt that may
  // be carried in payload context. Mixing these triggers false positives
  // (e.g. user said "ship later" and an innocent `ls` Bash blocks).
  if (payload.tool_name === 'Bash' || payload.tool_input?.command) {
    return detectCommandStage(payload.tool_input?.command, config.commandPatterns);
  }

  // For prompt events (UserPromptSubmit) — explicit event match only.
  // Dropped CK's `!payload.tool_name` fallback (too broad — any payload
  // missing tool_name would scan prompts inappropriately).
  if (payload.hook_event_name === 'UserPromptSubmit') {
    const prompt = payload.prompt || payload.user_prompt;
    const promptStage = detectPromptStage(prompt);
    if (promptStage) return promptStage;
  }

  return null;
}

function isHardStage(stage, config = {}) {
  const hard = config.hardStages || ['ship', 'push', 'pr', 'deploy'];
  return hard.includes(stage);
}

function isSoftStage(stage, config = {}) {
  const soft = config.softStages || ['finalize', 'commit'];
  return soft.includes(stage);
}

module.exports = { detectStage, detectPromptStage, detectCommandStage, isHardStage, isSoftStage, isReDoSRisky };
