import ffmpeg from 'fluent-ffmpeg';
import * as path from 'path';

// TikTok-style subtitle parameters (ASS override via force_style):
// - FontName    : Arial (widely available, clean)
// - FontSize    : 20   (relative units; scales with video resolution)
// - Bold        : 1    (heavy weight for readability)
// - PrimaryColour: &H00FFFFFF  (opaque white — BGR hex, alpha in high byte)
// - OutlineColour: &H00000000  (opaque black outline)
// - Outline     : 3    (thick stroke for contrast over any background)
// - Shadow      : 1    (subtle drop-shadow for extra pop)
// - MarginV     : 50   (vertical margin from bottom edge, in pixels)
// - Alignment   : 2    (bottom-center — standard subtitle position)
const TIKTOK_SUBTITLE_STYLE = [
  'FontName=Arial',
  'FontSize=20',
  'Bold=1',
  'PrimaryColour=&H00FFFFFF',
  'OutlineColour=&H00000000',
  'Outline=3',
  'Shadow=1',
  'MarginV=50',
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
