import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';
import type { SubtitleRegion } from './subtitle-region.service';

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
 * Cover the detected subtitle band with an opaque filled box to hide
 * pre-existing burned-in subtitles before overlaying new ones. Opt-in feature;
 * the region is detected per-video by subtitle-region.service (Gemini vision),
 * not a fixed guess.
 *
 * A boxblur leaves large hardcoded subtitle text readable through the blur, so
 * we draw a solid box over the band instead — the new translated subtitle is
 * burned on top afterwards, so the covered strip is never seen bare.
 */
export async function coverSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
  region: SubtitleRegion,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // drawbox with t=fill draws a fully opaque rectangle; iw/ih expressions let
    // FFmpeg size it from the actual frame dimensions with no probe needed.
    const filter = `drawbox=x=0:y=ih*${region.yRatio}:w=iw:h=ih*${region.heightRatio}:color=black:t=fill`;
    ffmpeg(inputVideoPath)
      .outputOptions(['-vf', filter])
      .outputOptions(['-c:a', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputVideoPath);
  });
}
