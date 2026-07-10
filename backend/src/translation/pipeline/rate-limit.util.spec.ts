import { isQuotaExhaustedError, withRetry } from './rate-limit.util';
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

describe('isQuotaExhaustedError — distinguishing genuine quota from transient RPM throttling', () => {
  it('treats billing-worded 429 WITHOUT retryDelay as genuine daily/billing exhaustion', () => {
    const err = new Error(
      'You exceeded your current quota, please check your plan and billing details.',
    );
    expect(isQuotaExhaustedError(err)).toBe(true);
  });

  it('treats billing-worded 429 WITH retryDelay as a transient per-minute rate limit, not unrecoverable', () => {
    const err = new Error(
      'You exceeded your current quota, please check your plan and billing details. {"error":{"details":[{"retryDelay":"5s"}]}}',
    );
    expect(isQuotaExhaustedError(err)).toBe(false);
  });

  it('plain rate-limit errors (no billing wording) are never quota-exhausted', () => {
    const err = new Error(
      '429 Too Many Requests: {"error":{"status":"RESOURCE_EXHAUSTED","message":"Please retry in 1s."}}',
    );
    expect(isQuotaExhaustedError(err)).toBe(false);
  });

  it('withRetry actually retries (not UnrecoverableError) on a billing-worded 429 that carries retryDelay', async () => {
    jest.useFakeTimers();
    // Mirrors the real @google/genai wire format: throwErrorIfNotOK() builds
    // the message via JSON.stringify(errorBody) — always compact, no spaces.
    const transientErr = new Error(
      '{"error":{"code":429,"status":"RESOURCE_EXHAUSTED","message":"You exceeded your current quota, please check your plan and billing details.","details":[{"@type":"type.googleapis.com/google.rpc.RetryInfo","retryDelay":"5s"}]}}',
    );
    const fn = jest
      .fn()
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValueOnce('ok');

    const promise = withRetry(fn, { maxAttempts: 2 });
    const assertion = expect(promise).resolves.toBe('ok');
    await jest.advanceTimersByTimeAsync(10000);
    await assertion;

    expect(fn).toHaveBeenCalledTimes(2);
    jest.useRealTimers();
  });
});
