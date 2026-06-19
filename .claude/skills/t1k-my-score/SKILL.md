---
name: t1k:my-score
description: "Show your contribution score, rank, and 3 next-action suggestions. Use for 'what's my score', 'my rank', 'how am i doing', 'leaderboard'."
keywords: [my score, my rank, my contributions, leaderboard, how am i doing]
effort: low
argument-hint: "[--user gh-login]"
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# t1k:my-score — Contribution Score & Rank

Shows your weekly/monthly contribution score, rank, recent contributions, and 3 suggested next actions.

## Usage

```
/t1k:my-score
/t1k:my-score --user alice
```

## Workflow

### Step 0 — Flush pending contributions first

Lifetime totals should reflect work done this session. Before fetching, invoke
`t1k:contribution-flush` (fire-and-forget) so any refs the `contribution-capture`
hook tracked but never recorded are AI-scored + POSTed first. Skip silently if it
reports nothing pending or no endpoint — never block the score read on it.

### Step 1 — Resolve user

```bash
# If --user flag provided, use it directly.
# Otherwise resolve from gh CLI:
gh api user --jq .login
```

Store result as `GH_LOGIN`.

### Step 2 — Fetch score data

```bash
TOKEN=$(gh auth token)
curl -sf -H "Authorization: Bearer $TOKEN" \
  "${T1K_TELEMETRY_ENDPOINT}/api/contributors/me?user=${GH_LOGIN}"
```

If `T1K_TELEMETRY_ENDPOINT` is not set, output:
```
Error: T1K_TELEMETRY_ENDPOINT is not configured.
Set it via: export T1K_TELEMETRY_ENDPOINT=https://your-worker.workers.dev
```

If curl fails or returns non-200, output:
```
Could not fetch score for {GH_LOGIN}. Check your GitHub token and org membership.
```

### Step 3 — Render response

Parse the JSON response and render as markdown:

```
## Contribution Score — {user}

| Period  | Score | Rank  |
|---------|-------|-------|
| Weekly  | {weekly_score} | #{weekly_rank ?? 'N/A'} |
| Monthly | {monthly_score} | #{monthly_rank ?? 'N/A'} |

### Recent Contributions (last 5)
| Type | Repo | Date | Score |
...

### Suggested Next Actions
1. {suggestion[0].reason}
2. {suggestion[1].reason}  
3. {suggestion[2].reason}
```

If `recent` is empty, show: "No contributions recorded yet. Start contributing to climb the leaderboard!"

If `suggestions` is empty, show: "Great work — no specific suggestions right now. Keep it up!"

## Notes

- Suggestions are generated server-side from static MVP rules (score vs median, recent activity patterns).
  Future versions will use AI-enriched recommendations.
- Scores update weekly (Mon 01:00 UTC) and monthly (1st 00:00 UTC) via aggregate cron.
- Only The1Studio org members can query this endpoint.

## Gotchas

- `gh auth token` fails if `gh` is not authenticated. Run `gh auth login` first.
- If `weekly_rank` is null, the user has no contributions in the current weekly window.
- The endpoint caches responses for 60s — very recent contributions may not appear immediately.
