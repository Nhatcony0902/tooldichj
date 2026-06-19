#!/usr/bin/env node
// t1k-origin: kit=theonekit-core | repo=The1Studio/theonekit-core | module=null | protected=true
/**
 * t1k-issue-claim.cjs — SSOT for GitHub issue "claim" coordination.
 *
 * Prevents duplicate work on theonekit-* issues. A *claim* is GitHub-native:
 *   - a draft PR that references the issue (body marker `t1k-claim: owner/repo#N`
 *     + the `t1k:claim` label), and
 *   - a self-assign on the issue itself (instant issue-page signal).
 *
 * Every skill (t1k-fix, t1k-triage, t1k-sync-back, t1k-find-issue, t1k-babysit-pr, ...)
 * REASONS over this script's JSON facts and MUST NOT re-implement `gh` claim logic
 * inline (per rules/ai-driven-design.md + rules/issue-claim-discipline.md).
 *
 * I/O contract:
 *   - JSON facts  → stdout (one object, always valid JSON)
 *   - diagnostics → stderr
 *   - exit 0 on skip (out-of-scope repo, missing config, gh not authed) — NEVER
 *     block the caller on a config/infra gap. Exit 1 only on a usage error.
 *
 * Subcommands:
 *   check   <owner/repo#N>            → { state, holder, prNumber, issueRef, assignees, isDraft }
 *   acquire <owner/repo#N> [--steal] [--pr <N>]
 *                                     → pre-PR (no --pr): self-assign + return PR-claim
 *                                       instructions (markerLine/labelToApply/bodyTrailer).
 *                                       post-PR (--pr N): deterministic tie-break — if a
 *                                       lower-numbered claim PR by another user exists,
 *                                       close PR N (mine) and yield.
 *   release <owner/repo#N>            → mark my linked draft PR ready-for-review (release).
 *   steal   <owner/repo#N>            → force-acquire over a live foreign claim (== acquire --steal).
 *
 * state ∈ "free" | "held" | "stale" | "skip"
 *   free  = no live foreign claim (issue is yours to take / already yours)
 *   held  = an open draft/ready claim PR by ANOTHER user references this issue
 *   stale = a draft claim PR exists but has been inactive > stalenessDays (reporting only)
 *   skip  = out-of-scope repo or no issueClaim config (caller proceeds without claim)
 *
 * No TTL / lease timer. Staleness is REPORTING-ONLY (computed at check time for triage);
 * this script NEVER auto-closes a claim on a timer. The only auto-close is the acquire
 * tie-break, which only ever closes the CALLER'S OWN losing PR.
 *
 * ── Upgrade path (YAGNI — NOT implemented) ──────────────────────────────────
 * Draft-PR-as-claim has no atomic compare-and-set: two simultaneous `acquire` calls can
 * both open a draft PR in a sub-second window. Mitigated by the lowest-PR#-wins tie-break
 * (here) + triage/babysit duplicate-PR detection. If real collisions persist, back the
 * claim with a worker-side atomic table on the existing telemetry worker —
 *   issue_claims(repo, issue, user, claimed_at, lease_expires_at, UNIQUE(repo, issue))
 * — behind THIS SAME subcommand interface, so consuming skills never change.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

// ── Output helpers ───────────────────────────────────────────────────────────
function emit(fact) {
  process.stdout.write(JSON.stringify(fact) + '\n');
}
function warn(msg) {
  process.stderr.write(`[t1k:issue-claim] ${msg}\n`);
}
/** Skip = exit 0, never block the caller. */
function skip(reason, extra) {
  emit(Object.assign({ state: 'skip', reason }, extra || {}));
  process.exit(0);
}
/** Usage error = exit 1 (caller passed bad args). */
function usage(msg) {
  warn(msg);
  emit({ state: 'error', reason: msg });
  process.exit(1);
}

// ── Config resolution (same cascade pattern the t1k-contribution-score skill uses) ──
// Order: project ./.claude/t1k-config-core.json → global ~/.claude/t1k-config-core.json.
// Field-level env overrides (T1K_ISSUECLAIM_<FIELD>) overlay on top — proves the cascade.
function loadConfigBlock() {
  const candidates = [
    path.join(process.cwd(), '.claude', 't1k-config-core.json'),
    path.join(os.homedir(), '.claude', 't1k-config-core.json'),
  ];
  for (const file of candidates) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const json = JSON.parse(raw);
      if (json && json.issueClaim && typeof json.issueClaim === 'object') {
        return { block: json.issueClaim, source: file };
      }
    } catch (_) {
      // missing / unreadable / malformed → try next candidate
    }
  }
  return { block: null, source: null };
}

function applyEnvOverrides(block) {
  const cfg = Object.assign({}, block);
  if (process.env.T1K_ISSUECLAIM_LABELNAME) cfg.labelName = process.env.T1K_ISSUECLAIM_LABELNAME;
  if (process.env.T1K_ISSUECLAIM_BODYMARKERPREFIX) cfg.bodyMarkerPrefix = process.env.T1K_ISSUECLAIM_BODYMARKERPREFIX;
  if (process.env.T1K_ISSUECLAIM_ENFORCEMENTMODE) cfg.enforcementMode = process.env.T1K_ISSUECLAIM_ENFORCEMENTMODE;
  if (process.env.T1K_ISSUECLAIM_STALENESSDAYS) {
    const n = parseInt(process.env.T1K_ISSUECLAIM_STALENESSDAYS, 10);
    if (!Number.isNaN(n)) cfg.stalenessDays = n;
  }
  return cfg;
}

// ── Ref parsing + scope ───────────────────────────────────────────────────────
function parseRef(ref) {
  // owner/repo#N
  const m = /^([^/\s]+)\/([^#\s]+)#(\d+)$/.exec((ref || '').trim());
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10), full: `${m[1]}/${m[2]}`, ref: `${m[1]}/${m[2]}#${m[3]}` };
}

function globToRegExp(glob) {
  // very small glob → regex: escape regex specials, then `*` → `.*`
  const escaped = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}$`);
}

function inScope(full, inScopeRepos) {
  if (!Array.isArray(inScopeRepos) || inScopeRepos.length === 0) return true; // no list = all repos
  return inScopeRepos.some((g) => globToRegExp(g).test(full));
}

// ── gh wrappers (built-ins only; errors → stderr, never throw to caller) ──────
function gh(args, opts) {
  try {
    const out = execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...(opts || {}) });
    return { ok: true, out };
  } catch (err) {
    return { ok: false, err, out: (err && err.stdout) || '', stderr: (err && err.stderr) || (err && err.message) || '' };
  }
}

function ghJson(args) {
  const r = gh(args);
  if (!r.ok) return { ok: false, value: null, stderr: r.stderr };
  try {
    return { ok: true, value: JSON.parse(r.out || 'null') };
  } catch (e) {
    return { ok: false, value: null, stderr: `JSON parse failed: ${e.message}` };
  }
}

function currentUser() {
  const r = gh(['api', 'user', '--jq', '.login']);
  if (!r.ok) return null;
  return (r.out || '').trim() || null;
}

// ── Claim discovery ───────────────────────────────────────────────────────────
// A claim PR = an OPEN PR carrying the claim label whose body marker references this issue.
// Returns array sorted ascending by PR number (deterministic tie-break: lowest wins).
function findClaimPRs(parsed, cfg) {
  const repoFlag = parsed.full;
  const markerToken = `${cfg.bodyMarkerPrefix} ${parsed.full}#${parsed.number}`; // "t1k-claim: owner/repo#N"
  // Primary: PRs with the claim label (cheap, label is the canonical signal).
  const labeled = ghJson([
    'pr', 'list', '--repo', repoFlag, '--state', 'open',
    '--label', cfg.labelName,
    '--json', 'number,isDraft,author,body,createdAt,updatedAt,headRefName',
    '--limit', '50',
  ]);
  let prs = labeled.ok && Array.isArray(labeled.value) ? labeled.value : [];
  // A claim PR is identified by the exact body marker for THIS issue. The label scopes the
  // candidate set; the marker disambiguates which issue each labeled PR claims (a labeled PR
  // for a different issue shares the label). Closing-keyword matching is intentionally NOT
  // used — it cross-matches a labeled PR that merely *mentions* "fixes #N" for another issue.
  prs = prs.filter((pr) => (pr.body || '').includes(markerToken));
  prs.sort((a, b) => a.number - b.number);
  return prs;
}

function issueAssignees(parsed) {
  const r = ghJson(['issue', 'view', String(parsed.number), '--repo', parsed.full, '--json', 'assignees,state']);
  if (!r.ok || !r.value) return { assignees: [], issueState: null };
  return {
    assignees: (r.value.assignees || []).map((a) => a.login),
    issueState: r.value.state || null,
  };
}

function daysSince(iso) {
  if (!iso) return Infinity;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return Infinity;
  return (Date.now() - then) / 86400000;
}

// ── Core: compute claim state ─────────────────────────────────────────────────
function computeState(parsed, cfg, me) {
  const prs = findClaimPRs(parsed, cfg);
  const { assignees } = issueAssignees(parsed);
  if (prs.length === 0) {
    // No claim PR. If the issue is assigned to someone else, treat as a soft signal but
    // not a hard claim (assignee alone is the pre-PR stage; only foreign assignee blocks).
    const foreignAssignee = assignees.find((a) => a && a !== me);
    if (foreignAssignee && me) {
      return { state: 'held', holder: foreignAssignee, prNumber: null, assignees, isDraft: null, viaAssignee: true };
    }
    return { state: 'free', holder: null, prNumber: null, assignees, isDraft: null };
  }
  // Lowest-numbered claim PR is authoritative.
  const primary = prs[0];
  const holder = primary.author && primary.author.login ? primary.author.login : null;
  const isMine = me && holder === me;
  const stale = primary.isDraft && daysSince(primary.updatedAt) > Number(cfg.stalenessDays || 14);
  let state;
  if (isMine) state = 'free';            // I already hold it → caller may proceed
  else if (stale) state = 'stale';        // abandoned draft (reporting only)
  else state = 'held';                    // live foreign claim
  return {
    state,
    holder,
    prNumber: primary.number,
    issueRef: parsed.ref,
    assignees,
    isDraft: !!primary.isDraft,
    competingPRs: prs.length > 1 ? prs.map((p) => p.number) : undefined,
  };
}

// ── Subcommands ────────────────────────────────────────────────────────────────
function cmdCheck(parsed, cfg) {
  const me = currentUser();
  if (!me) { warn('gh not authed (gh api user failed) — proceeding without claim'); skip('gh-unauthed', { issueRef: parsed.ref }); }
  const result = computeState(parsed, cfg, me);
  result.issueRef = parsed.ref;
  result.me = me;
  emit(result);
  process.exit(0);
}

function cmdAcquire(parsed, cfg, flags) {
  const me = currentUser();
  if (!me) skip('gh-unauthed', { acquired: false, issueRef: parsed.ref });

  // ── post-PR tie-break mode (--pr N) ──────────────────────────────────────
  if (flags.pr != null) {
    const myPr = flags.pr;
    const prs = findClaimPRs(parsed, cfg);
    const lowest = prs.length ? prs[0] : null;
    if (lowest && lowest.number < myPr) {
      const lowestHolder = lowest.author && lowest.author.login ? lowest.author.login : null;
      if (lowestHolder && lowestHolder !== me) {
        // I lost the race — close my own PR and yield (only ever closes MY pr).
        gh(['pr', 'close', String(myPr), '--repo', parsed.full,
          '--comment', `Yielding to earlier claim #${lowest.number} (t1k-issue-claim tie-break: lowest PR# wins).`]);
        emit({ state: 'held', holder: lowestHolder, prNumber: lowest.number, yielded: true, closedPr: myPr, issueRef: parsed.ref });
        process.exit(0);
      }
    }
    emit({ state: 'free', acquired: true, prNumber: myPr, issueRef: parsed.ref, me });
    process.exit(0);
  }

  // ── pre-PR acquire ────────────────────────────────────────────────────────
  const result = computeState(parsed, cfg, me);
  const foreignLive = result.state === 'held';
  const mode = cfg.enforcementMode || 'hard-block';
  if (foreignLive && !flags.steal && mode === 'hard-block') {
    // Hard block — caller surfaces holder + PR# and re-runs with --steal.
    emit({ state: 'held', acquired: false, holder: result.holder, prNumber: result.prNumber,
      enforcementMode: mode, issueRef: parsed.ref,
      hint: 'blocked: live foreign claim — re-run with --steal to override' });
    process.exit(0);
  }
  // enforcementMode "warn" (non-default): a live foreign claim does NOT hard-block — it is
  // surfaced as advisory and the caller proceeds to acquire (the caller decides what to do).
  const advisory = foreignLive && !flags.steal && mode !== 'hard-block';
  if (foreignLive && flags.steal) {
    // Steal: comment on the existing claim PR, then take the issue assignee.
    if (result.prNumber) {
      gh(['pr', 'comment', String(result.prNumber), '--repo', parsed.full,
        '--body', `Claim stolen by @${me} (t1k-issue-claim --steal). Reassigning the issue.`]);
    }
  }
  // Self-assign the issue (instant issue-page signal). gh supports the @me alias.
  const assign = gh(['issue', 'edit', String(parsed.number), '--repo', parsed.full, '--add-assignee', '@me']);
  if (!assign.ok) warn(`self-assign failed: ${assign.stderr.trim()}`);
  emit({
    state: 'free',
    acquired: true,
    issueRef: parsed.ref,
    assignee: me,
    enforcementMode: mode,
    advisory: advisory ? { warnHolder: result.holder, warnPr: result.prNumber } : undefined,
    stole: !!(foreignLive && flags.steal),
    // Instructions the caller bakes into the draft PR it opens (the durable claim):
    markerLine: `${cfg.bodyMarkerPrefix} ${parsed.full}#${parsed.number}`,
    bodyTrailer: `Fixes #${parsed.number}`,
    labelToApply: cfg.labelName,
    note: 'Open a DRAFT PR carrying markerLine + bodyTrailer + labelToApply; then call `acquire <ref> --pr <newPrNumber>` for the tie-break re-check.',
  });
  process.exit(0);
}

function cmdRelease(parsed, cfg) {
  const me = currentUser();
  if (!me) skip('gh-unauthed', { released: false, issueRef: parsed.ref });
  const prs = findClaimPRs(parsed, cfg).filter((p) => p.author && p.author.login === me);
  const mine = prs.find((p) => p.isDraft) || prs[0];
  if (!mine) {
    emit({ released: true, prNumber: null, note: 'no open claim PR by me (already merged/closed → released via GitHub state)', issueRef: parsed.ref });
    process.exit(0);
  }
  if (mine.isDraft) {
    const r = gh(['pr', 'ready', String(mine.number), '--repo', parsed.full]);
    if (!r.ok) warn(`gh pr ready failed: ${r.stderr.trim()}`);
  }
  emit({ released: true, prNumber: mine.number, markedReady: !!mine.isDraft, issueRef: parsed.ref });
  process.exit(0);
}

// ── Entry ──────────────────────────────────────────────────────────────────────
function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || ['-h', '--help', 'help'].includes(cmd)) {
    usage('usage: t1k-issue-claim.cjs <check|acquire|release|steal> <owner/repo#N> [--steal] [--pr <N>]');
  }
  const ref = argv[1];
  const parsed = parseRef(ref);
  if (!parsed) usage(`invalid issue ref "${ref}" — expected owner/repo#N`);

  // flags
  const flags = { steal: false, pr: null };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--steal') flags.steal = true;
    else if (argv[i] === '--pr') { const n = parseInt(argv[++i], 10); if (!Number.isNaN(n)) flags.pr = n; }
  }

  const { block, source } = loadConfigBlock();
  if (!block) skip('no-config', { issueRef: parsed.ref, hint: 'no issueClaim block in t1k-config-core.json' });
  const cfg = applyEnvOverrides(block);
  if (!cfg.labelName || !cfg.bodyMarkerPrefix) skip('incomplete-config', { issueRef: parsed.ref, source });
  if (!inScope(parsed.full, cfg.inScopeRepos)) skip('out-of-scope', { issueRef: parsed.ref, full: parsed.full });

  switch (cmd) {
    case 'check': return cmdCheck(parsed, cfg);
    case 'acquire': return cmdAcquire(parsed, cfg, flags);
    case 'release': return cmdRelease(parsed, cfg);
    case 'steal': flags.steal = true; return cmdAcquire(parsed, cfg, flags);
    default: usage(`unknown subcommand "${cmd}"`);
  }
}

main();
