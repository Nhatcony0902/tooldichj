# Phase 2: Auto-Detect Subtitle Region (Gemini Vision) + Dynamic Blur

Effort: L · Depends on: Phase 1 · Blocks: none

## Goal

Replace the hardcoded "blur bottom 20% of every frame" with a per-video detected region: sample a few frames, ask Gemini (the project's existing AI provider) to locate the burned-in subtitle text band, then blur exactly that region. If no subtitle is found (or no Gemini key is configured), skip the blur step entirely rather than guessing.

## Files Owned

- NEW `backend/src/translation/pipeline/json-parse.util.ts`
- NEW `backend/src/translation/pipeline/subtitle-region.service.ts`
- `backend/src/translation/pipeline/burn-in.service.ts`
- `backend/src/translation/translation.service.ts` (import shared util, remove the private duplicate)
- `backend/src/translation/pipeline/video-pipeline.worker.ts`

## Step 0 — R6 Mitigation: Verify Multimodal Input FIRST

Before wiring anything else, confirm `gemini-2.0-flash` accepts an image part via `@google/genai`'s `generateContent`. Write a tiny throwaway script (or a `.spec.ts` you keep) that calls:

```ts
await ai.models.generateContent({
  model: 'gemini-2.0-flash',
  contents: [{
    role: 'user',
    parts: [
      { text: 'Describe what you see in one sentence.' },
      { inlineData: { mimeType: 'image/jpeg', data: base64Jpeg } },
    ],
  }],
});
```

against a real JPEG and a real `GEMINI_API_KEY`. If the model/SDK shape differs (e.g. needs `mimeType` under a different key, or the model rejects images), fix the contract HERE before building the rest of the phase — this is the exact failure mode R6 in `plan.md` calls out.

## Step 1 — Shared JSON-fence-strip util (DRY)

`translation.service.ts:25` has a private `stripMarkdownFence()` used to parse Gemini's fenced JSON responses. The new vision-detection parser needs the identical logic. Per `code-conventions.md` "No Duplicated Logic":

- Create `backend/src/translation/pipeline/json-parse.util.ts`:
  ```ts
  export function stripMarkdownFence(text: string): string {
    // move the existing implementation here verbatim
  }
  ```
- Update `translation.service.ts` to `import { stripMarkdownFence } from './pipeline/json-parse.util';` and delete its local copy.
- Both existing Gemini JSON call sites in `translation.service.ts` keep working unchanged (same function, new home).

## Step 2 — `subtitle-region.service.ts`

```ts
import type { GoogleGenAI } from '@google/genai';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getAudioDuration } from './audio-extractor'; // generic ffprobe, works on video files too
import { stripMarkdownFence } from './json-parse.util';

export interface SubtitleRegion {
  yRatio: number;      // top edge, fraction of frame height (0=top, 1=bottom)
  heightRatio: number;  // region height, fraction of frame height
}

const SAMPLE_POSITIONS = [0.2, 0.5, 0.8]; // fractions of video duration
const FRAME_WIDTH = 640; // downscale to cut Gemini tokens/latency (R4)

export async function detectSubtitleRegion(
  ai: GoogleGenAI | null,
  videoPath: string,
  tmpDir: string,
): Promise<SubtitleRegion | null> {
  if (!ai) return null; // no key configured (R5) — caller skips blur

  const duration = await getAudioDuration(videoPath);
  if (!duration || duration <= 0) return null;

  const timestamps = SAMPLE_POSITIONS.map((f) => duration * f).filter((t) => t > 0);
  const regions: SubtitleRegion[] = [];

  for (let i = 0; i < timestamps.length; i += 1) {
    const framePath = path.join(tmpDir, `region-sample-${i}.jpg`);
    await extractFrame(videoPath, timestamps[i], framePath);
    const region = await detectRegionInFrame(ai, framePath);
    if (region) regions.push(region);
  }

  if (regions.length === 0) return null; // no subtitle found in any sample (R3)

  // Union of all detected instances + small padding, so minor per-frame
  // bbox jitter never clips part of the subtitle band.
  const top = Math.max(0, Math.min(...regions.map((r) => r.yRatio)) - 0.02);
  const bottom = Math.min(1, Math.max(...regions.map((r) => r.yRatio + r.heightRatio)) + 0.02);
  return { yRatio: top, heightRatio: bottom - top };
}

function extractFrame(videoPath: string, timestampSec: number, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(videoPath)
      .screenshots({
        timestamps: [timestampSec],
        filename: path.basename(outputPath),
        folder: path.dirname(outputPath),
        size: `${FRAME_WIDTH}x?`,
      })
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err));
  });
}

interface RegionDetectionResult {
  found: boolean;
  yRatio: number;
  heightRatio: number;
}

async function detectRegionInFrame(
  ai: GoogleGenAI,
  framePath: string,
): Promise<SubtitleRegion | null> {
  const imageBuffer = await fs.readFile(framePath);
  const base64 = imageBuffer.toString('base64');

  const prompt = `This is a single frame from a video. Look for pre-existing burned-in (hardcoded) subtitle text overlaid on the image — usually white/yellow text near the bottom or top edge, often with a dark outline or box behind it.

Return ONLY a JSON object, no markdown fences, in this exact shape:
{"found": boolean, "yRatio": number, "heightRatio": number}

- "found": true only if you see burned-in subtitle text (not on-screen UI, logos, or scene text elsewhere in the frame).
- "yRatio": top edge of the subtitle text band, as a fraction of image height (0 = top, 1 = bottom).
- "heightRatio": height of that band, as a fraction of image height. Err slightly generous rather than tight, to make sure the full text is covered.
- If no burned-in subtitle is visible, return {"found": false, "yRatio": 0, "heightRatio": 0}.`;

  try {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: [
        {
          role: 'user',
          parts: [{ text: prompt }, { inlineData: { mimeType: 'image/jpeg', data: base64 } }],
        },
      ],
    });
    const raw = response.text?.trim() || '';
    const parsed = JSON.parse(stripMarkdownFence(raw)) as RegionDetectionResult;
    if (!parsed.found) return null;
    if (typeof parsed.yRatio !== 'number' || typeof parsed.heightRatio !== 'number') return null;
    return { yRatio: parsed.yRatio, heightRatio: parsed.heightRatio };
  } catch {
    return null; // one bad frame shouldn't fail the whole job — treated as "not found" for this sample
  }
}
```

## Step 3 — `burn-in.service.ts`: parameterize `blurSubtitleArea`

Replace the hardcoded `ih*0.2`/`ih*0.8` crop with the detected region:

```ts
import type { SubtitleRegion } from './subtitle-region.service';

export function blurSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
  region: SubtitleRegion,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const complexFilter = [
      'split[a][b]',
      `[b]crop=iw:ih*${region.heightRatio}:0:ih*${region.yRatio}[cropped]`,
      '[cropped]boxblur=20:2[blurred]',
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

(Function signature changes from 2 params to 3 — `region` is now required, no default, since the caller always resolves it first.)

## Step 4 — Wire into `video-pipeline.worker.ts`

In the `if (outputModeIncludesBurn(outputMode))` block, before calling `blurSubtitleArea`:

```ts
if (videoJob.removeSourceSubs) {
  await this.updateJob(jobId, {
    progress: 76,
    stepDescription: 'Đang dò vị trí phụ đề gốc...',
  });
  const region = await detectSubtitleRegion(
    this.translationService.getAi(),
    inputPath,
    tmpDir,
  );
  if (region) {
    await this.updateJob(jobId, {
      progress: 78,
      stepDescription: 'Đang làm mờ phụ đề gốc...',
    });
    const blurredPath = path.join(tmpDir, 'blurred.mp4');
    await blurSubtitleArea(inputPath, blurredPath, region);
    burnSource = blurredPath;
  } else {
    this.logger.warn(
      `VideoJob ${jobId}: no burned-in subtitle detected, skipping blur step`,
    );
    // burnSource stays inputPath — no region to blur, nothing to skip past.
  }
}
```

Add the import: `import { detectSubtitleRegion } from './subtitle-region.service';`

## Verification

```bash
cd backend && npx tsc --noEmit
cd backend && npm test
```

- Step 0 smoke test passes (multimodal call succeeds) BEFORE proceeding to steps 1-4.
- Manual: video with burned-in subtitles positioned somewhere other than "bottom 20%" (e.g. subtitles higher up, or a top-anchored watermark scenario) → confirm the blur actually lands on the subtitle band, not a fixed guess.
- Manual: video with no subtitles at all, checkbox checked → job completes, log shows the skip warning, output frames are untouched (no blur artifact anywhere).
- Manual: `GEMINI_API_KEY` unset → `detectSubtitleRegion` returns `null` immediately (no API call attempted), same skip path.

## Risk Notes

See plan.md R3 (LLM vision bbox is approximate — mitigated by generous-instruction + padding), R4 (extra API cost/latency — mitigated by frame downscaling), R5 (no key → clean skip), R6 (verify multimodal input FIRST, Step 0).
