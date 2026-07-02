import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import type { SubtitleRegion } from './subtitle-region.service';

const MAX_BLUR_RADIUS = 20;

function probeVideoHeight(inputVideoPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(inputVideoPath, (err, data) => {
      if (err) return reject(err);
      const videoStream = data.streams.find((s) => s.codec_type === 'video');
      if (!videoStream?.height)
        return reject(new Error('Could not determine video height'));
      resolve(videoStream.height);
    });
  });
}

// Netflix/YouTube style: small font in an opaque box, bottom-center.
// PlayResY=288 anchors FontSize units; FontSize=14 → 14/288 ≈ 4.9% of frame height.
// BorderStyle=3: opaque box background. BackColour=&H66000000: 60% opacity black (ASS AABBGGRR).
const TIKTOK_SUBTITLE_STYLE = [
  'PlayResX=512',
  'PlayResY=288',
  'FontName=Arial',
  'FontSize=14',
  'Bold=1',
  'PrimaryColour=&H00FFFFFF',
  'OutlineColour=&H00000000',
  'BorderStyle=3',
  'BackColour=&H66000000',
  'Outline=0',
  'Shadow=0',
  'MarginV=20',
  'Alignment=2',
].join(',');

export function burnInSubtitles(
  inputVideoPath: string,
  srtPath: string,
  outputVideoPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // The subtitles filter's mini-language treats ':' and '\' as special
    // characters, which makes absolute Windows paths (e.g. "C:\...")
    // unreliable to escape inline. Running ffmpeg with cwd set to the SRT's
    // directory and referencing it by bare filename avoids the problem
    // entirely (input/output paths stay absolute, unaffected by cwd).
    const subtitleFilter = `subtitles=${path.basename(srtPath)}:force_style='${TIKTOK_SUBTITLE_STYLE}'`;
    ffmpeg(inputVideoPath, { cwd: path.dirname(srtPath) })
      .outputOptions(['-vf', subtitleFilter])
      .outputOptions(['-c:a', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputVideoPath);
  });
}

/**
 * Blur the detected subtitle region of every frame to obscure pre-existing
 * burned-in subtitles before overlaying new ones. Opt-in feature; the region
 * is detected per-video by subtitle-region.service (Gemini vision), not a
 * fixed guess. Uses split→crop→boxblur→overlay filtergraph (standard FFmpeg
 * region blur).
 */
export async function blurSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
  region: SubtitleRegion,
): Promise<void> {
  const frameHeight = await probeVideoHeight(inputVideoPath);
  const bandHeightPx = frameHeight * region.heightRatio;
  // FFmpeg boxblur requires radius <= min(w,h)/2 of the cropped region;
  // clamp so a thin detected band never fails the whole burn phase.
  const radius = Math.max(
    1,
    Math.min(MAX_BLUR_RADIUS, Math.floor(bandHeightPx / 2) - 1),
  );

  return new Promise((resolve, reject) => {
    // split the video into two copies; blur the detected band of one; overlay it back
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
