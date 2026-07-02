# Phase 2 — B1: translate retry-before-fallback + untranslated-count surfacing

Effort: **M** · Depends on: Phase 1 · Blocks: Phase 3 (shared `video-pipeline.worker.ts`)

## Goal

Stop the translate path from silently substituting source text for missing/empty API results. Retry the whole batch (Groq→Gemini, each via `withRetry`) BEFORE any fallback; only after retries exhaust, pad-with-source ONCE in `subtitle.service` and record `untranslatedSegmentCount`. Remove the duplicated producer-side padding.

## Files owned

- `backend/src/translation/pipeline/groq-translate.service.ts`
- `backend/src/translation/translation.service.ts`
- `backend/src/translation/pipeline/subtitle.service.ts`
- `backend/src/translation/pipeline/video-pipeline.worker.ts` (translate site ~128 + persist)

## Tasks

### 1. `groq-translate.service.ts:83-92` — throw instead of pad

Replace the length-mismatch pad block. Treat length mismatch OR any empty/whitespace item as incomplete:

```typescript
const arr = translations as string[];
const complete = arr.length === texts.length && arr.every((t) => t.trim().length > 0);
if (complete) return arr;
// best-effort partial: keep good slots, empty-mark the rest (padding happens once, in subtitle.service)
const partial = texts.map((_, i) => (arr[i]?.trim() ? arr[i] : ''));
throw new IncompleteTranslationError(partial, texts.length);
```

Keep the existing `!response.ok` throw and the string-array validation throws (`:50-81`) — those are real errors, unchanged.

### 2. `translation.service.ts translateBatch:606-627` — throw instead of pad

Keep the full-length happy path (`:610-617`). Replace the pad branch (`:618-622`) with the same incompleteness throw:

```typescript
if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
  const arr = parsed as string[];
  const complete = arr.length === texts.length && arr.every((t) => t.trim().length > 0);
  if (complete) return arr;
  const partial = texts.map((_, i) => (arr[i]?.trim() ? arr[i] : ''));
  throw new IncompleteTranslationError(partial, texts.length);
}
```

Keep the unparseable-response throw (`:628-629`) — a genuine error that must FAIL the job.

### 3. `subtitle.service.ts translateSegments:55-84` — retry, then pad+count ONCE

- Wrap both calls in `withRetry(fn, { retryable: isIncompleteTranslationError })` so an incomplete result retries the whole batch.
- Catch flow: try Groq → on any error fall back to Gemini (existing `catch`) → if the FINAL error is `IncompleteTranslationError`, use its `.partial`; otherwise **rethrow** (real error → job fails visibly).
- Final assembly + count (replaces the `translatedTexts[i] || segment.text` masking at `:82`):

```typescript
let usable: string[];
try {
  usable = await withRetry(() => translateBatchViaGroq(texts, sourceLang, targetLang), { retryable: isIncompleteTranslationError });
} catch (groqErr) {
  logger.warn(`Groq failed, falling back to Gemini: ${msg(groqErr)}`);
  try {
    usable = await withRetry(() => translationService.translateBatch(texts, sourceLang, targetLang), { retryable: isIncompleteTranslationError });
  } catch (geminiErr) {
    if (!isIncompleteTranslationError(geminiErr)) throw geminiErr; // real error → fail the job
    usable = geminiErr.partial;
  }
}
let untranslatedCount = 0;
const out = segments.map((segment, i) => {
  const t = usable[i]?.trim();
  if (t) return { ...segment, translatedText: usable[i] };
  untranslatedCount += 1;
  return { ...segment, translatedText: segment.text }; // recorded fallback, not silent
});
if (untranslatedCount > 0) logger.warn(`translateSegments: ${untranslatedCount}/${segments.length} segments left as source after retries`);
return { segments: out, untranslatedCount };
```

- Change the return type to `Promise<{ segments: TranslatedSegment[]; untranslatedCount: number }>`.
- Note the Groq `catch` path: if Groq threw `IncompleteTranslationError`, we discard its partial and try Gemini fresh (Gemini may fully translate). Only Gemini's partial is used as the last resort — acceptable and simplest.

### 4. `video-pipeline.worker.ts:128-155` — consume the new shape + persist

- Destructure: `const { segments: translatedSegments, untranslatedCount } = await translateSegments(...)`.
- After the existing `translatedSegments` persist (`:143-150`), if `untranslatedCount > 0`, write it (direct `prisma.videoJob.update`, since `updateJob` only allows status/progress/stepDescription):

```typescript
if (untranslatedCount > 0) {
  await this.prisma.videoJob.update({ where: { id: jobId }, data: { untranslatedSegmentCount: untranslatedCount } });
  this.logger.warn(`VideoJob ${jobId}: ${untranslatedCount} segments could not be translated (left as source)`);
}
```

Do NOT touch the blur site (~242) — that's Phase 3.

## Verify

- `cd backend && npm run build` → 0 errors.
- `cd backend && npm test` → green; update `translation.service.spec.ts` for the new throw (R5).
- Unit tests per the plan Test Matrix rows for Phase 2, including the **R1 gate**: incomplete-then-complete retry fully translates (count 0); a non-incomplete Gemini error FAILS the job (no silent success).

## Rollback

Revert the four files' Phase-2 edits (revert the worker translate-site hunk only if Phase 3 already landed).
