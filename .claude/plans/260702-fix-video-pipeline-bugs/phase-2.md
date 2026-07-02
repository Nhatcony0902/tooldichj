# Phase 2: Controller Hardening — Upload/Enqueue Atomicity (I1, I2) + HTTP Codes (I5)

**Files owned:** `backend/src/translation/translation.controller.ts`

File-disjoint from Phase 1 — can run in parallel, but I2's "mark FAILED + refund" step calls into behavior Phase 1 introduces (`CreditService.refundCredit`), so land Phase 1 first if running sequentially.

---

## I1 — Orphaned upload on credit-check failure

**Root cause:** `createVideoJob` in the controller calls `storage.save()` (line 157) BEFORE `translationService.createVideoJob()` (line 160), which is where `InsufficientCreditsError` (or any other failure) is thrown. The file is never cleaned up.

**Fix:** wrap the post-upload steps in a try/catch that deletes the just-uploaded key on ANY failure:
```typescript
const safeName = path.basename(file.originalname);
const storageKey = `uploads/${Date.now()}-${safeName}`;
await this.storage.save(file.buffer, storageKey);

try {
  const removeSourceSubs = dto.removeSourceSubs === 'true';
  const job = await this.translationService.createVideoJob(userId, {
    fileName: file.originalname,
    inputStorageKey: storageKey,
    targetLang: dto.targetLang,
    outputMode,
    removeSourceSubs,
  });
  await this.enqueueOrFail(job.id, storageKey); // see I2 below
  return { success: true, job };
} catch (error: unknown) {
  await this.storage.delete(storageKey).catch((err: unknown) => {
    this.logger.warn(`Failed to clean up orphaned upload "${storageKey}": ${err instanceof Error ? err.message : err}`);
  });
  throw this.mapToHttpException(error); // see I5 below
}
```

---

## I2 — Orphaned job on enqueue failure (both call sites)

### Call site A — `createVideoJob` (create → enqueue)

**Root cause:** `translation.controller.ts:167` awaits `enqueueVideoJob` after the job row already exists as `PENDING`. If the queue throws, the job is stuck `PENDING` forever with an uploaded file no one will process.

**Fix:** add a private helper that marks the job `FAILED` + refunds credits + rethrows if enqueue fails, and call it from the try block in I1 above:
```typescript
private async enqueueOrFail(jobId: string, storageKey: string): Promise<void> {
  try {
    await this.queueService.enqueueVideoJob(jobId);
  } catch (error: unknown) {
    this.logger.error(`Failed to enqueue VideoJob ${jobId}, marking FAILED`, error instanceof Error ? error.stack : error);
    await this.translationService.failOrphanedVideoJob(jobId).catch((err: unknown) => {
      this.logger.error(`Failed to mark orphaned VideoJob ${jobId} as FAILED`, err);
    });
    throw error;
  }
}
```
Add `failOrphanedVideoJob(jobId)` to `translation.service.ts`: atomically flip `PENDING → FAILED` (guarded `updateMany`, mirrors the existing pattern) with `errorMessage: 'Không thể xếp hàng xử lý. Vui lòng thử lại.'`, and refund the 10 reserved credits (using `CreditService.refundCredit`, gated on `result.count > 0` for exactly-once, same shape as Phase 1 Step 4).

### Call site B — `confirmJob` (confirm → enqueue burn)

**Root cause:** `translation.controller.ts:229` awaits `enqueueVideoBurnJob` after `confirmVideoJob` already flipped `AWAITING_REVIEW → PROCESSING`. If the queue throws, the job is stuck `PROCESSING` with no worker — `getReviewSegments` requires `AWAITING_REVIEW` so the user can't reopen review, and `deleteVideoJob` blocks `PROCESSING` — no recovery.

**Fix:**
```typescript
@Post('video-jobs/:id/confirm')
async confirmJob(@Param('id') id: string, @Request() req: RequestWithUser) {
  const job = await this.translationService.confirmVideoJob(req.user.id, id);
  try {
    await this.queueService.enqueueVideoBurnJob(id);
  } catch (error: unknown) {
    this.logger.error(`Failed to enqueue burn phase for VideoJob ${id}, rolling back to AWAITING_REVIEW`, error instanceof Error ? error.stack : error);
    await this.translationService.rollbackToAwaitingReview(id).catch((err: unknown) => {
      this.logger.error(`Failed to roll back VideoJob ${id}`, err);
    });
    throw new InternalServerErrorException('Không thể bắt đầu xử lý. Vui lòng thử lại.');
  }
  return { success: true, job };
}
```
Add `rollbackToAwaitingReview(jobId)` to `translation.service.ts`: atomically flip `PROCESSING → AWAITING_REVIEW` (guarded `updateMany`, `where: { id: jobId, status: 'PROCESSING' }`) so a concurrent duplicate confirm attempt safely no-ops (sees `count === 0`).

---

## I5 — Proper HTTP status codes

**Root cause:** `translate`, `createVideoJob`, `getVideoJobs` catch every error and return `200 OK` with `{success:false}` — including `InsufficientCreditsError` (should be 402/403) and genuine 500s (DB down, etc).

**Fix:** add a small private mapper and use it in the 3 endpoints' catch blocks instead of returning a 200 body:
```typescript
private mapToHttpException(error: unknown): HttpException {
  if (error instanceof HttpException) return error;
  if (error instanceof InsufficientCreditsError) {
    return new HttpException(
      { success: false, error: error.message, code: 'INSUFFICIENT_CREDITS' },
      HttpStatus.PAYMENT_REQUIRED, // 402
    );
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  return new HttpException({ success: false, error: message }, HttpStatus.INTERNAL_SERVER_ERROR);
}
```
- `translate` (line 104-114): replace the `catch` body's `return { success:false, ... }` with `throw this.mapToHttpException(error);`.
- `createVideoJob`: already restructured under I1/I2 above to `throw this.mapToHttpException(error)`.
- `getVideoJobs` (line 257-263): replace `return { success:false, ... }` with `throw this.mapToHttpException(error);`. Note this endpoint is `@SkipThrottle()` and polled every 3s by the frontend — verify NestJS's default exception filter still returns JSON (not HTML) so the frontend's `res.json()` parse doesn't break; NestJS does this by default, no extra config needed.

**Frontend audit (R7 in plan.md):** grep `frontend/src` for consumers of these 3 endpoints and confirm each already checks `res.ok` (or catches the thrown status) rather than only branching on `data.success` at an assumed-200 response. `VideoTranslationSection.tsx` and `TranslationSection.tsx` (or equivalent) are the expected call sites — update any that assume 200.

**Verify:**
- Unit test: `createVideoJob` with insufficient credits → HTTP 402, storage key deleted, no job row leaked.
- Unit test: enqueue failure in create flow → job `FAILED`, credits refunded, storage deleted.
- Unit test: enqueue failure in confirm flow → job back to `AWAITING_REVIEW`, second confirm attempt succeeds normally.
- Unit test: `getVideoJobs` DB failure → HTTP 500, not 200.
- Manual/integration: frontend still renders the correct error toast for insufficient credits and for a simulated queue failure.
