import { Logger } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import { UnrecoverableError } from 'bullmq';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getAudioDuration } from './audio-extractor'; // generic ffprobe, works on video files too
import { stripMarkdownFence } from './json-parse.util';
import { withFfmpegTimeout, FFMPEG_TIMEOUT_SHORT_MS } from './ffmpeg-timeout.util';
import {
  withRetry,
  isRateLimitError,
  isQuotaExhaustedError,
} from './rate-limit.util';

// withRetry (used per-sample below) re-throws a genuine quota-exhausted
// error as UnrecoverableError with a translated message, which no longer
// matches isQuotaExhaustedError's English-phrase regex. Treat it the same
// way — it is the ONLY error withRetry ever wraps this way.
function isQuotaExhaustedSignal(err: unknown): boolean {
  return isQuotaExhaustedError(err) || err instanceof UnrecoverableError;
}

export interface SubtitleRegion {
  yRatio: number; // top edge, fraction of frame height (0=top, 1=bottom)
  heightRatio: number; // region height, fraction of frame height
}

export interface SubtitleRegionResult {
  region: SubtitleRegion | null;
  // true = detection could not complete due to an API error (retries
  // exhausted); false = either a region was found, or every sample
  // genuinely showed no burned-in subtitle. Callers use this to distinguish
  // "blur skipped because nothing is there" from "blur skipped because we
  // couldn't tell" (B2).
  failedDueToError: boolean;
}

const logger = new Logger('subtitle-region');

// Fallback sampling: a few frames at fixed fractions of the video. Used only
// when no speech timing is available — a burned-in subtitle is present during
// speech, so fixed fractions can land on silent/no-text frames and miss it.
const SAMPLE_POSITIONS = [0.2, 0.5, 0.8]; // fractions of video duration
const FRAME_WIDTH = 640; // downscale to cut Gemini tokens/latency
const REGION_PADDING = 0.02; // grow the union slightly so jitter never clips text
// Cap on frames sampled for detection — each is a Gemini vision call, so keep
// it bounded even for long videos with many speech segments.
const MAX_REGION_SAMPLES = 6;
// A real burned-in subtitle band is a thin strip. If different samples show
// captions at genuinely different frame positions (e.g. an intro caption up
// top, later captions at the bottom), the naive envelope of ALL detections
// used to span from the topmost to the bottommost point — covering nearly
// the whole frame with a black box. Cap how tall the final cover box may be;
// beyond this it's treated as an inconsistent/unsafe detection and skipped
// entirely rather than blanket-covering real video content.
const MAX_REASONABLE_HEIGHT_RATIO = 0.3;

/**
 * Choose up to `max` timestamps (seconds) at the MIDDLE of speech segments —
 * moments a burned-in subtitle is guaranteed to be on screen. Evenly spreads
 * the picks across the segment list so samples cover the whole video. Pass the
 * result to detectSubtitleRegion so it samples where text actually appears
 * instead of fixed duration fractions.
 */
export function pickSpeechSampleTimestamps(
  segments: { start: number; end: number }[],
  max: number = MAX_REGION_SAMPLES,
): number[] {
  const mids = segments.map((s) => (s.start + s.end) / 2).filter((t) => t > 0);
  if (mids.length <= max) return mids;
  const step = mids.length / max;
  const picked: number[] = [];
  for (let i = 0; i < max; i += 1) {
    picked.push(mids[Math.floor(i * step)]);
  }
  return picked;
}

interface RegionDetectionResult {
  found: boolean;
  yRatio: number;
  heightRatio: number;
}

/**
 * Detect the region of a video frame occupied by pre-existing burned-in
 * subtitles, using Gemini vision on sampled frames. Returns the union of all
 * detected instances (plus small padding), or null when no subtitle is found
 * in any sample or when no Gemini client is configured — the caller then skips
 * the blur step rather than guessing a region and damaging real content.
 */
export async function detectSubtitleRegion(
  ai: GoogleGenAI | null,
  videoPath: string,
  tmpDir: string,
  sampleTimestamps?: number[],
): Promise<SubtitleRegionResult> {
  if (!ai) return { region: null, failedDueToError: false }; // no GEMINI_API_KEY — caller skips blur (legit, quiet)

  // Prefer caller-supplied speech-aligned timestamps (frames where a subtitle
  // is actually on screen). Fall back to fixed duration fractions only when no
  // speech timing is available.
  let timestamps: number[];
  if (sampleTimestamps && sampleTimestamps.length > 0) {
    timestamps = sampleTimestamps.filter((t) => t > 0);
  } else {
    const duration = await getAudioDuration(videoPath);
    if (!duration || duration <= 0)
      return { region: null, failedDueToError: false };
    timestamps = SAMPLE_POSITIONS.map((f) => duration * f).filter((t) => t > 0);
  }
  if (timestamps.length === 0)
    return { region: null, failedDueToError: false };
  const regions: SubtitleRegion[] = [];
  let sawApiError = false;

  for (let i = 0; i < timestamps.length; i += 1) {
    const framePath = path.join(tmpDir, `region-sample-${i}.jpg`);
    try {
      await extractFrame(videoPath, timestamps[i], framePath);
      // One retry on a transient rate limit before giving up on this sample.
      const region = await withRetry(() => detectRegionInFrame(ai, framePath), {
        maxAttempts: 2,
      });
      if (region) regions.push(region);
    } catch (err) {
      if (isQuotaExhaustedSignal(err)) {
        // Daily/billing quota — the remaining samples would fail identically.
        sawApiError = true;
        logger.warn(
          `Subtitle-region detection aborted (quota exhausted) at sample ${i}: ${err instanceof Error ? err.message : String(err)}`,
        );
        break;
      }
      if (isRateLimitError(err)) {
        sawApiError = true;
        logger.warn(
          `Subtitle-region sample ${i} rate-limited after retry: ${err instanceof Error ? err.message : String(err)}`,
        );
      } else {
        // A bad frame or unparseable response — not an API-availability
        // failure, so it doesn't count against "detection failed".
        logger.warn(
          `Subtitle-region sample ${i} failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  if (regions.length === 0) {
    return { region: null, failedDueToError: sawApiError };
  }

  const region = pickDominantRegion(regions);
  if (!region || region.heightRatio > MAX_REASONABLE_HEIGHT_RATIO) {
    if (region) {
      logger.warn(
        `Subtitle-region detection produced an implausibly tall band (heightRatio=${region.heightRatio.toFixed(3)}) — skipping blur rather than covering most of the frame`,
      );
    }
    return { region: null, failedDueToError: false };
  }
  return { region, failedDueToError: false };
}

/**
 * Group detections by vertical overlap and union only within the
 * largest-agreement cluster (the stable, real subtitle band). Detections at
 * an unrelated position elsewhere in the frame — a different on-screen
 * caption, a false positive — land in their own smaller cluster and are
 * discarded as noise instead of being merged into one blanket region.
 */
function pickDominantRegion(regions: SubtitleRegion[]): SubtitleRegion | null {
  if (regions.length === 0) return null;
  const clusters: SubtitleRegion[][] = [];
  for (const region of regions) {
    const top = region.yRatio;
    const bottom = region.yRatio + region.heightRatio;
    const cluster = clusters.find((c) =>
      c.some((r) => top < r.yRatio + r.heightRatio && r.yRatio < bottom),
    );
    if (cluster) cluster.push(region);
    else clusters.push([region]);
  }
  clusters.sort((a, b) => b.length - a.length);
  // A genuine tie for the top spot (e.g. one sample detected a top caption,
  // another detected a bottom caption, neither has majority support) means
  // there is no real basis to pick one side over the other — guessing would
  // silently cover the WRONG band rather than the reported bug's oversized
  // one. Treat it the same as "no reliable detection" and skip.
  if (clusters.length > 1 && clusters[0].length === clusters[1].length) {
    return null;
  }
  const dominant = clusters[0];
  const top = Math.max(0, Math.min(...dominant.map((r) => r.yRatio)) - REGION_PADDING);
  const bottom = Math.min(
    1,
    Math.max(...dominant.map((r) => r.yRatio + r.heightRatio)) + REGION_PADDING,
  );
  return { yRatio: top, heightRatio: bottom - top };
}

function extractFrame(
  videoPath: string,
  timestampSec: number,
  outputPath: string,
): Promise<void> {
  let command: ffmpeg.FfmpegCommand;
  return withFfmpegTimeout(
    new Promise((resolve, reject) => {
      command = ffmpeg(videoPath)
        .screenshots({
          timestamps: [timestampSec],
          filename: path.basename(outputPath),
          folder: path.dirname(outputPath),
          size: `${FRAME_WIDTH}x?`,
        })
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err));
    }),
    `extractFrame(${videoPath}@${timestampSec})`,
    FFMPEG_TIMEOUT_SHORT_MS,
    () => command?.kill('SIGKILL'),
  );
}

async function detectRegionInFrame(
  ai: GoogleGenAI,
  framePath: string,
): Promise<SubtitleRegion | null> {
  const imageBuffer = await fs.readFile(framePath);
  const base64 = imageBuffer.toString('base64');

  const prompt = `This is a single frame from a video. Look for pre-existing burned-in (hardcoded) subtitle text overlaid on the image — usually white or yellow text near the bottom or top edge, often with a dark outline or box behind it.

Return ONLY a JSON object, no markdown fences, in this exact shape:
{"found": boolean, "yRatio": number, "heightRatio": number}

- "found": true only if you see burned-in subtitle text (not on-screen UI, logos, or scene text elsewhere in the frame).
- "yRatio": top edge of the subtitle text band, as a fraction of image height (0 = top, 1 = bottom).
- "heightRatio": height of that band, as a fraction of image height. Err slightly generous rather than tight, so the full text is covered.
- If no burned-in subtitle is visible, return {"found": false, "yRatio": 0, "heightRatio": 0}.`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { text: prompt },
          { inlineData: { mimeType: 'image/jpeg', data: base64 } },
        ],
      },
    ],
    config: { thinkingConfig: { thinkingBudget: 0 } },
  });

  const raw = response.text?.trim() || '';
  const parsed = JSON.parse(stripMarkdownFence(raw)) as RegionDetectionResult;
  if (!parsed.found) return null;
  if (
    typeof parsed.yRatio !== 'number' ||
    typeof parsed.heightRatio !== 'number' ||
    parsed.heightRatio <= 0
  ) {
    return null;
  }
  // Clamp defensively — an out-of-range estimate would break the ffmpeg crop.
  const yRatio = Math.min(Math.max(parsed.yRatio, 0), 1);
  const heightRatio = Math.min(parsed.heightRatio, 1 - yRatio);
  if (heightRatio <= 0) return null;
  return { yRatio, heightRatio };
}
