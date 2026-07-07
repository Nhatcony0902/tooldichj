import ffmpeg from 'fluent-ffmpeg';

/**
 * Mux the dub track into the video. Primary path mixes the original audio
 * (ducked to `origVolumeRatio`) with the dub at full volume; videos with no
 * audio stream fall back to mapping the dub track directly (the `[0:a]`
 * filter input would otherwise fail).
 */
export async function muxVideoWithDubTrack(
  videoPath: string,
  dubPath: string,
  outputPath: string,
  origVolumeRatio = 0.5,
): Promise<void> {
  if (!(await hasAudioStream(videoPath))) {
    return muxVideoWithAudio(videoPath, dubPath, outputPath);
  }
  return muxVideoWithMixedAudio(videoPath, dubPath, outputPath, origVolumeRatio);
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

// Replaces the video's audio with the given track outright — used only as
// the fallback for source videos that have no audio stream to mix with.
// No `-shortest`: the dub track ends at the last spoken segment, and
// `-shortest` would silently truncate any trailing speechless video.
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
        '-map', '0:v:0',
        '-map', '1:a:0',
        '-c:v', 'copy',
        '-c:a', 'aac',
        '-b:a', '192k',
      ])
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

function hasAudioStream(videoPath: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(videoPath, (err, data) => {
      if (err) return reject(err);
      resolve(
        (data.streams ?? []).some((s) => s.codec_type === 'audio'),
      );
    });
  });
}
