# Phase 4: Per-User Translation History

**Effort:** M
**Depends on:** Phase 3 (Auto-Detect) — must store the resolved `detectedLang`, not the literal `"auto"` string
**Blocks:** none

## Goal

Today's `TranslationHistory` is `localStorage`-only (frontend type in `frontend/src/app/types/index.ts`, lines 1-8) — lost on browser switch/clear, and the DB's `TranslationCache` is a global dedup cache with no `userId`. Add a real per-user backend history, capped at 50 rows/user (DEC-4), and switch the frontend to read from it.

## Files owned by this phase

- `backend/prisma/schema.prisma` — new `TranslationHistory` model + migration
- `backend/src/translation/translation.service.ts` — write-history-row after each successful translate, prune-beyond-50
- `backend/src/translation/translation.controller.ts` — `GET /translation/history`, `DELETE /translation/history`
- `backend/src/translation/translation.service.spec.ts` — history tests
- `frontend/src/app/components/TextTranslationSection.tsx` — replace `localStorage` read/write with backend fetch/delete
- `frontend/src/app/types/index.ts` — `TranslationHistory` interface gains `id` as a real DB id (string UUID, not `Math.random()`)

## Implementation notes

### Schema

```prisma
model TranslationHistory {
  id             String   @id @default(uuid())
  userId         String
  user           User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  sourceText     String
  translatedText String
  sourceLang     String   // resolved code, never the literal "auto"
  targetLang     String
  createdAt      DateTime @default(now())

  @@index([userId, createdAt])
}
```
Add `historyEntries TranslationHistory[]` to the `User` model's relation list.

Migration: `cd backend && npx prisma migrate dev --name add_translation_history`.

### Backend — write + prune

In `translation.service.ts::translate()`, after the existing cache-write + credit-deduct block (for both the whole-text-cache-hit early-return path AND the chunked path), add:
```ts
private async recordHistory(
  userId: string,
  sourceText: string,
  translatedText: string,
  sourceLang: string,
  targetLang: string,
): Promise<void> {
  try {
    await this.prisma.translationHistory.create({
      data: { userId, sourceText, translatedText, sourceLang, targetLang },
    });
    const count = await this.prisma.translationHistory.count({ where: { userId } });
    if (count > 50) {
      const stale = await this.prisma.translationHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'asc' },
        take: count - 50,
        select: { id: true },
      });
      await this.prisma.translationHistory.deleteMany({
        where: { id: { in: stale.map((s) => s.id) } },
      });
    }
  } catch (err) {
    // History is a convenience feature, not core to translation — never let
    // a history-write failure surface as a translate-request failure.
    this.logger.warn('Failed to record translation history:', err);
  }
}
```
Call `await this.recordHistory(userId, text, translatedText, resolvedSourceLang, targetLang);` right before `translate()` returns, using `resolvedSourceLang` = `detectedLang ?? sourceLang` (per Phase 3's `{ translatedText, detectedLang }` return shape) — this is the exact mechanism that ensures `"auto"` never lands in the `sourceLang` column.

### Backend — new endpoints

```ts
@UseGuards(JwtAuthGuard)
@Get('history')
async getHistory(@Request() req: RequestWithUser) {
  const history = await this.translationService.getHistory(req.user.id);
  return { success: true, history };
}

@UseGuards(JwtAuthGuard)
@Delete('history')
async clearHistory(@Request() req: RequestWithUser) {
  await this.translationService.clearHistory(req.user.id);
  return { success: true };
}
```
`translationService.getHistory(userId)` → `findMany({ where: { userId }, orderBy: { createdAt: 'desc' } })` (already capped at 50 by the prune-on-write, so no `take` needed, but add `take: 50` defensively anyway). `clearHistory(userId)` → `deleteMany({ where: { userId } })`.

### Frontend

`TextTranslationSection.tsx`:
- Remove the `useEffect` that reads `localStorage.getItem("tooldichj_history")` on mount; replace with a `fetchHistory()` call to `GET /translation/history` (same `useCallback` + `useEffect` pattern already used for `fetchVoices`/`fetchJobs` elsewhere in the codebase).
- `handleTranslate`'s `localStorage.setItem(...)` block is removed entirely — the backend now writes history as a side effect of the translate call; after a successful translate, just call `fetchHistory()` again to refresh the displayed list (or optimistically prepend the new record locally — prepend-and-refetch-on-next-mount is simplest and matches existing `refreshUser`-after-mutation patterns in the codebase).
- `clearHistory()` becomes `async`, calls `DELETE /translation/history`, then clears local state — no more `localStorage.removeItem`.
- `TranslationHistory` type (`types/index.ts`) `id` field changes from a client-generated random string to whatever the backend returns (still typed `string`, no interface shape change needed beyond the comment).

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| Existing users' `localStorage` history is silently lost on this phase's deploy (no migration path from client-side to server-side) | 4 | 2 | 8 | Accept as a one-time, low-stakes loss — translation history is a convenience feature, not financial/critical data; explicitly call this out to the user, do not attempt a client-side-to-server migration script (not worth the complexity for a "recent translations" list) |
| History writes add latency to the translate request's critical path | 2 | 2 | 4 | `recordHistory` failures are caught and logged, never thrown — and it's a single fast indexed insert; if this ever becomes a measured bottleneck, fire-and-forget (don't `await`) is the next optimization, not needed at this scale |
| Prune query (`findMany` + `deleteMany`) race when a user fires two translate requests concurrently, both crossing the 50-row threshold | 2 | 1 | 2 | Worst case is keeping 51-52 rows momentarily instead of exactly 50 — not a correctness issue, just a soft cap; acceptable |

## Timeline

| Step | Effort |
|------|--------|
| Schema + migration | S |
| Backend: `recordHistory` + prune + 2 new endpoints | M |
| Backend: tests | S |
| Frontend: swap `localStorage` for backend fetch/delete | S |
| **Total** | **M** |

## Verification

1. `cd backend && npx prisma migrate dev --name add_translation_history` runs clean, generates a migration file under `backend/prisma/migrations/`.
2. `cd backend && npm run test -- translation.service.spec` — history write/prune tests pass.
3. Manual: translate 3 times → `GET /translation/history` returns 3 rows, newest first, each with the *resolved* `sourceLang` (never `"auto"` even when Auto-detect was used).
4. Manual: translate 51+ times (or seed via Prisma Studio) → confirm exactly 50 rows remain for that user, oldest pruned.
5. Manual: click "Xóa tất cả" in the UI → `DELETE /translation/history` called, list empties, refresh page → still empty (confirms it's server-side now, not just local state).

## Rollback

Down-migration: `npx prisma migrate dev` generates the down path automatically via a new migration that drops `TranslationHistory` (Prisma doesn't auto-generate down-migrations for `migrate dev`; for rollback, run `npx prisma migrate resolve --rolled-back add_translation_history` then drop the table manually, OR simpler — since this is additive-only, just stop calling `recordHistory`/the two new endpoints by reverting the service/controller files; leaving the unused table in place is harmless until a deliberate cleanup migration). Revert `TextTranslationSection.tsx` to the Phase-2/3 state (still has chunking + auto-detect, just back to `localStorage` history).
