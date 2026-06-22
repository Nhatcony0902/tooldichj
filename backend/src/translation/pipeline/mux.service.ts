import ffmpeg from 'fluent-ffmpeg';

// Replaces the video's original audio with the given track (does not duck
// or mix) — the simplest correct behavior for a dedicated "dub" output mode.
export function muxVideoWithAudio(
  videoPath: string,
  audioPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        '-map',
        '0:v:0',
        '-map',
        '1:a:0',
        '-c:v',
        'copy',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
        '-shortest',
      ])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}
