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

/**
 * Mix the video's original audio (at origVolumeRatio) with the dub track (at 1.0).
 * Keeps background/music audible while the dubbed voice is dominant.
 */
export function muxVideoWithMixedAudio(
  videoPath: string,
  dubPath: string,
  outputPath: string,
  origVolumeRatio = 0.5,
): Promise<void> {
  // Use raw -filter_complex flag instead of .complexFilter() — fluent-ffmpeg
  // joins array items with "," not ";" so multi-chain graphs break silently.
  const filterGraph =
    `[0:a]volume=${origVolumeRatio.toFixed(2)}[orig];` +
    `[orig][1:a]amix=inputs=2:duration=first[mix]`;
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(dubPath)
      .outputOptions([
        '-filter_complex', filterGraph,
        '-map', '0:v:0',
        '-map', '[mix]',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
      ])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}
