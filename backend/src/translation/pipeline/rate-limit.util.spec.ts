import { withRetry } from './rate-limit.util';
import {
  IncompleteTranslationError,
  isIncompleteTranslationError,
} from './incomplete-translation.error';

describe('withRetry — retryable predicate (Phase 1)', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('retries up to maxAttempts on an error matching the predicate, then throws', async () => {
    const fn = jest.fn().mockImplementation(() => {
      throw new IncompleteTranslationError([], 3);
    });

    const promise = withRetry(fn, {
      retryable: isIncompleteTranslationError,
      maxAttempts: 3,
    });
    const assertion = expect(promise).rejects.toThrow(IncompleteTranslationError);
    await jest.advanceTimersByTimeAsync(60000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });

  it('without the predicate, throws immediately on a non-rate-limit error (backward compat)', async () => {
    const fn = jest.fn().mockImplementation(() => {
      throw new IncompleteTranslationError([], 3);
    });

    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow(
      IncompleteTranslationError,
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('succeeds without retrying once the predicate-matched error stops occurring', async () => {
    let call = 0;
    const fn = jest.fn().mockImplementation(() => {
      call += 1;
      if (call < 3) throw new IncompleteTranslationError([], 3);
      return Promise.resolve('ok');
    });

    const promise = withRetry(fn, {
      retryable: isIncompleteTranslationError,
      maxAttempts: 5,
    });
    const assertion = expect(promise).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(60000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(3);
  });
});
