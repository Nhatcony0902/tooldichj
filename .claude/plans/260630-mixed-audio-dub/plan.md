# Plan: Mixed Audio Dubbing — Giữ tiếng gốc ở 50% + lồng tiếng ở 100%

## Bối cảnh & Quyết định

Hiện tại `mux.service.ts` thay thế toàn bộ audio gốc bằng dub track (silence hoàn toàn).
Yêu cầu mới: khi output mode có dub (`dub`, `burn+dub`), giữ audio gốc ở ~50% volume
và mix với dub track ở 100% — dùng ffmpeg `amix` filter.

Không thêm output mode mới. Chỉ thay hành vi mux hiện tại.

## Phases

### Phase 1: Mixed audio mux + verify dubbing path (Effort: S)

**Files:**
- **SỬA** `backend/src/translation/pipeline/mux.service.ts`
  - Thêm hàm `muxVideoWithMixedAudio(videoPath, dubPath, outputPath, origVolumeRatio = 0.5)`
  - ffmpeg filter: `[0:a]volume=0.5[orig];[orig][1:a]amix=inputs=2:duration=first[mix]`
  - Map: `-map 0:v:0 -map [mix] -c:v copy -c:a aac -b:a 192k`
  - GIỮ hàm `muxVideoWithAudio` cũ (dùng cho rollback / nếu cần pure replace sau)

- **SỬA** `backend/src/translation/pipeline/video-pipeline.worker.ts`
  - Import thêm `muxVideoWithMixedAudio`
  - Thay `muxVideoWithAudio(videoStreamSourcePath, dubAudioPath, dubbedVideoPath)` → `muxVideoWithMixedAudio(...)`

## API Contract — `muxVideoWithMixedAudio`

```ts
export function muxVideoWithMixedAudio(
  videoPath: string,    // video source (có audio gốc)
  dubPath: string,      // dub MP3 track
  outputPath: string,
  origVolumeRatio?: number, // default 0.5 (50%)
): Promise<void>
```

**ffmpeg filter graph:**
```
[0:a]volume={origVolumeRatio}[orig];[orig][1:a]amix=inputs=2:duration=first[mix]
```
- `duration=first` → output audio duration theo video input (tránh dub kéo dài hơn video)
- `-map 0:v:0` → giữ video stream từ input 0
- `-map [mix]` → audio là kết quả mix
- `-c:v copy` → không re-encode video
- `-c:a aac -b:a 192k` → encode audio output

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|-----------|
| `amix` không normalize → dub bị clipping khi cộng 2 track | 2 | 2 | 4 | `normalize=0` trong amix opts (mặc định ffmpeg không normalize) — nếu nghe bị vỡ thêm `normalize=0:weights=1 0.5` |
| Video không có audio stream (muted video) → `[0:a]` filter fail | 2 | 3 | 6 | Thêm `-an` guard: nếu video không có audio, fallback về `muxVideoWithAudio` thuần |
| `duration=first` cắt dub sớm nếu dub ngắn hơn video | 1 | 1 | 1 | OK — dub được gen từ segment timestamps nên ≤ video duration |

Không có risk ≥ 15.

## Testing

- **Typecheck:** `cd backend && npx tsc --noEmit` → 0 lỗi
- **Manual smoke:** chạy 1 video ngắn với output mode `dub` hoặc `burn+dub` → file output có cả tiếng gốc (nhỏ hơn) + lồng tiếng (to hơn)

## Rollback

Revert 2 file → quay về replace-audio cũ. Không DB, không schema.

## Timeline

| Phase | Effort |
|-------|--------|
| Phase 1: Mixed audio + worker wire | S |
| Total | S |
