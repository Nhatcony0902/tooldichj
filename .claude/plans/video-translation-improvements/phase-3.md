# Phase 3 — Source-Subtitle Removal (Blur + Schema + Frontend)

**Issue 3.** A user-uploaded video that already has burned-in subtitles gets new translated subtitles stacked on top. Fix: optional FFmpeg blur of the bottom 20% of each frame, user-toggled via a new checkbox.

## Goal

Add an opt-in "Xóa phụ đề gốc (nếu có)" feature: when checked AND output includes burn, the pipeline blurs the bottom 20% of the source video before burning the new subtitles.

## Files touched (6)

| File | Change |
|------|--------|
| `backend/prisma/schema.prisma` | add `removeSourceSubs Boolean @default(false)` to `VideoJob` (after `dubVoiceId`, line 78) |
| `backend/prisma/migrations/*` | NEW migration `add_remove_source_subs` (generated) |
| `backend/src/translation/dto/create-video-job.dto.ts` | add `removeSourceSubs?: string` (multipart sends strings) |
| `backend/src/translation/translation.controller.ts` | parse `removeSourceSubs` ("true"/"false") → boolean; persist on VideoJob create |
| `backend/src/translation/pipeline/burn-in.service.ts` | NEW `blurSubtitleArea()` |
| `backend/src/translation/pipeline/video-pipeline.worker.ts` | call `blurSubtitleArea` before `burnInSubtitles` when flag set |
| `frontend/src/app/components/VideoTranslationSection.tsx` | new checkbox + state + FormData append |

Ownership: `burn-in.service.ts` also Phase 2 (style const). **Phase 2 before Phase 3** (disjoint regions). All other files are Phase 3 exclusive.

## Exact changes

### 1. `schema.prisma` (after line 78 `dubVoiceId String?`)
```prisma
removeSourceSubs Boolean @default(false)
```
Then: `cd backend && npx prisma migrate dev --name add_remove_source_subs` (commit the generated migration file).

### 2. `create-video-job.dto.ts`
```typescript
export class CreateVideoJobDto {
  targetLang: string;
  outputMode?: string;
  dubVoiceId?: string;
  removeSourceSubs?: string; // multipart form field arrives as "true"/"false"
}
```

### 3. `translation.controller.ts` (`createVideoJob`)
Parse and persist when creating the `VideoJob` row:
```typescript
const removeSourceSubs = dto.removeSourceSubs === 'true';
// ...in prisma.videoJob.create({ data: { ..., removeSourceSubs } })
```
(Locate the existing `prisma.videoJob.create` / job-create call and add the field; do not invent a new create path.)

### 4. `burn-in.service.ts` — `blurSubtitleArea()`
```typescript
/**
 * Blur the bottom 20% of every frame to obscure pre-existing burned-in
 * subtitles before overlaying new ones. Opt-in (Issue 3).
 */
export function blurSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // boxblur the region y = 80%..100% of height; keep audio.
    const filter = 'boxblur=10:1:cr=0:cbr=0:y=H*0.8:h=H*0.2';
    ffmpeg(inputVideoPath)
      .outputOptions(['-vf', filter])
      .outputOptions(['-c:a', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputVideoPath);
  });
}
```
**Verify during impl:** confirm `boxblur`'s `y=`/`h=` accept the `H*0.8` expression in this fluent-ffmpeg/ffmpeg build; if `boxblur` rejects expression-based region, fall back to `crop+boxblur+overlay` filtergraph (documented fallback, not silent). Smoke on one short clip before wiring into the worker (R9).

### 5. `video-pipeline.worker.ts`
Insert before the existing `burnInSubtitles` call (currently line 150). Use `removeSourceSubs` from the loaded `videoJob` row:
```typescript
import { burnInSubtitles, blurSubtitleArea } from './burn-in.service';
// ...
let burnSource = inputPath;
if (videoJob.removeSourceSubs && outputModeIncludesBurn(outputMode)) {
  await this.updateJob(jobId, { progress: 78, stepDescription: 'Đang làm mờ phụ đề gốc...' });
  const blurredPath = path.join(tmpDir, 'blurred.mp4');
  await blurSubtitleArea(inputPath, blurredPath);
  burnSource = blurredPath;
}
await burnInSubtitles(burnSource, srtPath, burnedVideoPath); // was burnInSubtitles(inputPath, ...)
```
Note: blur applies only when burning. If `outputMode` is `srt`-only or `dub`-only (no burned video), blur is skipped (a non-burned output has no overlay to clash with).

### 6. `VideoTranslationSection.tsx`
State (after line 42):
```typescript
const [removeSourceSubsVideo, setRemoveSourceSubsVideo] = useState(false);
```
FormData (after line 120):
```typescript
formData.append("removeSourceSubs", String(removeSourceSubsVideo));
```
Checkbox UI (after the voice selector block, before submit button ~line 274), matching existing `styles.inputGroup` pattern:
```tsx
<div className={styles.inputGroup}>
  <label style={{ display: "flex", alignItems: "center", gap: "0.5rem", cursor: "pointer" }}>
    <input type="checkbox" checked={removeSourceSubsVideo}
      onChange={(e) => setRemoveSourceSubsVideo(e.target.checked)} />
    <span>Xóa phụ đề gốc (nếu có)</span>
  </label>
</div>
```

## Risk assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Blur clips important content (R4) | 2 | 2 | 4 | opt-in default off; clear label |
| Migration fails / drifts (R6) | 2 | 4 | 8 | additive nullable-default; run on dev DB; commit migration |
| 2-pass blur+burn re-encode slow/quality loss (R9) | 2 | 3 | 6 | acceptable for opt-in; smoke one clip; single-filtergraph is a future optimization (YAGNI) |
| boxblur expression unsupported by ffmpeg build | 2 | 3 | 6 | smoke first; documented crop+overlay fallback |

## Verify steps

1. `cd backend && npx prisma migrate dev --name add_remove_source_subs` → applies clean; `npx prisma generate`.
2. `cd backend && npm run build && npm test` → 0 / green.
3. `cd frontend && npm run build && npm run lint` → 0.
4. Smoke `blurSubtitleArea` on one short clip → bottom 20% blurred, audio intact, no ffmpeg error.
5. Manual end-to-end: upload a clip WITH existing subtitles, check the box, burn mode → output shows blurred original strip + new legible subtitles; uncheck → original subtitles remain (proves opt-in).
