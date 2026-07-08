import { Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TtsService } from '../../tts/tts.service';
import { TranslatedSegment } from './subtitle.service';
import { getAudioDuration } from './audio-extractor';
import { withRetry } from './rate-limit.util';
import {
  withFfmpegTimeout,
  FFMPEG_TIMEOUT_SHORT_MS,
  FFMPEG_TIMEOUT_LONG_MS,
} from './ffmpeg-timeout.util';

const SILENCE_THRESHOLD_SEC = 0.05;
// Soft-sync: never speed a clip beyond 1.15x — the old 2.0x atempo made
// speech audibly rushed and was the #1 cause of the removed dub feature
// sounding choppy. Clips that still overrun their slot after 1.15x are
// allowed to spill; the timeline re-anchors at the next natural gap.
const MAX_ATEMPO_RATIO = 1.15;
// Only tempo-correct clips that overrun their slot by more than this factor;
// smaller overruns spill naturally instead of being tempo-warped.
const OVERRUN_TOLERANCE = 1.15;
const SAMPLE_RATE = 24000;
// Tiny edge fades kill the click at clip joins WITHOUT changing duration.
// (A real crossfade overlaps clips and would desync every anchor after it.)
const EDGE_FADE_SEC = 0.02;

export interface DubbingResult {
  audioPath: string;
  /** Peak seconds the dub ran behind its subtitle anchors (0 = aligned). */
  driftSeconds: number;
}

/**
 * Build a Vietnamese dub track from translated segments using "soft sync":
 * each clip is anchored to its segment start when possible, never sped up
 * beyond 1.15x, never padded with trailing silence, and joined with tiny
 * edge fades. Overruns self-correct at the next natural inter-segment gap.
 */
export async function buildDubbingTrack(
  ttsService: TtsService,
  userId: string,
  segments: TranslatedSegment[],
  voiceId: string,
  tmpDir: string,
): Promise<DubbingResult> {
  if (segments.length === 0) {
    throw new Error('Cannot build a dubbing track from zero segments');
  }

  const logger = new Logger('DubbingService');
  const pieces: string[] = [];
  // Actual seconds already emitted onto the concat timeline. Tracks REAL
  // piece durations (not slot ends) — with variable-length clips, the two
  // diverge, and cursor must follow the audio or every anchor desyncs.
  let cursor = 0;
  let driftSeconds = 0;

  // STT output (Gemini-generated) is not guaranteed ordered or non-overlapping;
  // sort by start and clamp end>=start so a malformed segment can't desync the
  // whole track by sending `cursor` backward.
  const orderedSegments = [...segments]
    .sort((a, b) => a.start - b.start)
    .map((segment) => ({
      ...segment,
      end: Math.max(segment.end, segment.start),
    }));

  for (let i = 0; i < orderedSegments.length; i++) {
    const segment = orderedSegments[i];

    // Anchor to the segment start when we can; if the previous clip spilled
    // past it, start immediately instead (soft sync — no "negative silence").
    const gap = segment.start - cursor;
    if (gap > SILENCE_THRESHOLD_SEC) {
      const silencePath = path.join(tmpDir, `silence_${i}.mp3`);
      await fs.writeFile(silencePath, await ttsService.makeSilence(gap));
      pieces.push(silencePath);
      cursor += gap;
    }

    if (!segment.translatedText || !segment.translatedText.trim()) {
      // Nothing to speak (e.g. a music-only slot) — skip; the next segment's
      // anchor gap covers the silence, and amix pads the tail with silence.
      continue;
    }

    // chargeCredit=false: dubbing TTS reuses the flat 10-credit video-job
    // charge (per-segment calls inside the pipeline never bill independently).
    // retryable: () => true — Edge TTS failures (0-byte WebSocket drops) are
    // not 429s, so the default rate-limit-only retry predicate would skip them.
    let audioBuffer: Buffer;
    try {
      const result = await withRetry(
        () => ttsService.synthesize(userId, segment.translatedText, voiceId, false),
        { retryable: () => true, baseDelayMs: 1000 },
      );
      audioBuffer = result.audioBuffer;
    } catch (segErr) {
      logger.warn(
        `Segment ${i} TTS failed, leaving its slot silent: ${segErr instanceof Error ? segErr.message : String(segErr)}`,
      );
      continue; // next segment's anchor gap covers the hole
    }

    const rawClipPath = path.join(tmpDir, `clip_${i}_raw.mp3`);
    await fs.writeFile(rawClipPath, audioBuffer);
    const actualDuration = await getAudioDuration(rawClipPath);
    const targetDuration = Math.max(0.1, segment.end - segment.start);

    // Soft-fit: gentle tempo correction ONLY for clips far over their slot;
    // never pad short clips (trailing dead air was choppiness cause #2).
    const ratio =
      actualDuration > targetDuration * OVERRUN_TOLERANCE
        ? Math.min(MAX_ATEMPO_RATIO, actualDuration / targetDuration)
        : 1;
    const clipPath = path.join(tmpDir, `clip_${i}.mp3`);
    await renderClip(rawClipPath, clipPath, ratio, actualDuration / ratio);
    // Measure the rendered file (mp3 frame padding shifts durations ~26ms;
    // computed estimates drift when accumulated across hundreds of clips).
    const clipDuration = await getAudioDuration(clipPath);
    pieces.push(clipPath);
    cursor += clipDuration;

    const overrun = cursor - segment.end;
    if (overrun > 0) driftSeconds = Math.max(driftSeconds, overrun);
  }

  if (pieces.length === 0) {
    throw new Error('Cannot build a dubbing track: no speakable segments');
  }
  if (driftSeconds > 1) {
    logger.warn(
      `Dubbing track ran up to ${driftSeconds.toFixed(2)}s behind its anchors (some segments spoke too long to fit their slot at ${MAX_ATEMPO_RATIO}x)`,
    );
  }

  const listPath = path.join(tmpDir, 'concat_list.txt');
  const listContent = pieces
    .map((p) => `file '${p.replace(/'/g, "'\\''")}'`)
    .join('\n');
  await fs.writeFile(listPath, listContent, 'utf-8');

  const audioPath = path.join(tmpDir, 'dubbing-track.mp3');
  await concatPieces(listPath, audioPath);

  return { audioPath, driftSeconds };
}

/**
 * Re-encode one speech clip: optional gentle atempo + 20ms edge fades.
 * `outDurationSec` is the expected post-atempo duration (used to place the
 * fade-out at the clip tail).
 */
function renderClip(
  inputPath: string,
  outputPath: string,
  atempoRatio: number,
  outDurationSec: number,
): Promise<void> {
  const filters: string[] = [];
  if (atempoRatio > 1.001) {
    filters.push(`atempo=${atempoRatio.toFixed(4)}`);
  }
  filters.push(`afade=t=in:st=0:d=${EDGE_FADE_SEC}`);
  filters.push(
    `afade=t=out:st=${Math.max(0, outDurationSec - EDGE_FADE_SEC).toFixed(3)}:d=${EDGE_FADE_SEC}`,
  );
  let command: ffmpeg.FfmpegCommand;
  return withFfmpegTimeout(
    new Promise((resolve, reject) => {
      command = ffmpeg(inputPath)
        .audioFilters(filters)
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(SAMPLE_RATE)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .save(outputPath);
    }),
    `renderClip(${inputPath})`,
    FFMPEG_TIMEOUT_SHORT_MS,
    () => command?.kill('SIGKILL'),
  );
}

// Re-encode on concat (no `-c copy`): guarantees uniform frames across
// silence/TTS/atempo'd pieces so joins decode smoothly instead of clicking.
// LONG timeout: this re-encodes the ENTIRE concatenated dub track in one
// pass, so a long video's full-length audio can legitimately take a while.
function concatPieces(listPath: string, outputPath: string): Promise<void> {
  let command: ffmpeg.FfmpegCommand;
  return withFfmpegTimeout(
    new Promise((resolve, reject) => {
      command = ffmpeg()
        .input(listPath)
        .inputOptions(['-f', 'concat', '-safe', '0'])
        .audioCodec('libmp3lame')
        .audioChannels(1)
        .audioFrequency(SAMPLE_RATE)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .save(outputPath);
    }),
    `concatPieces(${listPath})`,
    FFMPEG_TIMEOUT_LONG_MS,
    () => command?.kill('SIGKILL'),
  );
}
