import { deriveProsody, prosodySignature } from './prosody.util';

describe('deriveProsody', () => {
  it('returns urgent params (rate/pitch/volume) for an exclamatory imperative line', () => {
    const result = deriveProsody('Nhanh lên, đi bắt hải sản!');
    expect(result).toBeDefined();
    expect(result!.rate).toBe('+12%');
    expect(result!.pitch).toBe('+8%');
    expect(result!.volume).toBe('+8%');
  });

  it('returns undefined (neutral) for a short, unremarkable statement', () => {
    const result = deriveProsody('Xin chào.');
    expect(result).toBeUndefined();
  });

  it('urgent and neutral segments get distinct prosody params', () => {
    const urgent = deriveProsody('Dừng lại ngay!');
    const neutral = deriveProsody('Xin chào.');
    expect(urgent).not.toEqual(neutral);
  });

  it('returns a mild pitch bump for a question, with no rate change', () => {
    const result = deriveProsody('Bạn có khỏe không?');
    expect(result).toEqual({ pitch: '+6%' });
  });

  it('returns a lowered pitch only (never a negative rate) for a long trailing-off statement', () => {
    const result = deriveProsody(
      'Hôm nay trời khá đẹp và mọi người đều cảm thấy rất thoải mái.',
    );
    expect(result).toEqual({ pitch: '-6%' });
    expect(result!.rate).toBeUndefined();
  });

  it('does not treat a short calm-looking sentence as trailing-off (below the word-count threshold)', () => {
    const result = deriveProsody('Trời đẹp.');
    expect(result).toBeUndefined();
  });

  it('never derives a negative rate for any input (soft-sync safety invariant)', () => {
    const samples = [
      'Nhanh lên, đi bắt hải sản!',
      'Dừng lại ngay!',
      'CẨN THẬN phía trước',
      'Bạn có khỏe không?',
      'Hôm nay trời khá đẹp và mọi người đều cảm thấy rất thoải mái.',
      'Xin chào.',
    ];
    for (const text of samples) {
      const result = deriveProsody(text);
      if (result?.rate !== undefined) {
        const numeric = parseFloat(String(result.rate));
        expect(numeric).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('detects an ALL-CAPS run as urgent even without trailing punctuation', () => {
    const result = deriveProsody('CẨN THẬN phía trước có chướng ngại vật');
    expect(result).toBeDefined();
    expect(result!.rate).toBe('+12%');
  });

  it('returns undefined for empty/whitespace-only text', () => {
    expect(deriveProsody('')).toBeUndefined();
    expect(deriveProsody('   ')).toBeUndefined();
  });

  it('does not treat "đi" inside an unrelated word (e.g. "Điện thoại") as the imperative cue', () => {
    const result = deriveProsody('Điện thoại đang đổ chuông trong phòng.');
    expect(result).toBeUndefined();
  });

  it('still matches "đi" as a standalone imperative word ("Đi ngay")', () => {
    const result = deriveProsody('Đi ngay đi!');
    expect(result).toBeDefined();
    expect(result!.rate).toBe('+12%');
  });

  it('detects an ALL-CAPS run as urgent with no imperative-cue overlap', () => {
    const result = deriveProsody('Phía trước có NGUY HIỂM đó');
    expect(result).toBeDefined();
    expect(result!.rate).toBe('+12%');
  });
});

describe('prosodySignature', () => {
  it('is an empty string for undefined (preserves pre-prosody cache keys exactly)', () => {
    expect(prosodySignature(undefined)).toBe('');
  });

  it('produces distinct signatures for different prosody options', () => {
    const a = prosodySignature({ rate: '+12%', pitch: '+8%', volume: '+8%' });
    const b = prosodySignature({ pitch: '+6%' });
    expect(a).not.toBe(b);
    expect(a).not.toBe('');
    expect(b).not.toBe('');
  });

  it('is deterministic for the same prosody options', () => {
    const opts = { rate: '+12%', pitch: '+8%', volume: '+8%' };
    expect(prosodySignature(opts)).toBe(prosodySignature({ ...opts }));
  });
});
