# Phase 3 — B2: blur detection retry + fail-vs-empty distinction

Effort: **M** · Depends on: Phase 1 AND Phase 2 (shared `video-pipeline.worker.ts`)

## Goal

Retry each blur-region vision sample on transient 429 via the existing `withRetry` (instead of the bare skip), and distinguish "detection FAILED due to API error" from the legitimate "no subtitle in any frame". Record the outcome in `blurStatus`; keep the correct silent-skip for the genuine no-subtitle case; never fail the job on detection error (proceed to burn, but record the degradation).

## Files owned

- `backend/src/translation/pipeline/subtitle-region.service.ts`
- `backend/src/translation/pipeline/video-pipeline.worker.ts` (blur site ~242-264)

## Tasks

### 1. `subtitle-region.service.ts:50-72` — retry per sample + track error vs empty

Replace the bare try/catch-and-skip. Wrap each vision call in `withRetry(..., { maxAttempts: 2 })` (one retry — caps burn latency; see plan R2). Track whether any sample failed due to an API error, and short-circuit the whole loop on quota-exhaustion:

```typescript
const regions: SubtitleRegion[] = [];
let sawApiError = false;
for (let i = 0; i < timestamps.length; i += 1) {
  const framePath = path.join(tmpDir, `region-sample-${i}.jpg`);
  try {
    await extractFrame(videoPath, timestamps[i], framePath);
    const region = await withRetry(() => detectRegionInFrame(ai, framePath), { maxAttempts: 2 });
    if (region) regions.push(region);
  } catch (err) {
    if (isQuotaExhaustedError(err)) {
      // all remaining samples would fail identically — don't waste them
      sawApiError = true;
      logger.warn(`Subtitle-region detection aborted (quota exhausted) at sample ${i}: ${msg(err)}`);
      break;
    }
    if (isRateLimitError(err)) { sawApiError = true; logger.warn(`Subtitle-region sample ${i} rate-limited after retry: ${msg(err)}`); }
    else logger.warn(`Subtitle-region sample ${i} failed: ${msg(err)}`); // bad frame etc. — not an API-availability failure
  }
}
```

Change the return type so the caller can tell the two skip reasons apart. Only caller is the worker:

```typescript
export interface SubtitleRegionResult {
  region: SubtitleRegion | null;
  failedDueToError: boolean; // true = detection couldn't run (API), NOT "no subtitle present"
}
```

- Early returns (`!ai`, bad duration): `{ region: null, failedDueToError: false }` (correct legit skip; no key / unreadable video is not a transient failure to surface as blur-error — keep quiet as today). Note: `ai === null` means no `GEMINI_API_KEY`; keep `failedDueToError:false` so it stays the existing silent skip.
- `regions.length === 0`: `{ region: null, failedDueToError: sawApiError }`.
- Otherwise compute the union region as today, return `{ region, failedDueToError: false }`.

`isRateLimitError` / `isQuotaExhaustedError` are already exported from `rate-limit.util.ts` — import them; do not duplicate.

### 2. `video-pipeline.worker.ts:242-264` — set `blurStatus`, keep completing

```typescript
const { region, failedDueToError } = await detectSubtitleRegion(this.translationService.getAi(), inputPath, tmpDir);
let blurStatus: string;
if (region) {
  await this.updateJob(jobId, { progress: 90, stepDescription: 'Đang làm mờ phụ đề gốc...' });
  const blurredPath = path.join(tmpDir, 'blurred.mp4');
  await blurSubtitleArea(inputPath, blurredPath, region);
  burnSource = blurredPath;
  blurStatus = 'applied';
} else if (failedDueToError) {
  blurStatus = 'skipped_error';
  this.logger.warn(`VideoJob ${jobId}: subtitle-region detection FAILED (API), blur skipped — original subtitles NOT removed despite request`);
} else {
  blurStatus = 'skipped_no_subtitle';
  this.logger.log(`VideoJob ${jobId}: no burned-in subtitle detected, skipping blur step`);
}
await this.prisma.videoJob.update({ where: { id: jobId }, data: { blurStatus } });
```

The job continues to the burn step in all three cases (can't blur an unlocated region) — the difference is the recorded `blurStatus` + the log severity (`warn` for error vs `log` for legit skip). Do NOT touch the translate site (~128) — Phase 2 owns it.

## Verify

- `cd backend && npm run build` → 0 errors.
- `cd backend && npm test` → green.
- Unit tests per plan Test Matrix Phase 3: one-sample-429-then-success → `applied`; all-samples-429 → `skipped_error` + job completes; all `found:false` → `skipped_no_subtitle`; first quota-exhausted → loop short-circuits (samples 2,3 not called).

## Rollback

Revert `subtitle-region.service.ts` + the worker blur-site hunk (preserve Phase 2's translate-site edit).
