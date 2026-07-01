import { UnrecoverableError } from 'bullmq';

/** Gemini Free tier = 15 RPM → 60000/15 = 4000ms; +200ms safety margin. */
export const GEMINI_FREE_RPM_DELAY_MS = 4200;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * True for daily/billing quota exhaustion — NOT a transient rate limit.
 * These errors should NOT be retried; retrying wastes Groq STT quota too
 * (the BullMQ job re-runs the whole pipeline on each attempt).
 */
export function isQuotaExhaustedError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /billing details|check your plan|exceeded your current quota/i.test(msg);
}

/** True for HTTP 429 / Gemini RESOURCE_EXHAUSTED per-minute rate limit errors. */
export function isRateLimitError(err: unknown): boolean {
  if (isQuotaExhaustedError(err)) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return (
    /\b429\b/.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /rate limit|quota/i.test(msg)
  );
}

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
}

/**
 * Parse the `retryDelay` field Gemini embeds in its 429 error JSON body.
 * Returns milliseconds, or null if the field is absent/unparseable.
 */
function parseGeminiRetryMs(err: unknown): number | null {
  const msg = err instanceof Error ? err.message : String(err);
  const match = msg.match(/"retryDelay":"(\d+(?:\.\d+)?)s"/);
  if (match) return Math.ceil(parseFloat(match[1]) * 1000);
  return null;
}

/**
 * Run `fn`; on a rate-limit error retry honoring Gemini's retryDelay field
 * (falls back to exponential 4s→8s→16s if the field is absent).
 * Non-429 errors throw immediately. After maxAttempts the last error propagates.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 4000;
  let lastErr: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Daily/billing quota exhausted — retrying wastes Groq STT calls too.
      // Throw UnrecoverableError so BullMQ skips all remaining attempts.
      if (isQuotaExhaustedError(err)) {
        throw new UnrecoverableError(
          'Gemini API daily quota exhausted. Vui lòng kiểm tra plan/billing hoặc thử lại vào ngày mai.',
        );
      }
      if (!isRateLimitError(err) || attempt === maxAttempts - 1) throw err;
      const retryMs =
        parseGeminiRetryMs(err) ?? baseDelayMs * 2 ** attempt;
      await sleep(retryMs);
    }
  }
  throw lastErr;
}
