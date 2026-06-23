import ffmpeg from 'fluent-ffmpeg';

export function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .noVideo()
      .audioCodec('libmp3lame')
      .audioChannels(1)
      .audioFrequency(16000)
      .on('end', () => resolve())
      .on('error', (err: Error) => reject(err))
      .save(outputPath);
  });
}

export function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err: unknown, data) => {
      if (err) {
        reject(err instanceof Error ? err : new Error('ffprobe failed'));
        return;
      }
      resolve(data.format.duration || 0);
    });
  });
}
