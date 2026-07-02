# Phase 1 — Rate-Limit Fix (Translation)

**Issue 1.** Gemini Free tier is 15 RPM. `translateSegments()` loops with no delay → segment 3+ get HTTP 429 → falls to `mockTranslate()` → output shows `[Mock Dịch sang vi]: <original>`.

## Goal

Translate all segments reliably under the 15 RPM cap: 4.2s delay between segments + 429-aware exponential backoff, with mock as last resort only after retries exhausted. Create the shared rate-limit utility that Phase 4 will reuse.

## Files touched

| File | Change |
|------|--------|
| `backend/src/translation/pipeline/rate-limit.util.ts` | **NEW** — shared sleep + 429 detection + `withRetry` |
| `backend/src/translation/pipeline/subtitle.service.ts` | add delay + retry wrapper in `translateSegments()` loop |
| `backend/src/translation/pipeline/video-pipeline.worker.ts` | (optional) per-segment progress callback for R1 mitigation |

Ownership note: `subtitle.service.ts` is also touched by Phase 2 (`buildSrt`). **Phase 1 runs before Phase 2.** Different functions, same file.

## Exact changes

### 1. NEW `rate-limit.util.ts`
```typescript
/** Gemini Free tier = 15 RPM → 60000/15 = 4000ms; +200ms safety margin. */
export const GEMINI_FREE_RPM_DELAY_MS = 4200;

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** True for HTTP 429 / Gemini RESOURCE_EXHAUSTED quota errors. */
export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Gemini SDK surfaces 429 in the message / status; match both shapes.
  return (
    /\b429\b/.test(msg) ||
    /RESOURCE_EXHAUSTED/i.test(msg) ||
    /rate limit|quota/i.test(msg)
  );
}

export interface RetryOptions {
  maxAttempts?: number; // default 3
  baseDelayMs?: number; // default 4000 → 4s, 8s, 16s
}

/**
 * Run `fn`; on a rate-limit error retry with exponential backoff (4s→8s→16s).
 * Non-429 errors throw immediately (no point retrying a malformed request).
 * After maxAttempts the last error propagates — the CALLER decides whether to
 * fall back to mock (we never silently swallow here; SSOT errors-over-fallbacks).
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
      if (!isRateLimitError(err) || attempt === maxAttempts - 1) throw err;
      await sleep(baseDelayMs * 2 ** attempt); // 4s, 8s, 16s
    }
  }
  throw lastErr;
}
```

### 2. `subtitle.service.ts` — `translateSegments()`
Wrap each `translate()` call in `withRetry`, add a per-segment delay, and add an optional progress callback (R1 mitigation):
```typescript
import { GEMINI_FREE_RPM_DELAY_MS, sleep, withRetry } from './rate-limit.util';

export async function translateSegments(
  translationService: TranslationService,
  userId: string,
  segments: TranscriptSegment[],
  sourceLang: string,
  targetLang: string,
  onProgress?: (done: number, total: number) => void, // R1: surface X/Y
): Promise<TranslatedSegment[]> {
  const translated: TranslatedSegment[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const { translatedText } = await withRetry(() =>
      translationService.translate(userId, segment.text, sourceLang, targetLang, false),
    );
    translated.push({ ...segment, translatedText: translatedText || segment.text });
    onProgress?.(i + 1, segments.length);
    if (i < segments.length - 1) await sleep(GEMINI_FREE_RPM_DELAY_MS);
  }
  return translated;
}
```

**Design note on mock fallback:** `translate()` internally still falls back to mock when the API key is missing or after its own failure. `withRetry` retries the 429 BEFORE `translate()`'s mock path is reached only if `translate()` re-throws 429. **Verify during implementation** whether `translate()` currently swallows 429 into mock internally (same pattern as `tts.service.ts:209`). If it does, the retry must wrap the inner Gemini call, OR `translate()` must be made to re-throw 429 when `chargeCredit=false` (video context). Pick the minimal change that lets `withRetry` see the 429 — document the chosen approach in the commit. This is the one item in Phase 1 that needs a code read before finalizing.

### 3. `video-pipeline.worker.ts` (optional, R1)
Pass an `onProgress` that updates `stepDescription` to `Đang dịch phụ đề... (X/Y)` so the long delay is visible to the user. Keep DB writes throttled (e.g. every segment is fine at ~4s cadence).

## Risk assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Delay slows job (R1) | 5 | 2 | 10 | progress X/Y callback |
| `translate()` swallows 429 internally so `withRetry` never sees it | 3 | 4 | 12 | read `translate()` impl during step 2; make inner call re-throw 429 in video context |

## Verify steps

1. `cd backend && npm run build` → exits 0.
2. Add `rate-limit.util.spec.ts`: `withRetry` mock that throws 429 twice then resolves → resolves on 3rd; mock that throws 429 thrice → rejects (no swallow). Non-429 → throws immediately, no retry.
3. `cd backend && npm test` → green.
4. Manual: run a video job with ≥4 segments → output SRT contains REAL translations, zero `[Mock Dịch sang vi]` lines.
