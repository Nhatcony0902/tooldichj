/**
 * Wrap a Promise-returning ffmpeg/ffprobe call so a hung child process
 * rejects instead of leaving the caller (and the whole BullMQ job) awaiting
 * forever with no error and no further log output. A malformed/incomplete
 * media file (e.g. a corrupt-but-nonzero-byte Edge TTS clip) can stall the
 * underlying process indefinitely without ever emitting 'end' or 'error'.
 *
 * `onTimeout`, when given, is invoked right before rejecting — pass e.g.
 * `() => command.kill('SIGKILL')` for ffmpeg-command call sites so a timed-out
 * job doesn't leave the OS process still burning CPU/holding the tmpDir file
 * (which matters most for the long full-video re-encodes, since BullMQ will
 * retry the job up to 3x, compounding a leak). Left unset for ffprobe-based
 * reads (getAudioDuration/hasAudioStream) — the callback-style probe API
 * doesn't expose a killable handle, and those reads are short/light enough
 * that a leaked process is negligible by comparison.
 */
export function withFfmpegTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs: number,
  onTimeout?: () => void,
): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      onTimeout?.();
      reject(new Error(`ffmpeg timeout after ${timeoutMs}ms: ${label}`));
    }, timeoutMs);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Short ops: ffprobe reads, single-frame screenshots, short-clip renders. */
export const FFMPEG_TIMEOUT_SHORT_MS = 120_000;

/**
 * Long ops: full-video re-encodes (subtitle burn-in, box cover, audio mux)
 * and the full dub-track concat/re-encode. 30 minutes — generous on purpose:
 * a false timeout that kills a job which would have succeeded (e.g. a long
 * HD source video genuinely taking a while to re-encode) is worse than
 * waiting a bit longer to confirm a genuine hang.
 */
export const FFMPEG_TIMEOUT_LONG_MS = 1_800_000;
