import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';

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
 * Blur the bottom 20% of every frame to obscure pre-existing burned-in
 * subtitles before overlaying new ones. Opt-in feature (Phase 3).
 * Uses split→crop→boxblur→overlay filtergraph (standard FFmpeg region blur).
 */
export function blurSubtitleArea(
  inputVideoPath: string,
  outputVideoPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // split the video into two copies; blur the bottom-20% of one; overlay it back
    const complexFilter = [
      'split[a][b]',
      '[b]crop=iw:ih*0.2:0:ih*0.8[cropped]',
      '[cropped]boxblur=20:2[blurred]',
      '[a][blurred]overlay=0:H*0.8[out]',
    ].join(';');
    ffmpeg(inputVideoPath)
      .complexFilter(complexFilter, 'out')
      .outputOptions(['-c:a', 'copy'])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputVideoPath);
  });
}
