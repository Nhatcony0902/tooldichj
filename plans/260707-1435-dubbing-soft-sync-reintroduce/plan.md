# Plan: Triển khai lại lồng tiếng (video dubbing) — hướng "sync mềm"

Created: 2026-07-07 (260707-1435)
Branch hiện tại: `fix-subtitle-cover-original`

## Bối cảnh

Tính năng dub từng bị **xóa hoàn toàn** ở commit `09384d2` (xóa `dubbing.service.ts` + `mux.service.ts`, gỡ mode `dub`/`burn+dub` khỏi `output-mode.ts`, drop cột `dubVoiceId`, gỡ dead code frontend). Lý do xóa: giọng lồng **rời rạc/đứt đoạn** + tưởng không có TTS free tốt.

Nay làm lại vì đã xác định:
1. **Edge TTS** (`msedge-tts`) trong `tts.service.ts` **miễn phí + chất lượng tốt** (giọng Neural `vi-VN-HoaiMyNeural`, `vi-VN-NamMinhNeural`) — vẫn đang chạy cho feature TTS độc lập, tái dùng được ngay.
2. Nguyên nhân "rời rạc" là **thuật toán ép câu dịch khít khe thời gian gốc**, không phải TTS. Bản cũ dùng `atempo` tua tới 2.0x + pad silence đuôi + chèn silence theo gap gốc + concat `-c copy` hard-cut.

## Quyết định đã chốt (KHÔNG hỏi lại)

1. **Output mode khôi phục:** cả `dub` VÀ `burn+dub`.
2. **Mux audio:** giữ tiếng gốc ~50% (`volume=0.5`) + trộn tiếng lồng 100% qua ffmpeg `amix` — như plan mixed-audio 260630 đã đề xuất.
3. **Giọng đọc:** dùng **1 giọng mặc định cố định** (`vi-VN-HoaiMyNeural`). KHÔNG khôi phục cột `dubVoiceId`, KHÔNG thêm dropdown chọn giọng ở tab video → **không cần migration DB**.
4. **Sync mềm (cốt lõi hướng A):**
   - TTS từng câu qua `TtsService.synthesize(userId, text, DEFAULT_VOICE_ID, false)` (chargeCredit=false, tái dùng cache + withRetry như bản cũ).
   - BỎ `atempo` 2.0x → chỉ co giãn NHẸ khi câu tràn khe: `ratio = min(1.15, actual/target)`, chỉ áp dụng khi `actual > target * 1.15`; còn lại giữ tốc độ tự nhiên, cho phép tràn khe.
   - BỎ pad silence đuôi cho câu ngắn.
   - Neo mốc **bắt đầu** mỗi segment bằng silence gap giữa các clip; nếu clip trước tràn qua mốc start của clip sau thì nối liền (không chèn silence âm), clip sau bắt ngay sau clip trước.
   - Nối các mảnh bằng **crossfade nhẹ** (re-encode, không `-c copy`) để không click/cụp ở mối nối.
5. **Credit:** giữ nguyên flat 10 credit charge tại lúc tạo job; dub TTS không tính phí riêng (chargeCredit=false).

## Verified Codebase Facts (ground truth 2026-07-07)

| Fact | Location | Note |
|------|----------|------|
| `OUTPUT_MODES = ['srt','burn']` hiện tại | `output-mode.ts:4` | cần thêm `'dub'`, `'burn+dub'` |
| Predicate `outputModeIncludesBurn` / `outputModeProducesVideo` | `output-mode.ts:11-17` | cần thêm `outputModeIncludesDub` |
| Worker 2-phase: A=translate→AWAITING_REVIEW, B=burn→COMPLETED | `video-pipeline.worker.ts:48-53` | dub wiring nằm trong Phase B (`runBurnPhase`) |
| Điểm chèn dub: sau burn, trước khi save video | `video-pipeline.worker.ts:311-317` | mux dub track vào `videoStreamSourcePath` |
| `outputAudioUrl` column VẪN CÒN trong schema | `schema.prisma:83` | tái dùng để lưu track dub — KHÔNG cần migration |
| Worker hiện set `outputAudioUrl: null` | `video-pipeline.worker.ts:332` | set thành key dub khi có dub |
| `TtsService.synthesize(userId, text, voiceId, chargeCredit)` | `tts.service.ts:35-66` | tái dùng nguyên; `chargeCredit=false` cho dub |
| `TtsService.makeSilence(durationSec)` đã có sẵn | `tts.service.ts:184-206` | tái dùng render silence gap (đừng viết lại) |
| `getAudioDuration(path)` dùng chung được | `audio-extractor.ts:20-28` | đo độ dài clip TTS |
| `withRetry` cho rate-limit | `rate-limit.util.ts` | bọc mỗi call TTS |
| `DEFAULT_VOICE_ID` đã bị xóa | `voices.config.ts` (grep negative) | cần thêm lại export `DEFAULT_VOICE_ID = 'vi-VN-HoaiMyNeural'` |
| `TranslatedSegment` shape `{ start, end, text, translatedText }` | `subtitle.service.ts` | input cho dubbing track |
| `parseStoredSegments` trả segments đã review | `subtitle.service.ts`, dùng `worker:228` | nguồn segment cho dub (đã qua review/edit) |
| Frontend select chỉ có `burn`/`srt` | `VideoTranslationSection.tsx:374-375` | thêm 2 option `dub`/`burn+dub` |
| `outputModeVideo` state default `"burn"` | `VideoTranslationSection.tsx:34` | không đổi default |
| DTO `outputMode?: string` | `dto/create-video-job.dto.ts` | không đổi (validate ở `isValidOutputMode`) |
| DubbingService cũ (tham khảo thuật toán) | git `09384d2~1:.../dubbing.service.ts` | dùng làm base, sửa theo sync mềm |
| Worker spec dựng bằng `({} as any)` | `video-pipeline.worker.spec.ts` | ctor thêm `ttsService` → cập nhật spec |

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Backend: soft-sync dubbing + mux + restore modes + wire worker | `output-mode.ts`, NEW `dubbing.service.ts`, NEW `mux.service.ts`, `video-pipeline.worker.ts`, `video-pipeline.worker.spec.ts`, `tts/voices.config.ts`, `translation.module.ts` (DI nếu cần) | M |
| 2 | Frontend: khôi phục option `dub`/`burn+dub` + hiển thị/tải track | `VideoTranslationSection.tsx` | S |

Sequential: Phase 1 trước Phase 2 (frontend chỉ gửi được mode mới sau khi backend chấp nhận nó qua `isValidOutputMode`).

---

### Phase 1: Backend soft-sync dubbing (Effort: M)

**1a. `output-mode.ts`** — thêm mode:
- `OUTPUT_MODES = ['srt', 'burn', 'dub', 'burn+dub']`
- thêm `outputModeIncludesDub(mode) => mode === 'dub' || mode === 'burn+dub'`
- `outputModeIncludesBurn`: `mode === 'burn' || mode === 'burn+dub'`
- `outputModeProducesVideo`: `mode !== 'srt'` (đã đúng — `dub` cũng ra video)

**1b. `tts/voices.config.ts`** — thêm lại `export const DEFAULT_VOICE_ID = 'vi-VN-HoaiMyNeural';`

**1c. NEW `dubbing.service.ts`** — `buildDubbingTrack(ttsService, userId, segments, voiceId, tmpDir): Promise<{ audioPath: string; driftSeconds: number }>`
- Sort segments theo `start`, clamp `end >= start` (giữ guard bản cũ chống desync).
- Với mỗi segment:
  - Gap tới `cursor` > 0.05s → chèn silence (`ttsService.makeSilence`).
  - `translatedText` rỗng → silence đúng `targetDuration`, `cursor = end`, continue.
  - TTS qua `withRetry(() => ttsService.synthesize(userId, text, voiceId, false))`; segment lỗi → silence + warn (không abort cả job).
  - Đo `actualDuration`. **Soft-fit:**
    - `actual > target * 1.15` → `atempo(min(1.15, actual/target))`; cộng phần vẫn tràn vào `driftSeconds`.
    - còn lại → giữ nguyên clip (KHÔNG pad đuôi, KHÔNG tua).
  - `cursor = max(segment.end, cursor + actualClipDuration)` — nếu clip tràn thì đẩy cursor theo clip thật (clip sau nối liền, không chèn silence âm).
- Nối mảnh bằng **crossfade nhẹ** (~30-50ms) re-encode `libmp3lame` thay vì concat `-c copy` → hết click/cụp ở mối nối.

**1d. NEW `mux.service.ts`** — `muxVideoWithMixedAudio(videoPath, dubPath, outputPath, origVolumeRatio = 0.5)`:
- filter: `[0:a]volume=0.5[orig];[orig][1:a]amix=inputs=2:duration=first[mix]`
- map: `-map 0:v:0 -map [mix] -c:v copy -c:a aac -b:a 192k`
- Guard: video không có audio stream → fallback map dub track thẳng (`-map 0:v:0 -map 1:a`).

**1e. `video-pipeline.worker.ts`** — DI thêm `TtsService`; trong `runBurnPhase` sau khối burn (dòng ~311), trước save video:
- `if (outputModeIncludesDub(outputMode))`:
  - progress ~94, step "Đang tạo lồng tiếng...".
  - `buildDubbingTrack(this.ttsService, videoJob.userId, stored, DEFAULT_VOICE_ID, tmpDir)`.
  - `muxVideoWithMixedAudio(videoStreamSourcePath, dubPath, dubbedPath)` → `videoStreamSourcePath = dubbedPath`.
  - lưu dub mp3 vào `outputs/${jobId}/audio.mp3` → set `outputAudioUrl` (thay `null` dòng 332).
- `assertNotCancelled` trước bước dub (mẫu C1 sẵn có).

**1f. `video-pipeline.worker.spec.ts`** — cập nhật ctor: truyền TtsService mock (`({} as any)` hoặc mock synthesize).

**Verify Phase 1:**
- `cd backend && npx tsc --noEmit` → 0 lỗi.
- `cd backend && npm test` → suite xanh.
- unit: `isValidOutputMode('dub')` & `('burn+dub')` → `true`; `outputModeIncludesDub` đúng.
- **Manual smoke (bắt buộc):** 1 video ngắn mode `dub` → output có tiếng gốc nhỏ + tiếng Việt to, nghe **liền mạch** (không giật tốc độ, không lặng cụt giữa câu).

---

### Phase 2: Frontend khôi phục option (Effort: S)

**`VideoTranslationSection.tsx`** — thêm vào `<select>` (dòng 374-375):
- `<option value="dub">Lồng tiếng (giữ tiếng gốc nhỏ)</option>`
- `<option value="burn+dub">Chèn sub + Lồng tiếng</option>`
- Không thêm VoiceSelector (giọng cố định). Nếu job có `outputAudioUrl`, hiển thị nút tải/nghe track (tái dùng UI download hiện có nếu có).

**Verify Phase 2:**
- `cd frontend && npm run lint` → 0 lỗi.
- Manual: chọn `dub`/`burn+dub`, submit → job chạy, video có lồng tiếng.

---

## File Ownership Map

| File | Phase | Conflict |
|------|-------|----------|
| `output-mode.ts` | 1 | none |
| NEW `dubbing.service.ts`, `mux.service.ts` | 1 | none (file mới) |
| `video-pipeline.worker.ts` + spec | 1 | none |
| `tts/voices.config.ts` | 1 | none |
| `VideoTranslationSection.tsx` | 2 | none |

Không file nào bị 2 phase đụng → Phase 1 và 2 tách bạch, chỉ ràng buộc thứ tự logic (backend nhận mode trước).

## Risk Assessment

| # | Risk | L | I | Score | Mitigation |
|---|------|---|---|-------|------------|
| R1 | Video dài → nhiều call Edge TTS tuần tự, chậm | 3 | 3 | 9 | Cache `ttsCache` sẵn có; `withRetry` cho rate-limit; concurrency worker=2 đã có; segment lỗi → silence, không abort |
| R2 | Edge TTS WebSocket drop 0 byte (đã biết) | 2 | 3 | 6 | `callEdgeTts` đã throw khi 0 byte + `withRetry`; per-segment try/catch → silence fallback |
| R3 | `amix` clipping khi cộng 2 track | 2 | 2 | 4 | ffmpeg `amix` mặc định `normalize` giảm gain; nếu vỡ tiếng thêm `weights=1 0.5` |
| R4 | Video không có audio stream → `[0:a]` fail | 2 | 3 | 6 | Guard trong `muxVideoWithMixedAudio`: fallback map thẳng dub track |
| R5 | Crossfade re-encode làm chậm/đổi timing | 2 | 2 | 4 | Crossfade rất ngắn (~30-50ms), re-encode chỉ audio track (video `-c:v copy`) |
| R6 | driftSeconds tích lũy trên video rất dài (giọng lồng lệch dần cảnh) | 3 | 2 | 6 | Cap 1.15x giữ tự nhiên; log cảnh báo khi drift>1s; chấp nhận lệch nhẹ (đánh đổi có chủ đích của hướng A — user đã chốt) |

Không risk ≥ 15. R1/R6 là 2 điểm cần theo dõi khi smoke.

## Test Matrix

| Phase | Command | Pass |
|-------|---------|------|
| 1 | `cd backend && npx tsc --noEmit` | 0 lỗi |
| 1 | `cd backend && npm test` | suite xanh |
| 1 | unit `isValidOutputMode('dub'|'burn+dub')` | `true` |
| 1 | manual: video ngắn mode `dub` | tiếng gốc nhỏ + tiếng Việt to, liền mạch |
| 1 | manual: video ngắn mode `burn+dub` | có sub cứng + lồng tiếng |
| 2 | `cd frontend && npm run lint` | 0 lỗi |
| 2 | manual: chọn 2 mode mới, submit | job hoàn tất, video có dub |

## Backwards Compatibility

- **Thuần additive:** thêm 2 output mode, thêm 2 file service, thêm 1 DI param. Job cũ (`srt`/`burn`) không đổi hành vi.
- **KHÔNG migration DB:** `outputAudioUrl` đã tồn tại; không thêm lại `dubVoiceId` (giọng cố định).

## Rollback

| Phase | Rollback |
|-------|----------|
| 1 | Xóa 2 file mới, revert `output-mode.ts`/`voices.config.ts`/`worker`+spec → về trạng thái no-dub hiện tại |
| 2 | Revert 2 option trong select |

Không có bước phá hủy, không migration → rollback = `git revert` các file, không cần đụng DB.

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| 1 Backend soft-sync + mux + wire | M | Critical path; smoke gate ở R1/R6 |
| 2 Frontend option | S | Sau Phase 1 |
| **Total** | **~M** | Critical: Phase 1 → Phase 2 |

## Cook Handoff

`/t1k:cook plans/260707-1435-dubbing-soft-sync-reintroduce/plan.md`
