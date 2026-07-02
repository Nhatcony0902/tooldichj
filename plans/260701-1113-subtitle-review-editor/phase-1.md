# Phase 1: Schema + State Machine + Worker Split (pause after translate, resume on confirm)

Effort: L · Depends on: none · Blocks: Phase 2, Phase 3

## Goal

Persist the translated segments as editable structured data, introduce the `AWAITING_REVIEW` status, and split the single-pass worker into two BullMQ phases:

- **Phase A** (`process-video`): prep → STT → translate → **persist `translatedSegments`** → set `AWAITING_REVIEW` → return. No burn, no credit deduction.
- **Phase B** (`process-video-burn`, enqueued at confirm): rebuild SRT from the (possibly edited) stored segments → optional blur → burn-in → save video → COMPLETED + deduct 10 credits.

Region-detection + blur **stay in Phase B** (they don't depend on translated text, and keeping the whole burn block together avoids a region-persistence column and wastes no Gemini-vision calls on abandoned reviews — see plan.md Decision rationale / task item 6).

## Files Owned

- `backend/prisma/schema.prisma` + new migration
- `backend/src/translation/pipeline/subtitle.service.ts` (add validate + rebuild helpers)
- `backend/src/translation/queue.service.ts` (add burn-enqueue helper)
- `backend/src/translation/pipeline/video-pipeline.worker.ts` (split into A/B on `job.name`)
- `backend/src/translation/pipeline/video-pipeline.worker.spec.ts` (update for the branch)

## Steps

### 1. `schema.prisma` — add the editable-segments column

In `model VideoJob` (after `transcript Json?`, line ~83):

```prisma
  translatedSegments Json?   // [{ start, end, text, translatedText }] — persisted at AWAITING_REVIEW for the review/edit checkpoint
```

Update the `status` comment (line 73) to: `// PENDING, PROCESSING, AWAITING_REVIEW, COMPLETED, FAILED, CANCELLED`.

Run: `cd backend && npx prisma migrate dev --name add_translated_segments` (additive nullable → safe, no data migration).

### 2. `subtitle.service.ts` — validation + JSON round-trip helpers (SSOT for the segment shape)

`TranslatedSegment` (lines 9-11) is already JSON-serializable. Add:

```ts
// Parse/validate a stored translatedSegments JSON blob back into typed segments.
export function parseStoredSegments(value: unknown): TranslatedSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('translatedSegments is not an array');
  }
  return value.map((s, i) => {
    const seg = s as Partial<TranslatedSegment>;
    if (
      typeof seg.start !== 'number' ||
      typeof seg.end !== 'number' ||
      typeof seg.text !== 'string' ||
      typeof seg.translatedText !== 'string'
    ) {
      throw new Error(`Stored segment ${i} has an invalid shape`);
    }
    return { start: seg.start, end: seg.end, text: seg.text, translatedText: seg.translatedText };
  });
}

// Validate a user-supplied edit set against the stored segments (MVP: translatedText only).
// Returns the merged segment array (stored timing/original text preserved; only translatedText overwritten).
export function applySegmentEdits(
  stored: TranslatedSegment[],
  edits: { index: number; translatedText: string }[],
): TranslatedSegment[] {
  if (!Array.isArray(edits) || edits.length !== stored.length) {
    throw new Error('Edit set length does not match stored segments');
  }
  const merged = stored.map((s) => ({ ...s }));
  const seen = new Set<number>();
  for (const e of edits) {
    if (
      typeof e.index !== 'number' ||
      e.index < 0 ||
      e.index >= merged.length ||
      seen.has(e.index) ||
      typeof e.translatedText !== 'string' ||
      e.translatedText.trim().length === 0
    ) {
      throw new Error(`Invalid edit for segment index ${e?.index}`);
    }
    seen.add(e.index);
    merged[e.index].translatedText = e.translatedText;
  }
  return merged;
}
```

Rationale (plan.md R3): the worker and the API both go through this one helper, so a malformed edit can never reach `buildSrt`. Timing is never taken from the client (Decision 1).

### 3. `queue.service.ts` — add the Phase-B enqueue helper

```ts
async enqueueVideoBurnJob(jobId: string): Promise<void> {
  await this.queue.add(
    'process-video-burn',
    { jobId },
    { attempts: 3, backoff: { type: 'exponential', delay: 5000 }, removeOnComplete: true, removeOnFail: false },
  );
  this.logger.log(`Enqueued burn phase for video job ${jobId}`);
}
```

Same queue, distinct job **name** — the worker branches on it. (Keeps a single WorkerHost + single queue; KISS.)

### 4. `video-pipeline.worker.ts` — split `process()` on `job.name`

Refactor `process(job)` to dispatch:

```ts
async process(job: Job<VideoPipelineJobData>): Promise<void> {
  if (job.name === 'process-video-burn') {
    return this.runBurnPhase(job.data.jobId);
  }
  return this.runTranslatePhase(job.data.jobId);
}
```

**`runTranslatePhase(jobId)` (Phase A)** — the current body from line 43 down to the SRT save (line 126), but:

- Extend the early-return guard (currently only `COMPLETED`, lines 52-57): also skip when `status` ∈ {`CANCELLED`, `AWAITING_REVIEW`} (R1 — a duplicate enqueue of a job already reviewed must not re-translate).
- Keep prep → extractAudio → STT (persist `transcript`) → translate exactly as today, including all `assertNotCancelled` checkpoints.
- **Remove** the SRT build/save (lines 124-126) and the entire burn block (lines 128-182) and the completion `$transaction` (lines 186-213) from this phase.
- **Persist the translated segments and pause** instead:
  ```ts
  await this.prisma.videoJob.update({
    where: { id: jobId },
    data: {
      translatedSegments: JSON.parse(JSON.stringify(translatedSegments)) as Prisma.InputJsonValue,
    },
  });
  await this.updateJob(jobId, {
    status: 'AWAITING_REVIEW',
    progress: 85,
    stepDescription: 'Đã dịch xong — chờ bạn kiểm tra & xác nhận phụ đề.',
  });
  ```
  Then return (the `finally` still cleans `tmpDir`). No credit deduction here.

**`runBurnPhase(jobId)` (Phase B)** — a new method holding the moved burn+finalize logic:

- Reload the job; guard: if `status === 'COMPLETED'` skip; if not resumable (`translatedSegments` null) throw a clear error.
- Set `PROCESSING` (confirm endpoint already did, but keep idempotent progress update).
- `const stored = parseStoredSegments(videoJob.translatedSegments);`
- `const srtContent = buildSrt(stored);` then save to `srtKey` (moved from Phase A).
- Fresh `tmpDir`; re-read the input video from `storage.read(inputStorageKey)` to a temp path (needed for ffmpeg burn-in).
- Re-run the **existing** block verbatim: `isValidOutputMode` check → `outputModeIncludesBurn` → `removeSourceSubs` region-detect + `blurSubtitleArea` → `burnInSubtitles` → `outputModeProducesVideo` save (worker lines 128-182).
- Run the **existing** completion `$transaction` verbatim (lines 186-213): atomic `updateMany notIn [COMPLETED,CANCELLED]` → COMPLETED + `decrement: 10`. This stays the sole credit-deduction site (R2 idempotent).
- Keep `assertNotCancelled` before the heavy ffmpeg steps so a cancel during burn is honored.

`onFailed` (lines 226-253) is unchanged — its `updateMany notIn [COMPLETED,CANCELLED]` guard already covers both phases; a Phase-A failure or Phase-B failure both flip to FAILED correctly, and `JOB_CANCELLED` is still short-circuited.

### 5. `video-pipeline.worker.spec.ts`

Update any construction/branch assumptions: the spec currently covers `onFailed` only. Add a minimal branch check that `process({ name:'process-video-burn' })` routes to the burn path and `process({ name:'process-video' })` routes to translate (mock prisma to return a job in the right state). Keep it light — matches the existing spec's scope.

## Verification

```bash
cd backend && npx prisma migrate dev --name add_translated_segments
cd backend && npx tsc --noEmit
cd backend && npm test
```

- Unit: `parseStoredSegments` + `applySegmentEdits` reject malformed input; a valid round-trip (persist → `parseStoredSegments` → `buildSrt`) equals building from the original in-memory array.
- Manual: submit a job → confirm it halts at `AWAITING_REVIEW` with `translatedSegments` populated, `subtitlesUrl`/`outputVideoUrl` still null, credits unchanged. Manually enqueue a `process-video-burn` job (or wait for Phase 2's confirm endpoint) → job completes, burns the stored text, deducts exactly 10 credits.

## Risk Notes

plan.md R1 (Phase-A re-run guard), R2 (Phase-B retry idempotency via the existing completion transaction), R3 (validation helper is the single gate), R4 (drain queue before deploy).
