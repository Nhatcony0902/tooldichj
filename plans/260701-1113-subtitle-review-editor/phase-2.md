# Phase 2: Review API (fetch / save edits / confirm-resume) + Cancel-Guard Update

Effort: M · Depends on: Phase 1 (column + `AWAITING_REVIEW` status + `enqueueVideoBurnJob`) · Blocks: Phase 3

## Goal

Expose three endpoints so the frontend can fetch the editable subtitle lines, save text edits, and confirm to resume the pipeline. Widen the cancel guard to allow cancelling an `AWAITING_REVIEW` job.

## Files Owned

- `backend/src/translation/translation.service.ts` (3 new methods + cancel-guard edit)
- `backend/src/translation/translation.controller.ts` (3 new routes)
- NEW `backend/src/translation/dto/update-segments.dto.ts`

## API Contract (verbatim from plan.md — do not diverge)

| Operation | Method + Path | Body | Success | Errors |
|---|---|---|---|---|
| Fetch | `GET /translation/video-jobs/:id/segments` | none | `{ success: true, segments: [{ index, start, end, text, translatedText }] }` | 404 · 403 · 400 not-in-review |
| Save edits | `PATCH /translation/video-jobs/:id/segments` | `{ segments: [{ index, translatedText }] }` | `{ success: true }` | 404 · 403 · 400 validation |
| Confirm | `POST /translation/video-jobs/:id/confirm` | none | `{ success: true, job }` | 404 · 403 · 400 not-in-review |

All guarded by `JwtAuthGuard`; ownership via `job.userId === req.user.id`. Error style = HTTP exceptions (mirrors cancel/delete, `translation.service.ts:464-492`).

## Steps

### 1. NEW `dto/update-segments.dto.ts`

```ts
export interface SegmentEditDto {
  index: number;
  translatedText: string;
}

export interface UpdateSegmentsDto {
  segments: SegmentEditDto[];
}
```

(Plain interfaces match the project's manual-validation style — the create-video-job DTO uses plain fields, validation happens in the service. No class-validator dependency added.)

### 2. `translation.service.ts` — 3 new methods (place beside `cancelVideoJob`, ~line 464)

Imports already present: `NotFoundException`, `ForbiddenException`, `BadRequestException`. Add:
`import { parseStoredSegments, applySegmentEdits } from './pipeline/subtitle.service';`
Inject `QueueService` into the service constructor **only if not already available** — check module providers; if the DI change is non-trivial, keep the enqueue in the controller (controller already injects `queueService`, `translation.controller.ts:57`) and have `confirmVideoJob` return the transitioned job so the controller enqueues. **Preferred (KISS, avoids service DI change): enqueue in the controller**, matching the delete precedent where storage cleanup lives in the controller.

```ts
async getReviewSegments(userId: string, jobId: string) {
  const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundException('Job không tồn tại');
  if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
  if (job.status !== 'AWAITING_REVIEW') {
    throw new BadRequestException('Job chưa ở trạng thái chờ duyệt');
  }
  const segments = parseStoredSegments(job.translatedSegments).map((s, index) => ({
    index, start: s.start, end: s.end, text: s.text, translatedText: s.translatedText,
  }));
  return segments;
}

async saveReviewSegments(userId: string, jobId: string, edits: SegmentEditDto[]) {
  const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundException('Job không tồn tại');
  if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
  if (job.status !== 'AWAITING_REVIEW') {
    throw new BadRequestException('Job chưa ở trạng thái chờ duyệt');
  }
  let merged;
  try {
    const stored = parseStoredSegments(job.translatedSegments);
    merged = applySegmentEdits(stored, edits);   // throws on malformed edits (R3)
  } catch {
    throw new BadRequestException('Danh sách phụ đề không hợp lệ');
  }
  await this.prisma.videoJob.update({
    where: { id: jobId },
    data: { translatedSegments: JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue },
  });
}

// Atomic transition; returns the job so the controller can enqueue the burn phase.
async confirmVideoJob(userId: string, jobId: string) {
  const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
  if (!job) throw new NotFoundException('Job không tồn tại');
  if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
  const result = await this.prisma.videoJob.updateMany({
    where: { id: jobId, status: 'AWAITING_REVIEW' },
    data: { status: 'PROCESSING', progress: 88, stepDescription: 'Đang hoàn tất video...' },
  });
  if (result.count === 0) {
    throw new BadRequestException('Job đã được xác nhận hoặc đã thay đổi trạng thái');
  }
  return this.prisma.videoJob.findUnique({ where: { id: jobId } });
}
```

Add `Prisma` import if not present (worker uses `Prisma.InputJsonValue`; the service may need the same import).

### 3. `translation.service.ts` — widen the cancel guard

In `cancelVideoJob` (lines 468-473): add `AWAITING_REVIEW` to both the guard and the `updateMany` precondition:

```ts
if (!['PENDING', 'PROCESSING', 'AWAITING_REVIEW'].includes(job.status)) {
  throw new BadRequestException('Chỉ huỷ được job đang chờ, đang xử lý hoặc đang chờ duyệt');
}
const result = await this.prisma.videoJob.updateMany({
  where: { id: jobId, status: { in: ['PENDING', 'PROCESSING', 'AWAITING_REVIEW'] } },
  data: { status: 'CANCELLED', stepDescription: 'Đã huỷ bởi người dùng.', errorMessage: null },
});
```

No credits were deducted (deduction is Phase B only), so cancelling `AWAITING_REVIEW` is credit-safe — same as cancelling PENDING/PROCESSING.

### 4. `translation.controller.ts` — 3 routes (place beside `cancelVideoJob`, ~line 192)

```ts
@UseGuards(JwtAuthGuard)
@Get('video-jobs/:id/segments')
async getSegments(@Param('id') id: string, @Request() req: RequestWithUser) {
  const segments = await this.translationService.getReviewSegments(req.user.id, id);
  return { success: true, segments };
}

@UseGuards(JwtAuthGuard)
@Patch('video-jobs/:id/segments')
async saveSegments(
  @Param('id') id: string,
  @Body() dto: UpdateSegmentsDto,
  @Request() req: RequestWithUser,
) {
  if (!dto || !Array.isArray(dto.segments)) {
    throw new BadRequestException('Danh sách phụ đề không hợp lệ');
  }
  await this.translationService.saveReviewSegments(req.user.id, id, dto.segments);
  return { success: true };
}

@UseGuards(JwtAuthGuard)
@Post('video-jobs/:id/confirm')
async confirmJob(@Param('id') id: string, @Request() req: RequestWithUser) {
  const job = await this.translationService.confirmVideoJob(req.user.id, id);
  await this.queueService.enqueueVideoBurnJob(id);   // resume Phase B
  return { success: true, job };
}
```

- Add `Patch` to the `@nestjs/common` import block (line 1-18).
- Add `import { UpdateSegmentsDto } from './dto/update-segments.dto';`.
- `@SkipThrottle` is NOT needed here (these are user-initiated, not polled) — leave default throttling.

## Verification

```bash
cd backend && npx tsc --noEmit
cd backend && npm test
```

- Manual (owner, job in `AWAITING_REVIEW`): `GET .../segments` returns indexed segments; `PATCH` with a valid edit → 200, DB `translatedSegments` reflects new text; `PATCH` with an empty `translatedText` → 400; `POST .../confirm` → 200 + a `process-video-burn` job appears in Redis; second `confirm` → 400.
- Manual (non-owner) on all three → 403. Nonexistent id → 404.
- Manual: `POST .../cancel` on an `AWAITING_REVIEW` job → 200, status `CANCELLED`, credits unchanged.
- E2E with Phase 1: submit → edit → confirm → burn completes with the EDITED text, 10 credits deducted once.

## Risk Notes

plan.md R3 (validation gated in `applySegmentEdits` + controller array check), R6 (confirm/cancel both atomic `updateMany`), R7 (contract table embedded verbatim — Phase 2 merges before Phase 3).
