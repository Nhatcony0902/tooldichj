# Phase 1 — Shared foundation: schema + migration + retry-predicate + typed error

Effort: **S** · Depends on: none · Blocks: Phase 2, Phase 3, Phase 4

## Goal

Land the shared pieces both backend phases consume: the two `VideoJob` status columns, an additive `retryable` predicate on `withRetry`, and the `IncompleteTranslationError` type. Pure additive — no behavior change to any existing code path.

## Files owned

- `backend/prisma/schema.prisma`
- `backend/prisma/migrations/<timestamp>_add_degraded_completion_status_to_video_job/migration.sql` (NEW)
- `backend/src/translation/pipeline/rate-limit.util.ts`
- `backend/src/translation/pipeline/incomplete-translation.error.ts` (NEW)

## Tasks

### 1. Schema — two typed columns on `VideoJob` (`schema.prisma:69-89`)

Add alongside the existing flat columns (after `errorMessage`, mirroring style):

```prisma
untranslatedSegmentCount Int     @default(0) // segments left as source text after retries exhausted (B1)
blurStatus               String? // null=not requested | 'applied' | 'skipped_no_subtitle' | 'skipped_error' (B2)
```

### 2. Migration (follow `20260629074522_add_remove_source_subs_to_video_job/migration.sql`)

```sql
-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "untranslatedSegmentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VideoJob" ADD COLUMN     "blurStatus" TEXT;
```

Generate with `npx prisma migrate dev --name add_degraded_completion_status_to_video_job` (needs `DATABASE_URL`). If offline, hand-write the SQL in the precedent's directory shape and run `npx prisma generate` to refresh the client types.

### 3. `withRetry` — optional `retryable` predicate (`rate-limit.util.ts:30-77`)

Additive, backward-compatible. Extend `RetryOptions`:

```typescript
export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  retryable?: (err: unknown) => boolean; // extra retry condition, OR-ed with the rate-limit check
}
```

In the loop's decision line (currently `:70`), treat the error as retryable when it is a rate-limit error OR the caller's predicate matches:

```typescript
const extra = opts.retryable?.(err) ?? false;
if ((!isRateLimitError(err) && !extra) || attempt === maxAttempts - 1) throw err;
```

Quota-exhausted short-circuit (`:65-69`) stays FIRST and unchanged. For a non-429 "incomplete" error there is no Gemini `retryDelay`, so `parseGeminiRetryMs` returns null and the existing exponential `baseDelayMs * 2 ** attempt` applies — exactly the backoff the brief calls for.

### 4. `IncompleteTranslationError` (NEW `incomplete-translation.error.ts`)

Standalone file (avoids an import cycle — `groq-translate` and `subtitle.service` both need it, and `subtitle.service` imports `groq-translate`):

```typescript
export class IncompleteTranslationError extends Error {
  constructor(
    readonly partial: string[], // best-effort array; empty string marks an untranslated slot
    readonly expected: number,
  ) {
    super(`Incomplete translation: expected ${expected}, usable ${partial.filter((t) => t.trim()).length}`);
    this.name = 'IncompleteTranslationError';
  }
}

export function isIncompleteTranslationError(e: unknown): e is IncompleteTranslationError {
  return e instanceof IncompleteTranslationError;
}
```

## Verify

- `cd backend && npx prisma validate` → schema valid.
- `cd backend && npm run build` → 0 errors (TS strict; no `any`).
- Unit: `withRetry(() => { throw new IncompleteTranslationError([], 3); }, { retryable: isIncompleteTranslationError, maxAttempts: 3 })` retries 3× then throws; without the predicate it throws on first attempt (proves backward-compat).

## Rollback

Revert `schema.prisma` + `rate-limit.util.ts`, delete the new error file, drop the migration (`ALTER TABLE "VideoJob" DROP COLUMN ...` — additive columns, safe).
