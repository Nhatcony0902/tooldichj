import { translateSegments } from './subtitle.service';
import { translateBatchViaGroq } from './groq-translate.service';
import { IncompleteTranslationError } from './incomplete-translation.error';
import { TranscriptSegment } from './stt.service';

jest.mock('./groq-translate.service');

const mockedGroq = translateBatchViaGroq as jest.MockedFunction<
  typeof translateBatchViaGroq
>;

function segments(texts: string[]): TranscriptSegment[] {
  return texts.map((text, i) => ({ start: i, end: i + 1, text }));
}

function fakeTranslationService(translateBatch: jest.Mock) {
  return { translateBatch } as any;
}

// Mirrors the real producer contract established in Phase 2: a producer
// either resolves with a COMPLETE array, or throws IncompleteTranslationError
// (it never silently returns a short/empty array).
function incomplete(partial: string[], expected: number) {
  return new IncompleteTranslationError(partial, expected);
}

describe('translateSegments — retry-before-fallback contract (B1)', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockedGroq.mockReset();
  });
  afterEach(() => jest.useRealTimers());

  async function run(promise: Promise<any>) {
    // Drain any withRetry backoff delays without waiting real time.
    const pending = promise.then(
      (v) => ({ ok: true, v }),
      (e) => ({ ok: false, e }),
    );
    await jest.advanceTimersByTimeAsync(120000);
    return pending;
  }

  it('Groq returns incomplete on attempts 1-2, complete on attempt 3: job fully translated, count 0, Gemini never called', async () => {
    mockedGroq
      .mockRejectedValueOnce(incomplete(['a', ''], 2))
      .mockRejectedValueOnce(incomplete(['a', ''], 2))
      .mockResolvedValueOnce(['a', 'b']);
    const translateBatch = jest.fn();

    const result = await run(
      translateSegments(
        fakeTranslationService(translateBatch),
        'u1',
        segments(['x', 'y']),
        'en',
        'vi',
      ),
    );

    expect(result).toEqual({
      ok: true,
      v: {
        segments: [
          { start: 0, end: 1, text: 'x', translatedText: 'a' },
          { start: 1, end: 2, text: 'y', translatedText: 'b' },
        ],
        untranslatedCount: 0,
      },
    });
    expect(mockedGroq).toHaveBeenCalledTimes(3);
    expect(translateBatch).not.toHaveBeenCalled();
  });

  it('Groq exhausts retries (always incomplete), Gemini returns full: fully translated via Gemini, count 0', async () => {
    mockedGroq.mockRejectedValue(incomplete(['a', ''], 2));
    const translateBatch = jest.fn().mockResolvedValue(['a', 'b']);

    const result = await run(
      translateSegments(
        fakeTranslationService(translateBatch),
        'u1',
        segments(['x', 'y']),
        'en',
        'vi',
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.v.untranslatedCount).toBe(0);
    expect(result.v.segments.map((s: any) => s.translatedText)).toEqual([
      'a',
      'b',
    ]);
    expect(translateBatch).toHaveBeenCalled();
  });

  it('both Groq and Gemini stay incomplete every attempt: degrades and COMPLETES with an accurate untranslatedCount', async () => {
    mockedGroq.mockRejectedValue(incomplete(['a', ''], 2)); // segment 2 always empty
    const translateBatch = jest
      .fn()
      .mockRejectedValue(incomplete(['', ''], 2)); // Gemini also incomplete every time

    const result = await run(
      translateSegments(
        fakeTranslationService(translateBatch),
        'u1',
        segments(['x', 'y']),
        'en',
        'vi',
      ),
    );

    expect(result.ok).toBe(true);
    expect(result.v.untranslatedCount).toBe(2);
    // Fallback text is the ORIGINAL source text, not silently invented.
    expect(result.v.segments).toEqual([
      { start: 0, end: 1, text: 'x', translatedText: 'x' },
      { start: 1, end: 2, text: 'y', translatedText: 'y' },
    ]);
  });

  it('R1 gate: a genuine non-incomplete Gemini error (after Groq fails) FAILS the job visibly — no silent success', async () => {
    mockedGroq.mockRejectedValue(new Error('Groq translate 500: server error'));
    const translateBatch = jest
      .fn()
      .mockRejectedValue(new Error('Gemini trả về định dạng không hợp lệ. Raw: ...'));

    const result = await run(
      translateSegments(
        fakeTranslationService(translateBatch),
        'u1',
        segments(['x', 'y']),
        'en',
        'vi',
      ),
    );

    expect(result.ok).toBe(false);
    expect(result.e.message).toMatch(/không hợp lệ/);
  });
});
