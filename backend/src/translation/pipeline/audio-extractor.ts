import ffmpeg from 'fluent-ffmpeg';
import {
  withFfmpegTimeout,
  FFMPEG_TIMEOUT_SHORT_MS,
  FFMPEG_TIMEOUT_LONG_MS,
} from './ffmpeg-timeout.util';

export function extractAudio(
  inputPath: string,
  outputPath: string,
): Promise<void> {
  let command: ffmpeg.FfmpegCommand;
  return withFfmpegTimeout(
    new Promise((resolve, reject) => {
      command = ffmpeg(inputPath)
        .noVideo()
        .audioCodec('libmp3lame')
        .audioBitrate(32)
        .audioChannels(1)
        .audioFrequency(16000)
        .on('end', () => resolve())
        .on('error', (err: Error) => reject(err))
        .save(outputPath);
    }),
    `extractAudio(${inputPath})`,
    FFMPEG_TIMEOUT_LONG_MS,
    () => command?.kill('SIGKILL'),
  );
}

export function getAudioDuration(filePath: string): Promise<number> {
  return withFfmpegTimeout(
    new Promise((resolve, reject) => {
      ffmpeg.ffprobe(filePath, (err: unknown, data) => {
        if (err) {
          reject(err instanceof Error ? err : new Error('ffprobe failed'));
          return;
        }
        resolve(data.format.duration || 0);
      });
    }),
    `getAudioDuration(${filePath})`,
    FFMPEG_TIMEOUT_SHORT_MS,
  );
}
