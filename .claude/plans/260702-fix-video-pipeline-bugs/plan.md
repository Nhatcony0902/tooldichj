# Plan: Fix Critical/Important Bugs in Two-Phase Video Pipeline

Created: 2026-07-02
Branch: `feature-dub-removal-subtitle-detect` (current)
Source: code review of `b6c14dc..HEAD` (subtitle review checkpoint, auto-detect blur region, job management UI)

Fixes 2 critical (money-safety) and 5 important bugs in the `tooldichj` video-translation pipeline (NestJS backend + Next.js frontend). No open design decisions remain — all fixes follow the atomic-guard pattern already established in this codebase (see `videoJob.updateMany` double-charge guard in `video-pipeline.worker.ts:283`).

---

## Bugs In Scope

| ID | Severity | Summary |
|----|----------|---------|
| C1 | Critical | Cancelling a job during the burn phase is silently reverted — job completes and user is still charged |
| C2 | Critical | No credit reservation — concurrent/sequential job creation can over-commit credits past the user's balance |
| I1 | Important | Uploaded file orphaned in storage when credit check fails after upload |
| I2 | Important | Job left stuck (`PENDING`/`PROCESSING`) with no recovery path when queue enqueue fails after a DB status transition |
| I3 | Important | `confirmReview` proceeds to confirm+burn even when the preceding `saveDraft` failed validation, silently discarding the user's latest edits |
| I4 | Important | Hardcoded `boxblur=20:2` can exceed FFmpeg's radius limit for short/low-res subtitle bands, failing the whole job |
| I5 | Important | Several endpoints return HTTP 200 with `{success:false}` instead of proper 4xx/5xx status codes (violates CLAUDE.md rule #4) |

---

## Verified Codebase Facts (ground truth as of 2026-07-02)

| Fact | Location | Note |
|------|----------|------|
| `runBurnPhase` overwrites status to `PROCESSING` with no `CANCELLED` check | `video-pipeline.worker.ts:195` | root cause of C1; `assertNotCancelled` at line 205 runs *after* the overwrite, so it never sees `CANCELLED` |
| `runTranslatePhase` already has the correct pattern | `video-pipeline.worker.ts:64-73` | mirror this guard into `runBurnPhase` |
| Credits checked but never reserved | `translation.service.ts:420-435` (`createVideoJob`) | root cause of C2; only a `user.credits < 10` read |
| Credits only deducted at burn completion | `video-pipeline.worker.ts:301-304`, inside the double-charge-guarded `$transaction` | must move to reservation-at-creation model; completion transaction must stop decrementing |
| `cancelVideoJob` has no refund | `translation.service.ts:467-482` | must refund the reservation on cancel |
| `onFailed` has no refund | `video-pipeline.worker.ts:318-345` | must refund the reservation on permanent failure |
| Existing non-atomic deduct pattern | `credit.service.ts:10-19` (`deductCredit`) | used by text translation (`translation.service.ts:108,163`); NOT reused for video (video needs conditional/atomic reserve, a new method) |
| Upload happens before credit check | `translation.controller.ts:157` (`storage.save`) then `:160` (`createVideoJob`) | root cause of I1 |
| `inputStorageKey` is nullable in schema | `schema.prisma:72` | confirms reservation-before-upload restructure is schema-safe, but simplest fix is catch-and-cleanup (see Phase 2) |
| Enqueue-after-flip, no rollback, in 2 places | `translation.controller.ts:167` (`createVideoJob` flow), `:229` (`confirmJob` flow) | root cause of I2 |
| `confirmVideoJob` is already atomic (`updateMany` on `status: 'AWAITING_REVIEW'`) | `translation.service.ts:518-530` | reuse this exact guard pattern for the I2 rollback |
| `saveDraft` swallows its own failure (never throws/returns status) | `VideoTranslationSection.tsx:196-218` | root cause of I3 |
| `confirmReview` calls `await saveDraft()` then unconditionally proceeds | `VideoTranslationSection.tsx:220-241` | must gate on save success |
| `blurSubtitleArea` hardcodes `boxblur=20:2` | `burn-in.service.ts:62` | root cause of I4; FFmpeg requires `radius ≤ min(w,h)/2` of the cropped band |
| `heightRatio` is already clamped to `(0, 1-yRatio]` | `subtitle-region.service.ts:133-136` | region math itself is fine; only the blur radius is unbounded relative to the resulting crop height |
| `translate`, `createVideoJob`, `getVideoJobs` catch-and-return `{success:false}` at HTTP 200 | `translation.controller.ts:104-114, 169-177, 257-263` | root cause of I5 |
| `InsufficientCreditsError` already exists as a typed error | `credit/insufficient-credits.error.ts` | reuse for the 402 mapping in I5 |

---

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Money-safety: cancel guard + credit reservation (C1, C2) | `video-pipeline.worker.ts`, `translation.service.ts`, `credit.service.ts` | M |
| 2 | Controller hardening: upload/enqueue atomicity + HTTP codes (I1, I2, I5) | `translation.controller.ts` | M |
| 3 | Frontend confirm-flow fix (I3) | `VideoTranslationSection.tsx` | S |
| 4 | Blur radius safety clamp (I4) | `burn-in.service.ts` | S |

Detail cards: `phase-1.md` … `phase-4.md`.

---

## File Ownership Map

| File | Phase(s) | Conflict handling |
|------|----------|-------------------|
| `video-pipeline.worker.ts` | 1 | Phase 1 only |
| `translation.service.ts` | 1 | Phase 1 only |
| `credit.service.ts` | 1 | Phase 1 only (new `reserveCredit`/`refundCredit` methods) |
| `translation.controller.ts` | 2 | Phase 2 only (I1+I2+I5 combined to avoid re-touching the same file across phases) |
| `VideoTranslationSection.tsx` | 3 | Phase 3 only |
| `burn-in.service.ts` | 4 | Phase 4 only |

No two phases touch the same file — **all 4 phases are parallel-safe** (no sequencing dependency between them). Phase 1 is highest priority (money-safety) and should land first regardless.

---

## Dependency Graph

```
Phase 1 (money-safety: worker.ts + service.ts + credit.service.ts)
Phase 2 (controller.ts: I1 + I2 + I5)
Phase 3 (frontend: I3)
Phase 4 (burn-in.service.ts: I4)

All four phases are file-disjoint → no ordering constraint.
Recommended sequence: 1 → 2 → 3 → 4 (severity order), or run in parallel via /t1k:team.
```

---

## Cross-Cutting: Credit Reservation Model (C2)

Per SSOT (no duplicated logic), add two new methods to `credit.service.ts` alongside the existing `deductCredit`:

```typescript
// Atomic conditional decrement — throws InsufficientCreditsError if balance < amount.
async reserveCredit(userId: string, amount: number): Promise<void>

// Best-effort increment — used to release a reservation on cancel/failure.
async refundCredit(userId: string, amount: number): Promise<void>
```

`reserveCredit` uses `prisma.user.updateMany({ where: { id: userId, credits: { gte: amount } }, data: { credits: { decrement: amount } } })` and checks `result.count === 0` → throw. This closes the TOCTOU race in the current `findUnique` + separate `create` (two concurrent requests reading the same balance).

**Charge point moves from completion to creation.** `createVideoJob` reserves 10 credits atomically in the same Prisma transaction as the job insert. The burn-phase completion transaction (`video-pipeline.worker.ts:301-304`) stops decrementing — the charge already happened. `cancelVideoJob` and `onFailed` refund 10 credits, each gated by the same atomic `updateMany` that flips status (exactly-once, mirroring the existing double-charge guard) so a reservation is never refunded twice.

---

## Risk Assessment

| # | Risk | L (1-5) | I (1-5) | Score | Mitigation | Phase |
|---|------|---------|---------|-------|------------|-------|
| R1 | Moving the charge to creation-time changes user-visible behavior (credits drop immediately instead of at completion) | 3 | 2 | 6 | This is the correct/expected behavior for a reservation model; no UI change needed since `/translation/video-jobs` already returns live job status, and `/auth/me` (or equivalent) already reflects `user.credits` on every poll | 1 |
| R2 | Refund logic double-fires if both `cancelVideoJob` and a race with `onFailed` fire for the same job | 4 | 4 | **16 HIGH** | Both refund paths are gated by the SAME atomic `updateMany` status-transition guard already used for the double-charge case — only the update that actually flips status executes the refund | 1 |
| R3 | Existing in-flight jobs (created before this migration, already `PROCESSING`/`AWAITING_REVIEW`) never had credits reserved at creation, but completion no longer charges → those jobs complete for free | 3 | 3 | 9 | One-time backfill: for jobs in a non-terminal state at deploy time, either let them complete uncharged (acceptable one-off) or run a manual reservation pass; document as a deploy note in Phase 1 (do not silently double-charge on next code path change) | 1 |
| R4 | `reserveCredit`'s `updateMany` WHERE-guard needs `credits: { gte: amount }` — Prisma numeric comparison on a race under high concurrency | 2 | 3 | 6 | `updateMany` with a WHERE clause is a single atomic SQL statement in Postgres/SQLite — no additional locking needed | 1 |
| R5 | I2's rollback-to-`AWAITING_REVIEW` on enqueue failure could race with a second confirm click | 2 | 2 | 4 | Rollback uses the same atomic `updateMany` pattern (`where: { status: 'PROCESSING' }`); a concurrent second confirm attempt would simply see `count === 0` and surface the existing "already confirmed" error | 2 |
| R6 | Cleanup-on-failure (I1) storage delete itself fails (e.g., storage provider down) | 2 | 2 | 4 | Best-effort `.catch()` + log, same pattern already used in `deleteVideoJob` (`translation.controller.ts` storage cleanup loop) — never let cleanup failure mask the original error | 2 |
| R7 | I5's HTTP status change breaks frontend code that currently branches on `data.success` at a 200 response | 3 | 3 | 9 | Frontend already checks `res.ok` before falling back to `data.message` in most call sites (e.g. `VideoTranslationSection.tsx:208`); audit all call sites of the 3 changed endpoints in Phase 2 and update any that assume 200 | 2 |
| R8 | I4's dynamic radius clamp changes visual blur strength on very short bands (less blur = original subtitle less obscured) | 2 | 2 | 4 | Clamp only reduces radius when it would otherwise exceed FFmpeg's hard limit (i.e., only in the failure case) — normal-height bands are unaffected | 4 |

**HIGH-risk gate:** R2 (Phase 1) — verify with a unit test that simulates cancel + permanent-failure racing for the same job and asserts exactly one refund.

---

## Backwards Compatibility

- **C2 credit-reservation model is a behavior change**, not a schema change (no new columns — reuses `User.credits`). Flag R3 explicitly to the user before deploy: in-flight jobs created under the old model have no reservation recorded.
- I5's status-code fix changes wire-format for 3 endpoints (200→4xx/5xx on error paths); `success:false` body shape is preserved for callers that still read it, only the status code changes. Frontend call sites audited in Phase 2.
- I1/I2/I3/I4 are pure bug fixes with no external contract change.

---

## Test Matrix

| Phase | Verify command | Pass criterion |
|-------|----------------|-----------------|
| all | `cd backend && npm run build` | exits 0 (TS strict, no `any`) |
| all | `cd backend && npm test` | existing suite green, no regressions |
| 1 | new unit test: cancel mid-burn-phase | job ends `CANCELLED`, not `COMPLETED`; credits refunded exactly once |
| 1 | new unit test: 2 concurrent `createVideoJob` calls with exactly 10 credits | exactly 1 succeeds, 1 throws `InsufficientCreditsError`; final balance is 0, never negative |
| 1 | new unit test: permanent failure after reservation | credits refunded exactly once; cancel-then-fail race refunds exactly once (R2 gate) |
| 2 | new unit test: `createVideoJob` throws after upload | uploaded storage key is deleted |
| 2 | new unit test: enqueue throws in `createVideoJob` flow | job marked `FAILED` with error message, credits refunded, storage cleaned up |
| 2 | new unit test: enqueue throws in `confirmJob` flow | job rolled back to `AWAITING_REVIEW`, user can retry confirm |
| 2 | new unit test: `translate`/`createVideoJob`/`getVideoJobs` error paths | HTTP status is 4xx/5xx, not 200 |
| 3 | new/updated component test or manual: blank out a subtitle line then click confirm | confirm is blocked with a visible error; burn is NOT triggered until save succeeds |
| 4 | new unit test: `blurSubtitleArea` with a short region (`heightRatio` producing <40px band on a 480p input) | ffmpeg command uses a clamped radius; does not throw |
| 4 | manual: upload with "Xóa phụ đề gốc" checked, short/thin subtitle band video | burn phase completes, not `FAILED` |

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 | M | Highest priority (money-safety); no file dependency on other phases |
| Phase 2 | M | File-disjoint from Phase 1; can run in parallel |
| Phase 3 | S | Frontend only, file-disjoint |
| Phase 4 | S | Smallest, file-disjoint |
| **Total** | **~M** | All phases parallel-safe; sequence by severity (1→2→3→4) if single-agent |

---

## Rollback Plan (per phase)

| Phase | Rollback |
|-------|----------|
| 1 | Revert `video-pipeline.worker.ts`, `translation.service.ts`, `credit.service.ts` — restores charge-at-completion (re-exposes C1/C2, acceptable short-term rollback) |
| 2 | Revert `translation.controller.ts` — restores prior upload/enqueue ordering and HTTP 200 error responses |
| 3 | Revert `VideoTranslationSection.tsx` — restores unconditional confirm-after-save-attempt |
| 4 | Revert `burn-in.service.ts` — restores fixed `boxblur=20:2` |

Each phase is an independent revert (file-disjoint, no cross-phase dependency).

---

## Next Step

`/t1k:cook .claude/plans/260702-fix-video-pipeline-bugs/plan.md`
