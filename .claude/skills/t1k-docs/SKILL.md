---
name: t1k:docs
description: "Create and update project documentation in docs/. Use for 'init docs', 'update docs after this change', 'generate a codebase summary', 'docs are out of date'."
keywords: [documentation, docs, update, init, summarize, readme]
argument-hint: "init|update|summarize"
effort: low
version: 2.20.0
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-base
protected: true
---

# TheOneKit Docs — Documentation Management

Manage project documentation in `docs/` directory.

## Operations
| Operation | Description |
|---|---|
| `init` | Create project-appropriate doc structure |
| `update` | Update docs after code changes |
| `summarize` | Quick codebase summary |

## Doc Structure
```
docs/
├── code-standards.md
├── system-architecture.md
├── project-changelog.md
├── development-roadmap.md
└── codebase-summary.md
```

## Agent Routing
Follow protocol: `skills/t1k-cook/references/routing-protocol.md`
This command uses role: `t1k-docs-manager`

## References
- `references/init-workflow.md`
- `references/update-workflow.md`
- `references/summarize-workflow.md`

