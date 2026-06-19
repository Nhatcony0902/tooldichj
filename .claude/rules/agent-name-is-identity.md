---

origin: theonekit-core
repository: The1Studio/theonekit-core
module: null
protected: true
---
# Sub-agent Spawn Name Is Identity, Not Task

When spawning a sub-agent (`Agent` / `TeamCreate`), the `name:` / `subagent_type` field is the agent's **IDENTITY** — the canonical agent type, NOT a description of the task.

## Rule

- **`name:` / `subagent_type` = identity.** Set it to the canonical agent type (e.g. `t1k-kit-developer`, `Explore`, `t1k-tester`) or omit it (the harness defaults the label to `subagent_type`).
- **`description:` = task.** The job summary belongs here — a 1–5 word imperative phrase. That is the ONLY place the task goes.
- **NEVER bake the task into the identity string.** `subB-mcp-skill-cleanup`, `G-syncback`, `issue-opus-preserve` fuse identity + task into one session-local token — all violations.

### Uniqueness suffix — the only permitted decoration

For **parallel fan-out of the same agent type**, a short numeric/uniqueness suffix disambiguates concurrent spawns:

| Allowed (disambiguation only) | Forbidden (task baked into identity) |
|---|---|
| `t1k-code-reviewer-1`, `t1k-code-reviewer-2` | `reviewer-security-pass`, `reviewer-perf-pass` |
| `Explore-1`, `Explore-2` | `subC-lib-audit`, `G-zombie-sweep` |
| `t1k-tester-a`, `t1k-tester-b` | `subD-sync-back-skill` |

The suffix is a counter (`-1`, `-a`), never a task phrase. A verb/noun after the agent type → move it to `description:`.

## Full details

The 5 reasons it matters (identity erasure, no precedent, redundancy, `t1k-` identity marker, agentId routing), the status-row test, and the originating history (#383, DOTS-AI 2026-05-28, three maintainer push-backs): `docs/agent-name-is-identity.md`.

## Related

- `rules/naming-convention.md` — `t1k-` prefix is the kit-shipped agent identity marker.
- `rules/orchestration-rules.md` — which agent to spawn (this rule covers what to name it).
- `rules/mr-transparent-routing.md` — the interceptor resolves the agent `.md` by `subagent_type`; a renamed spawn breaks resolution.
