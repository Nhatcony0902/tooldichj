---
origin: theonekit-core
repository: The1Studio/theonekit-core
module: t1k-extended
protected: true
---

# t1k-clickup — Extended Patterns

Advanced workarounds for the MCP's structural-mutation gaps. Loaded on demand from `SKILL.md`.

## Pattern: Archive-folder workaround for missing delete

The MCP cannot delete spaces, folders, lists, or docs. The user must always do those via UI. For lists that need archival mid-session (e.g., old structure being replaced by new):

1. **Create an `zzz_Archive` folder** at the bottom of the space (the `zzz_` prefix sorts it last alphabetically in most ClickUp UIs).
2. **Create `Closed Lost`, `Dormant`, `Churned`, `Deprecated` lists inside the archive folder** — one per category, so archived items don't get lost in a single dumping ground.
3. **For items that CAN be moved** (status-compatible), `clickup_move_task` into the archive lists. They retain all history (comments, attachments, time entries).
4. **For LISTS being decommissioned** (after their tasks migrated out): rename with `zz_` prefix + descriptive content like `"⚠️ DEPRECATED — Tu UI delete required (MCP cannot delete lists). Tasks migrated to <new location>."` Add this to the user's UI to-do list.
5. **Critical for partial moves via `add_task_to_list`:** the home list is still the old one. Tell the user to "Set as home list" in the target list BEFORE deleting the old one, or the multi-list ClickApp will lose the task when the home list is deleted.

This pattern is the canonical workaround for the MCP's gap around list/folder/space deletion. Mentioned in the manual-actions doc Tu has to action.

## Pattern: MEDDPICC-aligned Sales CRM restructure

When restructuring a sales pipeline against the MEDDPICC qualification framework (Metrics, Economic Buyer, Decision Criteria, Decision Process, Paper Process, Identify Pain, Champion, Competition):

```
Space/
├── 📥 1. Pipeline (folder)
│   ├── Inbound Leads        — pre-qualification, came to us
│   ├── Outbound Prospects   — pre-qualification, we found them
│   ├── Discovery            — MEDDPICC qualification in progress (1-3 letters)
│   ├── Qualified            — MEDDPICC 4+ letters confirmed (E + Champion required)
│   └── Negotiation          — Paper Process active
├── 💼 2. Customers (folder)
│   ├── Active Accounts      — closed-won, currently delivering
│   ├── At-Risk              — health declining
│   └── Renewals             — within 60 days of contract end
├── 👥 3. People (folder)
│   └── Contacts             — Champion/EB/POC links from Pipeline+Customer tasks
├── 📊 4. Ops & Reviews (folder)
│   └── Recurring Reviews    — Weekly Pipeline Review, Monthly Account Review, Quarterly Audit
└── 🗄️ zzz_Archive (folder)  — see archive-folder pattern above
```

**MEDDPICC custom fields** (all UI-only — see template-instantiation gotcha):

| Field | Type | Notes |
| --- | --- | --- |
| Metrics | Long text | quantified business value |
| Economic Buyer | Task relationship | links to Contacts list |
| Decision Criteria | Long text | written list of their evaluation criteria |
| Decision Process | Long text | step-by-step path to signature |
| Paper Process | Long text | legal/procurement/security review steps |
| Pain Level | Dropdown | No pain / Latent / Active / Crisis |
| Champion | Task relationship | links to Contacts; MUST be tested before scoring = 1 |
| Competition | Dropdown | None / Internal / 1-2 vendors / Many |
| MEDDPICC Score | Number | 0–8 sum of letters with verified evidence |

**Stage promotion gates:** Discovery → Qualified requires `Champion = tested` AND `Economic Buyer = met`. Without both, deal stays in Discovery regardless of how engaged the prospect feels. Per the Scoring Rubric playbook.

**Companion playbook docs** to ship alongside the structure: Overview, Discovery Checklist, Scoring Rubric (0–8), Champion Development SOP, Economic Buyer Mapping SOP. Each ~200-400 lines, written as reusable pages in a dedicated `MEDDPICC Sales Playbooks` doc.

**When to deviate:** if pipeline volume is <10 active deals, the 5-stage Pipeline folder is over-engineering. Collapse to Leads / Qualified / Negotiation. The MEDDPICC custom fields work at any pipeline scale.

## Pattern: Delete-tracking-list workaround (for mass UI deletes)

When the user has many deprecated items (lists + docs) to UI-delete and the MCP delete tools don't exist, do NOT promise to "move them into a Delete folder" — `move_list` and `move_document` don't exist. Build a **checklist list** instead.

**Build:**

1. Create one new list called `🗑️ DELETE ME — Tu UI Cleanup (N items)` at the space root.
2. For EACH item to delete, create a task with:
   - **Name:** `🗑️ {item-name} ({list|doc})`
   - **Priority:** `normal` (or `high` for items with pre-delete steps)
   - **Markdown description:**
     ```
     **Type:** ClickUp {List|Doc} (deprecated)
     **ID:** `{item-id}`
     **URL:** {direct-clickup-url}
     **Action:** Right-click in sidebar → Delete {list|document} → Confirm

     {Optional: special pre-delete steps, e.g., home-list changes}
     ```
3. Surface the list to the user as the SSOT for cleanup.

User opens the list → clicks each task → uses the URL → UI-deletes the item → marks the task ✓. When all are done, they UI-delete the DELETE ME list itself.

**Why this works better than a "Delete folder":**
- MCP cannot MOVE existing items into a folder (`move_list`/`move_document` don't exist).
- A checklist list provides equivalent navigation + progress tracking without requiring impossible operations.
- The list's built-in `done` count (e.g., `5/34 complete`) gives the user a real progress bar.
- Pre-delete steps (e.g., home-list change for tasks in a list being deleted) can be embedded per-task.

**Confirmed empirically 2026-05-22:** Used to clean up 34 deprecated items (7 lists + 27 docs) in the PlayableLabs Sales CRM space. User feedback: clearer than a flat task list in the manual-actions doc.

## Pattern: Sub-agent fan-out for doc migration

When migrating 10+ docs into a consolidated master doc (or moving docs to a new folder via recreate-and-deprecate), serial execution blows the main agent's context (each doc is potentially 5-10KB of markdown × dozens of docs).

**Setup:**

1. In main context: identify destination doc(s), pre-allocate IDs by `clickup_create_document(parent, create_page: true)`.
2. Split source docs into 2-4 batches by topic or size (e.g., 11 playbooks/templates + 15 briefings).
3. Spawn ONE sub-agent per batch via the Agent tool (`run_in_background: true`). Each gets:
   - Explicit source-doc-id → source-page-id → new-page-name table (mechanical mapping, no decisions).
   - Destination doc ID.
   - Instruction: "parallel-read all source pages via `clickup_get_document_pages`, then parallel-create destination pages via `clickup_create_document_page` (content_format `text/md`)".
   - Instruction NOT to touch the initial blank page (main agent owns the TOC).
4. While sub-agents run, main agent prepares the TOC, deprecation banner template, manual-actions updates.
5. After sub-agents return their new-page-id reports, main agent:
   - Writes the index/TOC page with hyperlinks to each new sub-page.
   - Optionally fans out a final sub-agent for the 20-30 deprecation-banner writes on the old docs.
6. Update the user-facing SSOT (e.g., the Delete-tracking-list above).

**Performance:** 26-doc consolidation went from ~30 min sequential (one agent reading + writing 26 docs) to ~5 min wall time (3 migration sub-agents + 1 banner-application sub-agent, all in parallel).

**When NOT to use:** under ~5 docs, the orchestration overhead exceeds the gain. Do it serially.

**Anti-pattern to avoid:** spawning sub-agents to do "creative" work (e.g., rewriting content while migrating). Sub-agents should be **mechanical** — read source verbatim, write to destination. Decisions stay in the main agent.

**Confirmed empirically 2026-05-22.**

