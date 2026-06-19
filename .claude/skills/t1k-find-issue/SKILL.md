---
name: t1k:find-issue
description: "Surface high-impact GitHub issues across kit repos ranked by your contribution history. Use for 'find issue', 'what should i work on', 'good first issue'."
keywords: [find issue, what should i work on, easy issue, good first issue, contribute]
effort: low
argument-hint: "[--kit name] [--difficulty easy|medium|hard]"
version: 2.15.1
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# t1k:find-issue — Find High-Impact Issues

Surfaces GitHub issues across tracked T1K repos ranked by potential score × match with your contribution history.

## Usage

```
/t1k:find-issue
/t1k:find-issue --kit theonekit-unity
/t1k:find-issue --difficulty easy
/t1k:find-issue --kit theonekit-core --difficulty medium
```

## Flags

| Flag | Values | Default |
|------|--------|---------|
| `--kit` | any kit name substring | all tracked repos |
| `--difficulty` | `easy`, `medium`, `hard` | all difficulties |

**Difficulty mapping:**
- `easy` → issues with labels `good first issue`, `easy`, `beginner friendly`
- `hard` → issues with labels `help wanted`, `complex`, `hard`
- `medium` → all other issues (default fallback)

## Workflow

### Step 1 — Parse flags

Extract `--kit` and `--difficulty` from the user's command arguments.

### Step 2 — Fetch ranked issues

```bash
TOKEN=$(gh auth token)
PARAMS="user=$(gh api user --jq .login)"
[ -n "$KIT" ]        && PARAMS="${PARAMS}&kit=${KIT}"
[ -n "$DIFFICULTY" ] && PARAMS="${PARAMS}&difficulty=${DIFFICULTY}"

curl -sf -H "Authorization: Bearer $TOKEN" \
  "${T1K_TELEMETRY_ENDPOINT}/api/contributors/find-issue?${PARAMS}"
```

If `T1K_TELEMETRY_ENDPOINT` is not set, output:
```
Error: T1K_TELEMETRY_ENDPOINT is not configured.
Set it via: export T1K_TELEMETRY_ENDPOINT=https://your-worker.workers.dev
```

### Step 2b — Claim filter (prevention-by-omission)

After receiving the ranked list from Step 2, filter out any issue with a live claim before rendering. For each candidate:

```bash
node .claude/scripts/t1k-issue-claim.cjs check <owner/repo#N>
```

| `state` | Disposition |
|---------|-------------|
| `free` or `stale` | Include in recommendations (stale = claim may be abandoned; issue is still actionable) |
| `held` | **Exclude from the recommendations table.** Never surface a live-claimed issue as a pick. |
| `skip` | Exclude (out of scope) |

**Policy:** prevention-by-omission — find-issue never recommends an issue that is actively claimed by another contributor. If excluding claimed issues leaves fewer than 3 results, show whatever remains and note `"N issue(s) excluded — live claims held by other contributors."` Do NOT surface a claimed issue annotated as `[claimed by …]`; exclude it entirely.

**Constraint:** never call `gh issue edit` or any inline `gh` claim mutation here. Read-only `check` only.

### Step 3 — Render issues table

```
## Issues for You to Work On

| # | Repo | Title | Difficulty | Score | Labels |
|---|------|-------|------------|-------|--------|
| 1 | {repo_short} | [{title}]({url}) | {difficulty} | {score} | {labels} |
...
```

Show at most 10 rows. If no issues returned, show:
```
No matching issues found. Try removing --difficulty or --kit filters.
```

### Step 4 — Pick an issue

After rendering the table, ask the user:
> "Want me to open one of these issues in the browser, or start working on a specific one?"

If they say yes / pick a number:
- Open URL: `gh browse {url}` (or just output the URL for them to click)
- Optionally start `/t1k:cook` workflow if they want to begin implementation

## Scoring Formula (reference)

The server ranks by `potential_score × match_weight`:
- `potential_score`: 1–3 based on priority labels + reaction bonus
- `match_weight`: 1.5× if issue repo/body matches user's recent kit history, else 1.0×

## Gotchas

- Requires `gh auth login` for token. Endpoint requires The1Studio org membership.
- GitHub API is queried live; rate limits apply without `GITHUB_TOKEN` on the worker side.
- Issues list refreshes from GitHub on each call (60s cache on the worker).
- PRs are excluded (GitHub issues API returns both; server filters them out).
