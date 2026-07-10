import { withFfmpegTimeout } from './ffmpeg-timeout.util';

describe('withFfmpegTimeout', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('rejects with a clear timeout error when the wrapped promise never settles', async () => {
    const neverSettles = new Promise<void>(() => {
      // Simulates a hung ffprobe/ffmpeg child process that never calls back.
    });

    const promise = withFfmpegTimeout(neverSettles, 'stuck-op', 5000);
    const assertion = expect(promise).rejects.toThrow(
      'ffmpeg timeout after 5000ms: stuck-op',
    );
    await jest.advanceTimersByTimeAsync(5000);
    await assertion;
  });

  it('resolves normally when the wrapped promise settles before the timeout', async () => {
    const fast = Promise.resolve('done');
    const promise = withFfmpegTimeout(fast, 'fast-op', 5000);
    await expect(promise).resolves.toBe('done');
  });

  it('propagates the original rejection when the wrapped promise rejects before the timeout', async () => {
    const failing = Promise.reject(new Error('ffprobe: invalid data'));
    const promise = withFfmpegTimeout(failing, 'failing-op', 5000);
    await expect(promise).rejects.toThrow('ffprobe: invalid data');
  });
});
