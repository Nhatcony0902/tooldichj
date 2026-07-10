import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import { detectSubtitleRegion } from './subtitle-region.service';

jest.mock('fluent-ffmpeg', () => {
  const mockInstance = {
    screenshots: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function (this: any, event: string, cb: any) {
      if (event === 'end') cb();
      return this;
    }),
  };
  const mockFfmpeg = jest.fn(() => mockInstance) as any;
  return { __esModule: true, default: mockFfmpeg };
});

jest.mock('fs/promises', () => ({
  readFile: jest.fn().mockResolvedValue(Buffer.from('fake-jpeg')),
}));

jest.mock('./audio-extractor', () => ({
  getAudioDuration: jest.fn().mockResolvedValue(10),
}));

const RATE_LIMIT_ERR = Object.assign(
  new Error('429 Too Many Requests: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Please retry in 1s."}}'),
);
const QUOTA_EXHAUSTED_ERR = new Error(
  'You exceeded your current quota, please check your plan and billing details.',
);

function fakeAi(generateContent: jest.Mock) {
  return { models: { generateContent } } as any;
}

function found(yRatio: number, heightRatio: number) {
  return { text: JSON.stringify({ found: true, yRatio, heightRatio }) };
}
function notFound() {
  return { text: JSON.stringify({ found: false, yRatio: 0, heightRatio: 0 }) };
}

describe('detectSubtitleRegion — retry + fail-vs-empty distinction (B2)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    (fs.readFile as jest.Mock).mockClear();
  });
  afterEach(() => jest.useRealTimers());

  async function run(promise: Promise<any>) {
    const pending = promise.then(
      (v: any) => ({ ok: true, v }),
      (e: any) => ({ ok: false, e }),
    );
    await jest.advanceTimersByTimeAsync(60000);
    return pending;
  }

  it('one sample 429s then succeeds on retry: region detected, failedDueToError=false', async () => {
    const generateContent = jest
      .fn()
      .mockRejectedValueOnce(RATE_LIMIT_ERR)
      .mockResolvedValueOnce(found(0.8, 0.15))
      .mockResolvedValueOnce(found(0.8, 0.15))
      .mockResolvedValueOnce(found(0.8, 0.15));

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v.failedDueToError).toBe(false);
    expect(result.v.region).not.toBeNull();
  });

  it('all 3 samples 429 after retries: detectSubtitleRegion reports failedDueToError=true, region null', async () => {
    const generateContent = jest.fn().mockRejectedValue(RATE_LIMIT_ERR);

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v).toEqual({ region: null, failedDueToError: true });
    // 3 samples x 2 attempts (maxAttempts=2) = 6 calls
    expect(generateContent).toHaveBeenCalledTimes(6);
  });

  it('all samples genuinely show no subtitle: failedDueToError=false (legit, quiet skip — behavior unchanged)', async () => {
    const generateContent = jest.fn().mockResolvedValue(notFound());

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v).toEqual({ region: null, failedDueToError: false });
  });

  it('first sample hits daily quota exhaustion: loop short-circuits, remaining samples are not called', async () => {
    const generateContent = jest.fn().mockRejectedValue(QUOTA_EXHAUSTED_ERR);

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v).toEqual({ region: null, failedDueToError: true });
    // Quota-exhausted is not retried and aborts the whole loop after sample 0.
    expect(generateContent).toHaveBeenCalledTimes(1);
  });

  it('samples disagree on position (bottom caption majority, one stray top detection): picks the majority band, does not span the whole frame', async () => {
    const generateContent = jest
      .fn()
      .mockResolvedValueOnce(found(0.8, 0.15))
      .mockResolvedValueOnce(found(0.82, 0.13))
      .mockResolvedValueOnce(found(0.05, 0.08)); // stray detection elsewhere in the frame

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v.region).not.toBeNull();
    // Majority cluster is the two bottom detections — region must stay a thin
    // bottom band, not the envelope from the stray top sample to the bottom.
    expect(result.v.region.yRatio).toBeGreaterThan(0.5);
    expect(result.v.region.heightRatio).toBeLessThan(0.3);
  });

  it('a genuine tie (one top detection, one bottom detection, no majority) skips rather than guessing which side is real', async () => {
    const generateContent = jest
      .fn()
      .mockResolvedValueOnce(found(0.05, 0.08))
      .mockResolvedValueOnce(found(0.85, 0.1));

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp', [1, 2]),
    );

    expect(result.ok).toBe(true);
    expect(result.v).toEqual({ region: null, failedDueToError: false });
  });

  it('an implausibly tall detected band (agreed by all samples) is treated as unsafe and skipped', async () => {
    const generateContent = jest.fn().mockResolvedValue(found(0.1, 0.5));

    const result = await run(
      detectSubtitleRegion(fakeAi(generateContent), 'in.mp4', '/tmp'),
    );

    expect(result.ok).toBe(true);
    expect(result.v).toEqual({ region: null, failedDueToError: false });
  });
});
