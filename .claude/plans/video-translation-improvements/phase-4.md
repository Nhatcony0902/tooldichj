# Phase 4 — TTS / Dub Fix

**Issue 4.** Dub mode reported broken. **Verified root-cause refinement:** `tts.service.ts:209-215` CATCHES the Gemini TTS error and returns **mock (silent) audio** with `isMock: true` instead of propagating. So the symptom is NOT a visible crash — it is either silent/garbled dub output, or a real error masked into a 0.3s silent clip per segment. The TRUE cause is hidden. This phase de-swallows first, then fixes.

## Goal

Make dub mode produce real spoken audio. When it genuinely fails, surface the actual error in the job's `errorMessage` instead of silently substituting mock audio.

## HIGH-RISK GATE — do these FIRST, in order (R2, R3)

1. **De-swallow the error (R3, score 16).** Before any other change, stop masking the real failure. In `callGeminiTts`, on a NON-rate-limit error, RE-THROW (or surface) instead of returning mock. Keep mock ONLY for the missing-API-key case (line 183-188), which is intentional. This makes the actual cause visible — you cannot fix what is hidden.
2. **Verify the model name (R2, score 15).** Confirm `TTS_MODEL = 'gemini-2.5-flash-preview-tts'` (`voices.config.ts:5`) is still a valid Gemini model. Use Context7 / official Gemini docs (per MCP guidance). If renamed/deprecated, update the constant to the current TTS model ID. Do this BEFORE assuming the cause is rate-limit.
3. Only AFTER 1 & 2: apply the per-segment delay (below). The 429-cascade is one plausible cause but must not be assumed before the real error is visible.

## Files touched

| File | Change |
|------|--------|
| `backend/src/tts/tts.service.ts` | de-swallow non-429 errors; better logging; (verify model) |
| `backend/src/tts/voices.config.ts` | update `TTS_MODEL` only if verification shows it changed |
| `backend/src/translation/pipeline/dubbing.service.ts` | per-segment 4.2s delay + `withRetry` around `ttsService.synthesize()` (reuse Phase 1 util) |
| `backend/src/translation/pipeline/video-pipeline.worker.ts` | surface real dub error into `errorMessage` (refine `onFailed` / job error path) |

Ownership: all Phase 4 exclusive EXCEPT it imports `rate-limit.util.ts` from Phase 1 (`withRetry`, `sleep`, `GEMINI_FREE_RPM_DELAY_MS`). **Blocked by Phase 1** (util must exist). Can run in parallel with Phase 2/3 otherwise.

## Exact changes

### 1. `tts.service.ts` — de-swallow (R3)
Current `callGeminiTts` catch (lines 209-215) returns mock on ANY error. Change to:
```typescript
} catch (err) {
  if (isRateLimitError(err)) throw err; // let withRetry handle 429 upstream
  this.logger.error(
    'Gemini TTS call failed',
    err instanceof Error ? err.message : err,
  );
  throw err instanceof Error ? err : new Error(String(err)); // surface, don't mask
}
```
Keep the missing-key mock path (lines 183-188) as-is — that is the documented, intentional no-key fallback. Import `isRateLimitError` from `../translation/pipeline/rate-limit.util` (or relocate the util to a neutral shared dir if the import direction is awkward — note in commit; prefer keeping SSOT over duplicating).

### 2. `voices.config.ts` — model name (R2)
Only if Phase-4 step 2 verification shows the model changed:
```typescript
export const TTS_MODEL = '<verified-current-tts-model-id>';
```
If unchanged, leave it and record "verified valid on 2026-06-28" in the commit message.

### 3. `dubbing.service.ts` — per-segment delay + retry (reuse Phase 1)
In `buildDubbingTrack`, wrap the `ttsService.synthesize` call (lines 72-77) and add a delay between iterations:
```typescript
import { GEMINI_FREE_RPM_DELAY_MS, sleep, withRetry } from './rate-limit.util';
// ...
const { audioBuffer } = await withRetry(() =>
  ttsService.synthesize(userId, segment.translatedText, voiceId, false),
);
// ...after pushing the clip, before next iteration:
if (i < orderedSegments.length - 1) await sleep(GEMINI_FREE_RPM_DELAY_MS);
```
Note: silence-only slots (lines 59-67) `continue` without a TTS call — no delay needed there (don't pay the 4.2s tax on a slot that never hit the API).

### 4. `video-pipeline.worker.ts` — surface real dub error
The `onFailed` handler (lines 232-262) currently writes a generic Vietnamese message and deliberately hides paths. Keep hiding filesystem paths, but include a sanitized cause for dub failures so the user/support sees WHY (e.g. "Lỗi tạo lồng tiếng: <model/quota cause>"). Map known causes (rate-limit, invalid model, no audio data) to friendly Vietnamese; fall back to the generic message for unknown errors. Do NOT leak absolute paths (existing security note, line 253-254, still holds).

## Risk assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Model renamed, can't auto-fix (R2) | 3 | 5 | **15 HIGH** | verify via docs BEFORE coding (gate step 2) |
| Swallowed error → fixing wrong thing (R3) | 4 | 4 | **16 HIGH** | de-swallow FIRST (gate step 1) |
| Delay slows dub (same as R1) | 5 | 2 | 10 | progress "Đang tạo lồng tiếng... (X/Y)" |
| De-swallow now hard-fails jobs that previously "succeeded" with silent audio | 3 | 3 | 9 | intended — a silently-mock dub WAS a failure; surfacing it is the fix, not a regression. Document in commit. |

## Verify steps

1. Model verification recorded (docs link + date) BEFORE other changes.
2. `cd backend && npm run build` → 0.
3. Unit: `callGeminiTts` non-429 error now throws (no mock); missing-key still returns mock.
4. `cd backend && npm test` → green (update any test that asserted the old swallow behavior).
5. Manual: run a dub job end-to-end with a valid GEMINI_API_KEY → output video has REAL spoken Vietnamese audio (not 0.3s silence per segment).
6. Manual failure path: force a TTS error (bad model id) → job goes FAILED with a clear Vietnamese `errorMessage` naming the cause, no absolute paths leaked.
