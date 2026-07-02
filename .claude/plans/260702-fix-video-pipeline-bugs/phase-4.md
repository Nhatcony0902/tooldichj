# Phase 4: Blur Radius Safety Clamp (I4)

**Files owned:** `backend/src/translation/pipeline/burn-in.service.ts`

File-disjoint from all other phases.

---

## I4 — Hardcoded `boxblur=20:2` exceeds FFmpeg's radius limit on short bands

**Root cause:** `blurSubtitleArea` (`burn-in.service.ts:52-72`) hardcodes `boxblur=20:2` in the filtergraph. FFmpeg's `boxblur` requires `luma_radius ≤ min(cropped_width, cropped_height) / 2`. The cropped band height is `ih * region.heightRatio` (line 61) — for a low-res source or a tightly-detected band (e.g. 480p video with a ~24px band), `radius=20` exceeds the limit and ffmpeg exits non-zero, failing the ENTIRE job (this is supposed to be a best-effort enhancement, not a hard dependency).

**Fix:** compute the crop band's actual pixel height via `ffprobe` (or accept it as a parameter already known by the caller — `detectSubtitleRegion` runs before this and could return frame dimensions) and clamp the radius:

Since `region.heightRatio` is a fraction, not a pixel value, and the caller (`video-pipeline.worker.ts:250`) already has `inputPath`, the simplest fix is to derive frame height via `ffprobe` inside `blurSubtitleArea` (fluent-ffmpeg exposes `ffmpeg.ffprobe`), then clamp:

```typescript
import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import type { SubtitleRegion } from './subtitle-region.service';

const MAX_BLUR_RADIUS = 20;

function probeVideoHeight(inputVideoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputVideoPath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      if (!videoStream?.height) return reject(new Error('Could not determine video height'));
      resolve(videoStream.height);
    });
  });
}

export async function blurSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
  region: SubtitleRegion,
): Promise<void> {
  const frameHeight = await probeVideoHeight(inputVideoPath);
  const bandHeightPx = frameHeight * region.heightRatio;
  // FFmpeg boxblur requires radius <= min(w,h)/2 of the cropped region;
  // clamp so a thin detected band never fails the whole burn phase.
  const radius = Math.max(1, Math.min(MAX_BLUR_RADIUS, Math.floor(bandHeightPx / 2) - 1));

  return new Promise((resolve, reject) => {
    const complexFilter = [
      'split[a][b]',
      `[b]crop=iw:ih*${region.heightRatio}:0:ih*${region.yRatio}[cropped]`,
      `[cropped]boxblur=${radius}:2[blurred]`,
      `[a][blurred]overlay=0:H*${region.yRatio}[out]`,
    ].join(';');
    ffmpeg(inputVideoPath)
      .complexFilter(complexFilter, 'out')
      .outputOptions(['-c:a', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputVideoPath);
  });
}
```

Note: `crop=iw:ih*${ratio}` crops height only (full width), so the binding constraint is the cropped HEIGHT, not width — hence clamping against `bandHeightPx / 2`, not `min(width, bandHeightPx) / 2`. Width is always the full frame width, which is never the limiting dimension for a subtitle band (bands are short and wide).

**Verify:**
- Unit test: mock `ffmpeg.ffprobe` to return `height: 480`, region `heightRatio: 0.05` (→ 24px band) → assert the built filter string uses a clamped radius (e.g. `≤11`), not `20`.
- Unit test: mock `ffmpeg.ffprobe` to return `height: 1080`, region `heightRatio: 0.15` (→ 162px band) → assert radius stays at the default cap `20` (normal case unaffected).
- Manual: run the pipeline end-to-end on a low-res (480p) video with "Xóa phụ đề gốc" checked and a thin detected band — burn phase completes instead of failing.
