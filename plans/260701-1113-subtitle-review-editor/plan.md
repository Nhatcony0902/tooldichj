# Plan: Subtitle Review / Edit Checkpoint in the Video-Translation Pipeline

Created: 2026-07-01 (260701-1113)
Branch: `feature-dub-removal-subtitle-detect` (current) — branch fresh from `main` or this branch per branch-discipline before cook.

## Problem

The video pipeline (`video-pipeline.worker.ts`) runs straight through with no human checkpoint:

```
Upload -> extract audio -> STT -> translate segments -> (optional blur) -> burn-in -> COMPLETED + deduct 10 credits
```

If STT mis-heard or a translation is wrong, the user only finds out after the video is burned — the only fix is a brand-new job (and paying credits again). Credits are already deducted only at the very end (`$transaction`, worker lines 186-213), so pausing before burn-in costs the user nothing.

## Goal

Insert a **review/edit checkpoint** between "translate segments" and "burn-in / finalize". After STT + translation, the job stops at a new `AWAITING_REVIEW` state and persists the translated segments as editable structured data. The user reviews/edits the lines, then confirms; only then does the pipeline run blur + burn-in + finalize + deduct credits.

---

## Confirmed Decisions (MVP defaults — see "Open Decisions" note; flip any before cook)

1. **Timing edits: TEXT-ONLY for MVP.** The editor edits `translatedText` only; `start`/`end` are shown read-only for context. Whisper timing is generally accurate and the primary pain is wrong text; editable timing adds overlap/monotonicity validation UX that YAGNI defers. The column stores `start`/`end` regardless, so enabling timing edits later is additive.
2. **Re-translation / TranslationCache: NOT in MVP.** The user corrects the translated text directly (manual edit). No per-line "re-translate" button, no `TranslationCache` involvement. Re-invoking Gemini per edited line is a separate feature; the cache is keyed for the bulk-translate path only. Explicitly deferred.
3. **Abandoned `AWAITING_REVIEW` jobs: OUT OF SCOPE for MVP (no auto-expiry).** No credits are held (deduction happens only at confirm), so an abandoned job costs only stored input + persisted segments. The existing Delete endpoint already permits deleting any non-`PROCESSING` job, so the user can clean it up manually. A TTL/cron sweep is a documented future enhancement, not built now.
4. **Review is ALWAYS-ON for MVP (no opt-in toggle).** The stated goal is unambiguous ("the job should STOP and wait"). Always-on avoids a new upload-form toggle + new DB flag + extra worker branching (KISS). A straight-through opt-out can be added later behind a flag if demanded.

> **Open Decisions note:** these four were genuine design forks. AskUserQuestion was unavailable in this planning session's toolset, so they are set to reversible MVP defaults above and flagged in the handoff report. If the user wants timing edits, re-translation, expiry, or an opt-in toggle, the affected phase files call out exactly what changes.

---

## Verified Codebase Facts (ground truth as of 2026-07-01)

| Fact | Location | Note |
|------|----------|------|
| Whole pipeline runs in one BullMQ job `process-video` | `queue.service.ts:14-25`, `video-pipeline.worker.ts:43` | attempts:3, backoff exp, removeOnComplete:true, removeOnFail:false |
| Editable segment shape is `TranslatedSegment` | `subtitle.service.ts:9-11` | `{ start:number, end:number, text:string, translatedText:string }` — `text`=original, `translatedText`=translated |
| Translated segments exist ONLY in worker memory today | `video-pipeline.worker.ts:110-126` | turned into SRT string via `buildSrt`, saved as a file (`srtKey`), never persisted structured |
| `VideoJob` has no column for translated segments | `schema.prisma:69-88` | `transcript Json?` holds original STT only — **schema gap to close** |
| `status` is a plain `String` (no DB enum) | `schema.prisma:73` | new values need NO migration; a NEW column DOES |
| Credit deduct + COMPLETED flip is one atomic `$transaction` | `video-pipeline.worker.ts:186-213` | `updateMany where status notIn [COMPLETED,CANCELLED]` guards double-charge |
| `assertNotCancelled(jobId)` checkpoint pattern exists | `video-pipeline.worker.ts:255-263` | reuse/extend for pause/resume structuring |
| Region-detect + blur is inside the burn block, AFTER translate | `video-pipeline.worker.ts:140-166` | does NOT depend on translated text — free to run before or after the pause |
| Cancel allowed only for PENDING/PROCESSING | `translation.service.ts:464-479` | guard list must add `AWAITING_REVIEW` |
| Delete allowed for any non-`PROCESSING` job | `translation.service.ts:481-492` | `AWAITING_REVIEW` is already deletable (covers Decision 3) |
| Enqueue helper is a single method | `queue.service.ts:14` | add a sibling for the burn/resume phase |
| Frontend polls every 3s while PENDING/PROCESSING | `VideoTranslationSection.tsx:64-89` | must add `AWAITING_REVIEW` to keep polling |
| Status badge + label already use a map with `??` fallback | `VideoTranslationSection.tsx:332-351` | add `AWAITING_REVIEW` entry |
| Frontend `VideoJob.status` union | `types/index.ts:13` | add `"AWAITING_REVIEW"` |
| Cancel/Delete endpoints + HTTP-exception convention already exist | `translation.controller.ts:192-215`, `translation.service.ts:464-492` | mirror for review endpoints |
| `getVideoJobById` + ownership check pattern | `translation.controller.ts:249-255` | reuse for review endpoints |
| Frontend is "NOT the Next.js you know" | `frontend/AGENTS.md` | read `node_modules/next/dist/docs/` before touching Next APIs; our change is a plain client component (low risk) |

---

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Schema + state machine + worker split (pause after translate, resume on confirm) | `schema.prisma` + migration, `video-pipeline.worker.ts`, `queue.service.ts`, `pipeline/subtitle.service.ts`, `video-pipeline.worker.spec.ts` | L |
| 2 | Review API (fetch / save edits / confirm-resume) + cancel-guard update | `translation.service.ts`, `translation.controller.ts`, NEW `dto/update-segments.dto.ts` | M |
| 3 | Frontend review/edit UI + status wiring | `types/index.ts`, `VideoTranslationSection.tsx`, `page.module.css` | M-L |

Detail cards: `phase-1.md`, `phase-2.md`, `phase-3.md`.

---

## State Machine

```
                                   user edits (PATCH segments, optional)
                                            ┌───────────┐
                                            ▼           │
PENDING ─► PROCESSING ──(STT+translate)──► AWAITING_REVIEW ──(POST confirm)──► PROCESSING ──(blur+burn+finalize)──► COMPLETED
   │            │                               │                                  │
   ▼            ▼                               ▼                                  ▼
CANCELLED   CANCELLED                       CANCELLED                            FAILED
                                            (or Delete)
```

- **Phase A** (BullMQ job `process-video`): PENDING → PROCESSING → (STT + translate + persist segments) → `AWAITING_REVIEW`, then the BullMQ job returns normally. NO burn, NO credit deduction.
- **Phase B** (BullMQ job `process-video-burn`, enqueued by the confirm endpoint): PROCESSING → (rebuild SRT from edited segments → optional blur → burn-in → save video) → COMPLETED + deduct 10 credits.
- No new BullMQ job exists while a job sits in `AWAITING_REVIEW` (Phase A already completed + `removeOnComplete`), so cancelling/deleting from that state touches no running worker.
- **No `CONFIRMED` intermediate status** — the confirm endpoint transitions `AWAITING_REVIEW → PROCESSING` atomically and enqueues Phase B; the burn worker branches on `job.name`, not on a dedicated status.

---

## API Contract (fixed before FE/BE fan-out — per contract-first-integration.md)

All three: `@UseGuards(JwtAuthGuard)`; ownership enforced (`job.userId === req.user.id`, else `ForbiddenException`); missing job → `NotFoundException`; wrong-state → `BadRequestException`. Segment shape is the SSOT `TranslatedSegment` plus a display `index`.

| Operation | Method + Path | Body | Success | Errors |
|---|---|---|---|---|
| Fetch editable segments | `GET /translation/video-jobs/:id/segments` | none | `{ success: true, segments: [{ index, start, end, text, translatedText }] }` | 404 not found · 403 not owner · 400 `"Job chưa ở trạng thái chờ duyệt"` |
| Save edits | `PATCH /translation/video-jobs/:id/segments` | `{ segments: [{ index, translatedText }] }` | `{ success: true }` | 404 · 403 · 400 validation (`"Danh sách phụ đề không hợp lệ"`) |
| Confirm + resume | `POST /translation/video-jobs/:id/confirm` | none | `{ success: true, job }` | 404 · 403 · 400 `"Job đã được xác nhận hoặc đã thay đổi trạng thái"` |

- PATCH accepts only `{ index, translatedText }` per segment for MVP (Decision 1: timing read-only). The server matches by `index` against the stored array and updates `translatedText` only — never trusts client-sent `start`/`end`.
- Error style follows the cancel/delete precedent: **HTTP exceptions** (NestJS emits 400/403/404), not the swallow-to-`{success:false}` style used by `translate`/`createVideoJob`.

---

## File Ownership Map

| File | Phase(s) | Conflict handling |
|------|----------|-------------------|
| `backend/prisma/schema.prisma` + migration | 1 | Phase 1 only |
| `backend/src/translation/pipeline/video-pipeline.worker.ts` | 1 | Phase 1 only |
| `backend/src/translation/pipeline/video-pipeline.worker.spec.ts` | 1 | Phase 1 only |
| `backend/src/translation/queue.service.ts` | 1 | Phase 1 only |
| `backend/src/translation/pipeline/subtitle.service.ts` | 1 | Phase 1 only (add validate/rebuild helper) |
| `backend/src/translation/translation.service.ts` | 2 | Phase 2 only |
| `backend/src/translation/translation.controller.ts` | 2 | Phase 2 only |
| `backend/src/translation/dto/update-segments.dto.ts` (NEW) | 2 | Phase 2 only |
| `frontend/src/app/types/index.ts` | 3 | Phase 3 only |
| `frontend/src/app/components/VideoTranslationSection.tsx` | 3 | Phase 3 only |
| `frontend/src/app/page.module.css` | 3 | Phase 3 only |

**No file is owned by two phases** — phases are cleanly separable by layer, so no intra-plan sequencing hazard beyond the dependency graph.

---

## Dependency Graph

```
Phase 1 (schema + worker pause/resume) ──► Phase 2 (review API) ──► Phase 3 (frontend UI)
```

Strictly sequential across the shared contract: Phase 2 needs the new `translatedSegments` column + `AWAITING_REVIEW` status + the burn-enqueue helper from Phase 1; Phase 3 needs the live endpoints from Phase 2. Within each phase, edits may be batch-applied then verified once (ai-velocity-batch-compile).

---

## Risk Assessment (L×I, ≥15 = HIGH, mitigate before phase starts)

| # | Risk | L | I | Score | Mitigation | Phase |
|---|------|---|---|-------|------------|-------|
| R1 | Phase A re-runs on a job already in `AWAITING_REVIEW`/COMPLETED (duplicate enqueue, BullMQ retry) → re-translates or re-charges | 2 | 4 | 8 | Extend the existing early-return guard: skip when `status` ∈ {COMPLETED, CANCELLED, AWAITING_REVIEW}. Phase B credit deduction stays inside the atomic `updateMany notIn [COMPLETED,CANCELLED]` transaction (already idempotent). | 1 |
| R2 | Phase B BullMQ retry after partial burn → re-burn / double credit | 2 | 3 | 6 | Credit deduction is guarded by the existing atomic completion transaction; a retry that finds COMPLETED matches 0 rows and skips the charge. Re-burn just overwrites the same `outputs/<id>/video.mp4` key — idempotent. | 1 |
| R3 | User edits produce malformed segments (empty text, wrong count/index) → burn produces broken/empty subtitles | 3 | 3 | 9 | `validateReviewSegments()` on PATCH: array length matches stored, every `index` present exactly once, `translatedText` is a non-empty string (after trim). Reject with 400 before persisting. Phase B rebuilds SRT only from validated stored data. | 1,2 |
| R4 | In-flight jobs mid-pipeline at deploy time have no `translatedSegments` / hit the new split | 2 | 3 | 6 | Additive nullable column is safe. **Deploy with the queue drained** (documented in rollout note); a job caught mid-translate at deploy simply fails its BullMQ attempt and retries cleanly under the new code path. | 1 |
| R5 | Job abandoned in `AWAITING_REVIEW` indefinitely → stored input + segments never cleaned | 3 | 1 | 3 | Out of scope (Decision 3): no credits held; Delete already permits `AWAITING_REVIEW`. Future TTL sweep noted, not built. | — |
| R6 | Race: user confirms and cancels near-simultaneously → double transition | 2 | 3 | 6 | Both confirm and cancel use atomic `updateMany` with a status precondition; the loser matches 0 rows and returns a 400. | 2 |
| R7 | Contract drift (path/method/field/casing) between FE and BE | 2 | 4 | 8 | Fixed API-contract table above, embedded verbatim in phase-2 + phase-3; Phase 2 merges before Phase 3. | 2,3 |
| R8 | Frontend stops polling at `AWAITING_REVIEW`, so the UI never notices confirm→burn→complete | 3 | 2 | 6 | Add `AWAITING_REVIEW` to the `hasActiveJobs` predicate so the 3s poll continues through review and the subsequent burn phase. | 3 |
| R9 | Editing a long transcript (100+ lines) in one PATCH is a large payload / heavy re-render | 2 | 2 | 4 | Single PATCH of the full array is fine for typical subtitle counts; React list keyed by `index`. No pagination in MVP (YAGNI). | 3 |

No risk ≥ 15. R3 (9) is the one to watch — validation must land in Phase 1's helper AND be enforced by Phase 2's PATCH.

---

## Backwards Compatibility

- **Additive schema:** one new nullable column `translatedSegments Json?` — existing rows read as `null`, no data migration. Additive statuses (`AWAITING_REVIEW`) need no migration (String column).
- **Behavioral change for ALL new jobs:** every new job now stops at `AWAITING_REVIEW` (Decision 4, always-on). This is the intended feature, not a regression — but it changes the completion timing users experience. Frontend Phase 3 must ship together so users have a way to confirm; **do not deploy Phase 1 to production without Phase 3**, or jobs will stall unconfirmable.
- **Additive API:** 3 new endpoints; existing endpoints unchanged. Cancel guard *widens* its allowed set (`AWAITING_REVIEW` added) — strictly more permissive, backwards-compatible.
- **Rollout:** drain the BullMQ queue before deploying Phase 1 (R4). Ship Phases 1+2+3 together to production.

---

## Rollback Plan (per phase)

| Phase | Rollback | Caveat |
|-------|----------|--------|
| 3 | Revert the 3 frontend files → UI loses the review editor; endpoints remain but unused. | Jobs already in `AWAITING_REVIEW` become unconfirmable from the UI — resolve by direct `POST /confirm` or Delete before rollback. |
| 2 | Revert `translation.service.ts`, `translation.controller.ts`, delete the DTO → endpoints gone. | Any `AWAITING_REVIEW` job can no longer be confirmed → drain/confirm them first. |
| 1 | Revert worker/queue/subtitle/spec; `prisma migrate resolve --rolled-back` to drop `translatedSegments`. | **Before rollback, drain all `AWAITING_REVIEW` jobs** — the single-pass worker has no resume path for them. |

Each phase reverts independently top-down (3→2→1). The binding pre-condition on every rollback: no job left stranded in `AWAITING_REVIEW`.

---

## Test Matrix

| Phase | Verify command / step | Pass criterion |
|-------|-----------------------|-----------------|
| all | `cd backend && npx tsc --noEmit` | 0 errors |
| all | `cd backend && npm test` | existing suite green (update `video-pipeline.worker.spec.ts` for any ctor/branch change) |
| 3 | `cd frontend && npm run build` + `npx eslint .` | 0 errors, no Next deprecation warnings (AGENTS.md) |
| 1 | `cd backend && npx prisma migrate dev --name add_translated_segments` | migration applies clean; column nullable |
| 1 | unit: feed a `TranslatedSegment[]` through persist→reload→`buildSrt` | rebuilt SRT identical to building from the in-memory array |
| 1 | manual: submit a job | job reaches `AWAITING_REVIEW`, `translatedSegments` populated, `subtitlesUrl`/`outputVideoUrl` still null, credits NOT deducted |
| 2 | `GET .../segments` on an `AWAITING_REVIEW` job (owner) | returns the persisted segments with `index`; non-owner → 403; non-review status → 400 |
| 2 | `PATCH .../segments` with an empty `translatedText` | 400 validation; valid edit → 200 and DB reflects the new text |
| 2 | `POST .../confirm` twice | first → 200 + enqueues burn; second → 400 (already transitioned) |
| 2 | `POST .../cancel` on an `AWAITING_REVIEW` job | 200, status `CANCELLED`, credits unchanged |
| 1+2 | manual E2E: submit → edit a line → confirm | video burns the EDITED text, completes COMPLETED, deducts exactly 10 credits |
| 3 | manual: job hits `AWAITING_REVIEW` | UI shows a "chờ duyệt" badge + editor; polling continues; after confirm, progresses to COMPLETED without a page reload |

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 | L | Trickiest — worker split into two BullMQ jobs + migration + idempotency guards |
| Phase 2 | M | Blocked by Phase 1 contract (column + statuses + burn-enqueue helper) |
| Phase 3 | M-L | Blocked by Phase 2 endpoints; new editable table UI is the bulk of the effort |
| **Total** | **L** | Critical path: Phase 1 → 2 → 3 (strictly sequential) |

---

## Rule Check (planning constraints)

- **Reuse-first:** reuses `assertNotCancelled` checkpoint pattern, `getVideoJobById`+ownership guard, cancel/delete HTTP-exception convention, `buildSrt`, atomic `updateMany` completion guard, existing 3s polling. ✔
- **YAGNI:** no re-translation, no timing edits, no expiry cron, no opt-in toggle, no pagination, no websockets — all explicitly deferred. ✔
- **KISS:** two-BullMQ-job split branching on `job.name`; region-detect stays in Phase B (no region-persistence column). ✔
- **DRY:** segment shape is the single `TranslatedSegment` type; validation helper lives once in `subtitle.service.ts`. ✔
- **No hardcoded values:** flat 10-credit cost unchanged (existing constant path); Vietnamese UI strings are copy, not config; statuses are code-level constants. ✔

---

## Cook Handoff

`/t1k:cook plans/260701-1113-subtitle-review-editor/plan.md`
