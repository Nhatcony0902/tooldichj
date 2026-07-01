import { Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as path from 'path';
import { TtsService } from '../../tts/tts.service';
import { TranslatedSegment } from './subtitle.service';
import { getAudioDuration } from './audio-extractor';
import { withRetry } from './rate-limit.util';

const SILENCE_THRESHOLD_SEC = 0.05;
// Single-instance ffmpeg `atempo` is reliable up to 2.0x; beyond that the
// segment is allowed to overrun its slot rather than risk garbled audio.
const MAX_ATEMPO_RATIO = 2.0;
const SAMPLE_RATE = 24000;

export interface DubbingResult {
  audioPath: string;
  /** Total seconds of uncorrected overrun across all segments (0 = perfectly aligned). */
  driftSeconds: number;
}

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
    const targetDuration = Math.max(0.1, segment.end - segment.start);

    const gap = segment.start - cursor;
    if (gap > SILENCE_THRESHOLD_SEC) {
      const silencePath = path.join(tmpDir, `silence_${i}.mp3`);
      await renderSilence(silencePath, gap);
      pieces.push(silencePath);
    }

    const clipPath = path.join(tmpDir, `clip_${i}.mp3`);
    if (!segment.translatedText || !segment.translatedText.trim()) {
      // Nothing to speak for this slot (e.g. a music-only segment) — fill it
      // with silence instead of letting TtsService reject empty text and
      // abort the whole video job.
      await renderSilence(clipPath, targetDuration);
      pieces.push(clipPath);
      cursor = segment.end;
      continue;
    }

    // chargeCredit=false: dubbing TTS reuses the flat 10-credit video-job
    // charge, consistent with the Phase 2 decision that per-segment Gemini
    // calls inside the video pipeline never bill independently.
    // withRetry handles rate-limit errors; per-segment try/catch ensures a
    // single failed segment fills with silence instead of aborting the whole track.
    let audioBuffer: Buffer;
    try {
      const result = await withRetry(() =>
        ttsService.synthesize(userId, segment.translatedText, voiceId, false),
      );
      audioBuffer = result.audioBuffer;
    } catch (segErr) {
      logger.warn(
        `Segment ${i} TTS failed, filling with silence: ${segErr instanceof Error ? segErr.message : String(segErr)}`,
      );
      await renderSilence(clipPath, targetDuration);
      pieces.push(clipPath);
      cursor = segment.end;
      continue;
    }
    const rawClipPath = path.join(tmpDir, `clip_${i}_raw.mp3`);
    await fs.writeFile(rawClipPath, audioBuffer);
    const actualDuration = await getAudioDuration(rawClipPath);

    if (actualDuration > targetDuration * 1.05) {
      const ratio = Math.min(MAX_ATEMPO_RATIO, actualDuration / targetDuration);
      await applyAtempo(rawClipPath, clipPath, ratio);
      const correctedDuration = actualDuration / ratio;
      if (correctedDuration > targetDuration) {
        driftSeconds += correctedDuration - targetDuration;
      }
    } else if (actualDuration < targetDuration) {
      await padWithSilence(
        rawClipPath,
        clipPath,
        targetDuration - actualDuration,
      );
    } else {
      await fs.copyFile(rawClipPath, clipPath);
    }
    pieces.push(clipPath);

    // Advance by the segment's intended slot, not the measured/corrected
    // duration, so small rounding errors never compound across segments.
    cursor = segment.end;
  }

  if (driftSeconds > 1) {
    logger.warn(
      `Dubbing track drifted ${driftSeconds.toFixed(2)}s out of sync (some segments spoke too long to fit their slot even at ${MAX_ATEMPO_RATIO}x speed)`,
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

async function renderSilence(
  outputPath: string,
  durationSec: number,
): Promise<void> {
  // fluent-ffmpeg's format-capability check has a regex bug that misreads
  // ffmpeg's `lavfi` device-format line (extra flag column), so `anullsrc`
  // falsely reports "format not available" even though the ffmpeg CLI
  // supports it fine. Sidestep it the same way Phase 3's mock TTS audio
  // does: build a real zero-filled s16le PCM buffer and transcode that.
  const pcmDir = path.dirname(outputPath);
  const rawPath = path.join(pcmDir, `${path.basename(outputPath, '.mp3')}.pcm`);
  const sampleCount = Math.round(durationSec * SAMPLE_RATE);
  const silentPcm = Buffer.alloc(sampleCount * 2);
  await fs.writeFile(rawPath, silentPcm);
  return new Promise((resolve, reject) => {
    ffmpeg(rawPath)
      .inputFormat('s16le')
      .inputOptions(['-ar', `${SAMPLE_RATE}`, '-ac', '1'])
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

function applyAtempo(
  inputPath: string,
  outputPath: string,
  ratio: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`atempo=${ratio.toFixed(4)}`)
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

function padWithSilence(
  inputPath: string,
  outputPath: string,
  padSeconds: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`apad=pad_dur=${padSeconds.toFixed(4)}`)
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(SAMPLE_RATE)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

function concatPieces(listPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(listPath)
      .inputOptions(['-f', 'concat', '-safe', '0'])
      .outputOptions(['-c', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}
