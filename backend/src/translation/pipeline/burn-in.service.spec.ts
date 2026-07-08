import ffmpeg from 'fluent-ffmpeg';
import { coverSubtitleArea } from './burn-in.service';

jest.mock('fluent-ffmpeg', () => {
  const mockInstance = {
    outputOptions: jest.fn().mockReturnThis(),
    on: jest.fn().mockImplementation(function (
      this: any,
      event: string,
      cb: () => void,
    ) {
      if (event === 'end') cb();
      return this;
    }),
    save: jest.fn().mockReturnThis(),
  };
  const mockFfmpeg = jest.fn(() => mockInstance) as any;
  return { __esModule: true, default: mockFfmpeg };
});

const mockedFfmpeg = ffmpeg as unknown as jest.Mock;

function getVfFilter(): string {
  const instance = mockedFfmpeg.mock.results[0].value;
  const vfCall = instance.outputOptions.mock.calls.find(
    (c: unknown[]) => Array.isArray(c[0]) && (c[0] as string[])[0] === '-vf',
  );
  if (!vfCall) throw new Error('no -vf outputOptions call recorded');
  return (vfCall[0] as string[])[1];
}

describe('coverSubtitleArea', () => {
  beforeEach(() => {
    const instance = mockedFfmpeg.getMockImplementation()!() as any;
    instance.outputOptions.mockClear();
    mockedFfmpeg.mockClear();
  });

  it('draws an opaque filled box spanning exactly the detected band', async () => {
    await coverSubtitleArea('in.mp4', 'out.mp4', {
      yRatio: 0.8,
      heightRatio: 0.15,
    });

    const filter = getVfFilter();
    expect(filter).toContain('drawbox=');
    expect(filter).toContain('x=0');
    expect(filter).toContain('w=iw');
    expect(filter).toContain('y=ih*0.8');
    expect(filter).toContain('h=ih*0.15');
    // t=fill => fully opaque cover, not a translucent tint that leaves text legible.
    expect(filter).toContain('t=fill');
    // Regression guard: the old weak boxblur must be gone.
    expect(filter).not.toContain('boxblur');
  });
});
