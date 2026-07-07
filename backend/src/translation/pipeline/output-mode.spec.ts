import {
  isValidOutputMode,
  outputModeIncludesBurn,
  outputModeIncludesDub,
  outputModeProducesVideo,
} from './output-mode';

describe('output-mode', () => {
  it('accepts all four supported modes', () => {
    expect(isValidOutputMode('srt')).toBe(true);
    expect(isValidOutputMode('burn')).toBe(true);
    expect(isValidOutputMode('dub')).toBe(true);
    expect(isValidOutputMode('burn+dub')).toBe(true);
  });

  it('rejects unknown modes', () => {
    expect(isValidOutputMode('')).toBe(false);
    expect(isValidOutputMode('mp3')).toBe(false);
    expect(isValidOutputMode('dub+burn')).toBe(false);
  });

  it('outputModeIncludesBurn matches burn and burn+dub only', () => {
    expect(outputModeIncludesBurn('burn')).toBe(true);
    expect(outputModeIncludesBurn('burn+dub')).toBe(true);
    expect(outputModeIncludesBurn('dub')).toBe(false);
    expect(outputModeIncludesBurn('srt')).toBe(false);
  });

  it('outputModeIncludesDub matches dub and burn+dub only', () => {
    expect(outputModeIncludesDub('dub')).toBe(true);
    expect(outputModeIncludesDub('burn+dub')).toBe(true);
    expect(outputModeIncludesDub('burn')).toBe(false);
    expect(outputModeIncludesDub('srt')).toBe(false);
  });

  it('outputModeProducesVideo is false only for srt', () => {
    expect(outputModeProducesVideo('srt')).toBe(false);
    expect(outputModeProducesVideo('burn')).toBe(true);
    expect(outputModeProducesVideo('dub')).toBe(true);
    expect(outputModeProducesVideo('burn+dub')).toBe(true);
  });
});
