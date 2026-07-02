# Phase 1: Remove Video-Dub Feature (Backend + DB + Frontend Dead Code)

Effort: M · Depends on: none · Blocks: Phase 2

## Goal

Delete the video-dubbing (TTS voice-over) feature end-to-end: output modes `dub`/`burn+dub`, the mux-mixing that ducked original audio to 50%, the `dubVoiceId` field (DTO + DB column), and all now-dead frontend code. Standalone text-to-speech (`VoiceSelector.tsx`, `tts.service.ts`, `tts.controller.ts`) is untouched — it backs a separate feature.

## Files Owned

- `backend/src/translation/pipeline/output-mode.ts`
- `backend/src/translation/translation.controller.ts`
- `backend/src/translation/translation.service.ts`
- `backend/src/translation/pipeline/video-pipeline.worker.ts`
- `backend/src/translation/pipeline/video-pipeline.worker.spec.ts`
- `backend/src/translation/pipeline/dubbing.service.ts` — **DELETE**
- `backend/src/translation/pipeline/mux.service.ts` — **DELETE**
- `backend/src/translation/dto/create-video-job.dto.ts`
- `backend/src/tts/voices.config.ts`
- `backend/prisma/schema.prisma` + new migration
- `frontend/src/app/components/VideoTranslationSection.tsx`

## Steps

1. **`output-mode.ts`** — shrink `OUTPUT_MODES` to `['srt', 'burn'] as const`. Delete `outputModeIncludesDub`. Simplify `outputModeIncludesBurn` to `mode === 'burn'`.

2. **`translation.controller.ts`**
   - Remove the `outputModeIncludesDub` import (line 35) and the `isValidVoiceId` import (line 37, now unused here — it's still imported/used in `tts.controller.ts`/`tts.service.ts`, don't touch those).
   - Delete the `if (outputModeIncludesDub(outputMode)) { ... }` validation block (lines 154-160).
   - Change `dubVoiceId: outputModeIncludesDub(outputMode) ? dto.dubVoiceId : null,` (line 176) → delete the line entirely (field removed from `createVideoJob` params).

3. **`translation.service.ts`**
   - Remove `dubVoiceId?: string | null;` from `CreateVideoJobParams` (line 14).
   - Update the destructure at line 423: `const { fileName, inputStorageKey, targetLang, outputMode, removeSourceSubs } = params;`
   - Remove `dubVoiceId: dubVoiceId || null,` from the `prisma.videoJob.create` data block (line 445).

4. **`video-pipeline.worker.ts`**
   - Remove imports: `TtsService` (line 15), `DEFAULT_VOICE_ID` (line 16), `buildDubbingTrack` (line 21), `muxVideoWithAudio, muxVideoWithMixedAudio` (line 22), `outputModeIncludesDub` (line 26).
   - Remove `private readonly ttsService: TtsService,` constructor param (line 42).
   - Delete the entire `if (outputModeIncludesDub(outputMode)) { ... }` block (lines 170-217), including the `dubFailedReason` variable and its use in the completion-message branch (lines 225-231) — video jobs no longer have a "dub failed, burn-only delivered" path since dub no longer exists; collapse `completionMessage` to just the `driftWarning`/default branches minus the `dubFailedReason` arm. **Check:** `driftWarning` was only ever set inside the deleted dub block (line 186) — remove that variable too and its branch (lines 232-234), since drift is a dub-only concept (TTS audio drift vs. segment timing). Final `completionMessage` logic becomes a single unconditional string.

5. **`video-pipeline.worker.spec.ts`** — update `buildWorker()`: remove the `{} as any, // ttsService — unused by onFailed` argument from the `new VideoPipelineWorker(...)` call (now 3 args instead of 4).

6. **`dto/create-video-job.dto.ts`** — remove `dubVoiceId?: string;`.

7. **`tts/voices.config.ts`** — remove `export const DEFAULT_VOICE_ID = 'vi-VN-HoaiMyNeural';` (zero remaining references after step 4).

8. **`schema.prisma`** — remove `dubVoiceId String?` from `model VideoJob`; update the `outputMode` field comment from `// srt | burn | dub | burn+dub` to `// srt | burn`. Run `npx prisma migrate dev --name drop_dub_voice_id` to generate the migration (drops the column).

9. **`VideoTranslationSection.tsx`**
   - Remove `dubVoiceIdVideo` state (line 42) and `setDubVoiceIdVideo`.
   - Remove the `if (outputModeVideo === "dub" || outputModeVideo === "burn+dub") { formData.append("dubVoiceId", dubVoiceIdVideo); }` block (lines 119-121).
   - Remove the `{(outputModeVideo === "dub" || outputModeVideo === "burn+dub") && (...)}` JSX block (lines 302-313) that renders `VoiceSelector` for video dubbing.
   - Remove the now-unused `VoiceSelector` import if this was its only use in the file (verify: `VoiceSelector` is also imported by `TextTranslationSection.tsx` — that's a separate file/import, unaffected).
   - Leave the "Làm mờ phụ đề cứng có sẵn trong video" checkbox and `removeSourceSubsVideo` state exactly as-is (Phase 2 reuses them unchanged).

## Verification

```bash
cd backend && npx tsc --noEmit
cd backend && npm test
cd backend && npx prisma migrate dev --name drop_dub_voice_id
cd frontend && npm run lint
```

- Grep sweep to confirm zero remaining references: `grep -rn "dubVoiceId\|outputModeIncludesDub\|buildDubbingTrack\|muxVideoWith\|DEFAULT_VOICE_ID" backend/src frontend/src` → no hits.
- Manual: submit a video job from the UI, confirm only `burn`/`srt` are selectable, and the completed output's audio track is bit-identical in volume to the source (no `volume`/`amix` ffmpeg filter was ever applied for `burn` mode — this was already true before this phase, this step just confirms no regression).

## Risk Notes

See plan.md R1 (dropped column loses historical dub-job metadata — accepted, feature never reached production users) and R2 (ctor DI change — no module wiring needed, confirmed via grep that `ttsService` had exactly one consumer in this file).
