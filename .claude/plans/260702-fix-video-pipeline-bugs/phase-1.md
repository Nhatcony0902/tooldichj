# Phase 1: Money-Safety — Cancel Guard (C1) + Credit Reservation (C2)

**Files owned:** `backend/src/translation/pipeline/video-pipeline.worker.ts`, `backend/src/translation/translation.service.ts`, `backend/src/credit/credit.service.ts`

**Priority:** Highest — both bugs are user-reachable and touch real money.

---

## C1 — Cancel guard in `runBurnPhase`

**Root cause:** `video-pipeline.worker.ts:195` unconditionally sets `status: 'PROCESSING'` with no check for `CANCELLED`. `assertNotCancelled` at line 205 runs *after* this overwrite, so a job cancelled mid-burn gets resurrected to `PROCESSING`, completes, and charges the user.

**Fix:**
1. At the top of `runBurnPhase`, immediately after the `videoJob` null-check (before the `status === 'COMPLETED'` early-return at line 178), add:
   ```typescript
   if (videoJob.status === 'CANCELLED') {
     this.logger.log(`VideoJob ${jobId} is CANCELLED, skipping burn phase`);
     return;
   }
   ```
2. Change the `updateJob` call at line 195 from an unconditional update to a guarded one — reuse the `assertNotCancelled` check but move it BEFORE the status overwrite, not after:
   ```typescript
   await this.assertNotCancelled(jobId);
   await this.updateJob(jobId, {
     status: 'PROCESSING',
     progress: 86,
     stepDescription: 'Đang chuẩn bị chèn phụ đề...',
   });
   ```
   (i.e. move the existing `await this.assertNotCancelled(jobId);` from line 205 to immediately before line 195's `updateJob` call.)
3. Keep the existing `assertNotCancelled` calls elsewhere in the method (line 258) — they still protect later steps.

**Verify:** new unit test — create a job in `AWAITING_REVIEW`, confirm it (→ `PROCESSING`), simulate `cancelVideoJob` flipping it to `CANCELLED` before the worker's `runBurnPhase` executes, assert the job ends `CANCELLED` (not `COMPLETED`) and `credits` is not decremented.

---

## C2 — Credit reservation

**Root cause:** `createVideoJob` (`translation.service.ts:420-435`) only reads `user.credits < 10` — no reservation. The actual charge happens later, once, in the completion transaction (`video-pipeline.worker.ts:301-304`). Between check and charge, nothing stops the same user from creating multiple jobs against the same balance.

### Step 1 — `credit.service.ts`: add `reserveCredit` + `refundCredit`

```typescript
async reserveCredit(userId: string, amount: number): Promise<void> {
  const result = await this.prisma.user.updateMany({
    where: { id: userId, credits: { gte: amount } },
    data: { credits: { decrement: amount } },
  });
  if (result.count === 0) {
    throw new InsufficientCreditsError(
      `Tài khoản cần có ít nhất ${amount} credits để thực hiện thao tác này!`,
    );
  }
  this.logger.log(`Reserved ${amount} credit(s) for user: ${userId}`);
}

async refundCredit(userId: string, amount: number): Promise<void> {
  try {
    await this.prisma.user.update({
      where: { id: userId },
      data: { credits: { increment: amount } },
    });
    this.logger.log(`Refunded ${amount} credit(s) to user: ${userId}`);
  } catch (err) {
    this.logger.error(`Failed to refund credits for user ${userId}:`, err);
  }
}
```
Import `InsufficientCreditsError` from `../credit/insufficient-credits.error`.

### Step 2 — `translation.service.ts`: `createVideoJob` reserves atomically with the insert

Replace the separate `findUnique` + `credits < 10` check + `prisma.videoJob.create` with a transaction:
```typescript
async createVideoJob(userId: string, params: CreateVideoJobParams) {
  const { fileName, inputStorageKey, targetLang, outputMode, removeSourceSubs } = params;
  const VIDEO_JOB_COST = 10;

  return this.prisma.$transaction(async (tx) => {
    const result = await tx.user.updateMany({
      where: { id: userId, credits: { gte: VIDEO_JOB_COST } },
      data: { credits: { decrement: VIDEO_JOB_COST } },
    });
    if (result.count === 0) {
      throw new InsufficientCreditsError(
        'Tài khoản cần có ít nhất 10 credits để thực hiện dịch video!',
      );
    }
    return tx.videoJob.create({
      data: {
        fileName, inputStorageKey, targetLang, outputMode,
        removeSourceSubs: removeSourceSubs ?? false,
        status: 'PENDING', progress: 0,
        stepDescription: 'Đang xếp hàng chờ xử lý...',
        userId,
      },
    });
  });
}
```
(Inline the reserve here rather than calling `creditService.reserveCredit` — the reserve and job-create must be in the SAME `$transaction` for atomicity; `creditService` is not injected with `tx`. Keep `creditService.reserveCredit`/`refundCredit` available for the non-transactional call sites below.)

### Step 3 — `cancelVideoJob` refunds on the SAME atomic guard that flips status

```typescript
async cancelVideoJob(userId: string, jobId: string) {
  const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundException('Job không tồn tại');
  if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
  if (!['PENDING', 'PROCESSING', 'AWAITING_REVIEW'].includes(job.status)) {
    throw new BadRequestException('Chỉ huỷ được job đang chờ, đang xử lý hoặc đang chờ duyệt');
  }
  const result = await this.prisma.videoJob.updateMany({
    where: { id: jobId, status: { in: ['PENDING', 'PROCESSING', 'AWAITING_REVIEW'] } },
    data: { status: 'CANCELLED', stepDescription: 'Đã huỷ bởi người dùng.', errorMessage: null },
  });
  if (result.count === 0) {
    throw new BadRequestException('Job đã hoàn tất hoặc đã thay đổi trạng thái, không thể huỷ');
  }
  await this.creditService.refundCredit(userId, 10); // exactly-once: only reached when updateMany actually flipped status
  return this.prisma.videoJob.findUnique({ where: { id: jobId } });
}
```

### Step 4 — `video-pipeline.worker.ts`: `onFailed` refunds on permanent failure

The existing `updateMany` guard (`where: { id, status: { notIn: ['COMPLETED', 'CANCELLED'] } }`, line 339) already gives exactly-once semantics for the FAILED transition. After that update, check `result.count > 0` and refund:
```typescript
const result = await this.prisma.videoJob.updateMany({
  where: { id: job.data.jobId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
  data: { status: 'FAILED', errorMessage: friendlyMessage },
});
if (result.count > 0) {
  await this.translationService.refundVideoJobCredits(job.data.jobId); // or inject CreditService directly + look up userId
}
```
Need `videoJob.userId` for the refund — either select it in the same query beforehand (read `userId` via a preceding `findUnique`, already available as `job` isn't loaded here — add a `select: { userId: true }` read before the `updateMany`, matching the existing pattern in `runTranslatePhase`) or inject `CreditService` into the worker (it already injects `TranslationService`, `PrismaService`, `STORAGE_PROVIDER` — add `CreditService` the same way).

### Step 5 — `video-pipeline.worker.ts`: stop charging at completion

Remove the `tx.user.update({ data: { credits: { decrement: 10 } } })` call from the completion `$transaction` (lines 301-304) — the charge already happened at creation. Keep the rest of the transaction (the `updateMany` double-processing guard) unchanged; it now only flips status, no credit side-effect.

### Step 6 — Deploy note (R3 from plan.md)

Document in the PR description: jobs already in a non-terminal state (`PENDING`/`PROCESSING`/`AWAITING_REVIEW`) at deploy time were NOT charged at creation under the old code path. They will complete without a charge under the new code (harmless one-off — do not attempt a retroactive charge, which would risk double-charging jobs created moments before deploy).

**Verify:**
- Unit test: 2 concurrent `createVideoJob` with user balance = 10 → exactly 1 succeeds, other throws `InsufficientCreditsError`, final balance = 0.
- Unit test: cancel a `PROCESSING` job → credits refunded exactly once, balance restored.
- Unit test: permanent failure → credits refunded exactly once.
- Unit test (R2 gate): simulate cancel and permanent-failure racing for the same job (both call their respective `updateMany` against a job already in a terminal state from the other path) → assert refund fires exactly once total, not twice.
