import ffmpeg from 'fluent-ffmpeg';
import { blurSubtitleArea } from './burn-in.service';

jest.mock('fluent-ffmpeg', () => {
  const mockInstance = {
    complexFilter: jest.fn().mockReturnThis(),
    outputOptions: jest.fn().mockReturnThis(),
    on: jest.fn().mockReturnThis(),
    save: jest.fn().mockReturnThis(),
  };
  const mockFfmpeg = jest.fn(() => mockInstance) as any;
  mockFfmpeg.ffprobe = jest.fn();
  return { __esModule: true, default: mockFfmpeg };
});

const mockedFfmpeg = ffmpeg as unknown as jest.Mock & {
  ffprobe: jest.Mock;
};

function mockProbeHeight(height: number) {
  mockedFfmpeg.ffprobe.mockImplementation((_path: string, cb: any) => {
    cb(null, { streams: [{ codec_type: 'video', height }] });
  });
}

function getBuiltFilter(): string {
  const instance = mockedFfmpeg.mock.results[0].value;
  return instance.complexFilter.mock.calls[0][0];
}

describe('blurSubtitleArea', () => {
  beforeEach(() => {
    mockedFfmpeg.mockClear();
    mockedFfmpeg.ffprobe.mockReset();
  });

  it('clamps the blur radius for a thin detected band (480p, heightRatio 0.05)', async () => {
    mockProbeHeight(480);

    // Fire the 'end' handler synchronously so the returned promise resolves.
    const onSpy = jest.fn().mockImplementation(function (
      this: any,
      event: string,
      handler: () => void,
    ) {
      if (event === 'end') handler();
      return this;
    });
    mockedFfmpeg.mockImplementationOnce(() => ({
      complexFilter: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      on: onSpy,
      save: jest.fn().mockReturnThis(),
    }));

    await blurSubtitleArea('in.mp4', 'out.mp4', {
      yRatio: 0.9,
      heightRatio: 0.05,
    });

    const filter = getBuiltFilter();
    // bandHeightPx = 480 * 0.05 = 24 -> radius = min(20, floor(24/2)-1) = 11
    expect(filter).toContain('boxblur=11:2');
    expect(filter).not.toContain('boxblur=20:2');
  });

  it('keeps the default radius of 20 for a normal band (1080p, heightRatio 0.15)', async () => {
    mockProbeHeight(1080);

    const onSpy = jest.fn().mockImplementation(function (
      this: any,
      event: string,
      handler: () => void,
    ) {
      if (event === 'end') handler();
      return this;
    });
    mockedFfmpeg.mockImplementationOnce(() => ({
      complexFilter: jest.fn().mockReturnThis(),
      outputOptions: jest.fn().mockReturnThis(),
      on: onSpy,
      save: jest.fn().mockReturnThis(),
    }));

    await blurSubtitleArea('in.mp4', 'out.mp4', {
      yRatio: 0.8,
      heightRatio: 0.15,
    });

    const filter = getBuiltFilter();
    // bandHeightPx = 1080 * 0.15 = 162 -> radius = min(20, floor(162/2)-1) = 20
    expect(filter).toContain('boxblur=20:2');
  });
});
