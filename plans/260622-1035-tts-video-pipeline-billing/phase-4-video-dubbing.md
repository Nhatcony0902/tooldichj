# Phase 4 — Video Dubbing Integration

**Effort:** L | **Blocked by:** Phase 2 AND Phase 3 | **Blocks:** none

## Goal

Generate a TTS voice-over track from the translated subtitles (Phase 3 TTS) and mix/replace it into the final output video via ffmpeg, as an alternative/companion to hardsub. User picks the dubbing voice in the video tab — first-class option, not a default.

## Scope & file ownership

- `backend/src/translation/pipeline/dubbing.service.ts` (NEW) — for each translated segment, call `TtsService.synthesize(segmentText, voiceId)` (reuses Phase 3 cache), time-align clips to segment start times (pad/trim silence), concatenate into one voice-over track, then ffmpeg-mux: replace or duck the original audio. Output saved via storage (`dubbedVideoKey`).
- `backend/src/translation/queue.service.ts` — extend the pipeline: when job's `outputMode` includes `dub`, run dubbing after burn-in (or instead of, per mode). Add progress steps.
- `backend/src/translation/dto/create-video-job.dto.ts` — add `outputMode` enum (`srt` | `hardsub` | `dub` | `hardsub+dub`) and `dubVoiceId String?`. This wires the frontend's currently-dead "output format" select.
- `backend/prisma/schema.prisma` — add `outputMode String`, `dubVoiceId String?`, `dubbedVideoKey String?` to `VideoJob`. Migration.
- `frontend/src/app/page.tsx` — video tab: make the existing "output format" select real (srt-only / hardsub / dub / both); when dub is chosen, show the voice picker (shared component from Phase 3); download links for each produced output.

## Reuse / contract

- Voice picker UI = the SAME component built in Phase 3 (DRY — extract to a shared component in Phase 3, consume here).
- TTS synth + cache = Phase 3 `TtsService` (no second TTS path).
- The `outputMode` enum is the integration **contract** between frontend select and backend pipeline — define it once in a shared constant referenced by both (per `contract-first-integration.md`).

## Timing challenge

Segment durations from TTS rarely match source segment durations. Strategy: pad short clips with silence to fit the slot; for overruns, allow slight slot overlap or speed-adjust (atempo) within a bounded range. Document the chosen approach; surface a warning if drift is large.

## Verification

- Job with `outputMode=dub` produces an mp4 whose audio is the TTS voice-over in the target language, roughly time-aligned.
- `outputMode=hardsub+dub` produces a video with both burned subs and dubbed audio.
- Changing `dubVoiceId` changes the voice in the output.
- A repeated dub of identical text+voice hits TtsCache (no extra Gemini billing).

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Voice-over drifts out of sync over long video | 4 | 3 | 12 | per-segment slot alignment + bounded atempo; surface drift warning |
| ffmpeg mux/concat complexity (filtergraph errors) | 3 | 3 | 9 | build filtergraph incrementally; unit-test on a 10s clip first |
| Dubbing multiplies Gemini TTS cost | 3 | 3 | 9 | TtsCache reuse; deduct credits per synth-miss; show cost estimate before job |

## Rollback

Additive pipeline branch gated by `outputMode`; default mode stays `hardsub` (Phase 2 behavior). Revert phase commit + down-migration.
