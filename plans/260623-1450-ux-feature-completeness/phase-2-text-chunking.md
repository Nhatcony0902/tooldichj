# Phase 2: Long Text Chunking

**Effort:** M
**Depends on:** none
**Blocks:** Phase 3 (Auto-Detect), Phase 4 (History) — both extend this phase's call site in `translation.service.ts`

## Goal

Text > ~6,000 chars today is sent to Gemini in a single `generateContent` call, risking truncation/quality loss. Split into paragraph-aware chunks, translate each (sequentially, preserving order), concatenate, and charge credits per chunk (DEC-5). Enforce a 20,000-char hard cap (DEC-6).

## Files owned by this phase

- `backend/src/translation/translation.service.ts` — chunking logic + multi-call orchestration in `translate()`
- `backend/src/translation/translation.controller.ts` — 20,000-char `BadRequestException` check
- `backend/src/translation/translation.service.spec.ts` — chunking tests
- `frontend/src/app/components/TextTranslationSection.tsx` — live char counter + dynamic "~N Credits" label, 20,000-char `maxLength` warning

## Implementation notes

### Backend — chunking algorithm (new private method in `translation.service.ts`)

```ts
const CHUNK_SIZE = 6000;
const MAX_TEXT_LENGTH = 20000;

private splitIntoChunks(text: string): string[] {
  if (text.length <= CHUNK_SIZE) return [text];

  // 1. Split on paragraph boundaries first (never break mid-sentence as a first resort).
  const paragraphs = text.split(/\n{2,}/);
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const candidate = current ? `${current}\n\n${para}` : para;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
      continue;
    }
    if (current) chunks.push(current);
    // 2. A single paragraph longer than CHUNK_SIZE: fall back to sentence-boundary splitting.
    if (para.length > CHUNK_SIZE) {
      chunks.push(...this.splitParagraphBySentence(para));
      current = '';
    } else {
      current = para;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

private splitParagraphBySentence(paragraph: string): string[] {
  const sentences = paragraph.split(/(?<=[.!?])\s+/);
  const chunks: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length <= CHUNK_SIZE) {
      current = candidate;
    } else {
      if (current) chunks.push(current);
      current = sentence; // a single sentence longer than CHUNK_SIZE is sent as-is (rare edge case)
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
```

### Backend — `translate()` orchestration changes

The existing `translate()` does: credit-check → cache-lookup-by-whole-text-hash → single Gemini call → cache-write → 1-credit deduct. Restructure to:

1. Keep the existing whole-text cache lookup FIRST (cache key unchanged — `getHash(text)`) so a previously-seen long text still hits cache in one shot, no chunking needed on cache hit.
2. On cache miss: `const chunks = this.splitIntoChunks(text);`
3. For each chunk (sequential `for...of`, not `Promise.all` — preserves order deterministically and avoids bursting Gemini rate limits): reuse the EXACT existing single-chunk translate path (cache-lookup-by-chunk-hash → Gemini call → cache-write-by-chunk-hash). This means each chunk is *also* cached individually by its own hash — a chunk that recurs across different long texts gets cache benefit too.
4. Concatenate translated chunks with `'\n\n'` if the original split was paragraph-based, or `' '` for sentence-based fallback — simplest correct approach: join with the SAME separator each chunk was split on, tracked alongside the chunk array (return `{text, separator}` tuples from `splitIntoChunks`, or simpler: always join with `'\n\n'` since `Array.join` after a paragraph-preserving split naturally restores most formatting; document this as a known simplification, not a silent bug).
5. Deduct `chunks.length` credits (not always 1) — extend `creditService.deductCredit(userId, chunks.length)`. Cache-hit-on-whole-text path still deducts exactly 1 (unchanged from today, since 1 cached lookup ≈ 1 unit of work).
6. Return value unchanged (`Promise<string>`) — the orchestration is invisible to the controller; only the controller's pre-check (item below) and the credit amount actually deducted change externally.

### Backend — controller length cap

In `translation.controller.ts::translate()`, after the existing `!text` check:
```ts
if (text.length > 20000) {
  throw new BadRequestException(
    `Text exceeds the maximum length of 20,000 characters (got ${text.length})`,
  );
}
```

### Frontend — dynamic cost display

`TextTranslationSection.tsx`:
- Add a char counter below the input textarea: `{inputText.length} / 20,000 ký tự`.
- Compute estimated chunk count client-side: `const estimatedChunks = Math.max(1, Math.ceil(inputText.length / 6000));` — mirrors backend `CHUNK_SIZE`, kept as a literal constant on both sides (no shared-constants file needed for one number; document the duplication inline with a comment pointing at `translation.service.ts`'s `CHUNK_SIZE`).
- Translate button label becomes dynamic: `` `Dịch thuật (${estimatedChunks} Credit${estimatedChunks > 1 ? "s" : ""})` `` replacing the hardcoded `"Dịch thuật (1 Credit)"`.
- If `inputText.length > 20000`, disable the Translate button and show an inline red warning instead of the count.

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| Paragraph-join with `'\n\n'` doesn't perfectly restore original spacing when sentence-fallback was used | 3 | 2 | 6 | Document as a known simplification (formatting fidelity, not correctness); acceptable for this feature's scope |
| Sequential per-chunk Gemini calls increase total latency for very long text (~4 chunks × ~2-3s each) | 3 | 2 | 6 | Acceptable trade-off vs. parallel calls risking rate-limit 429s; show "Đang dịch... (chunk X/N)" progress text if straightforward, else just the existing spinner |
| Client-side `estimatedChunks` drifts from backend's actual chunk count (since paragraph boundaries affect real chunking, not just raw length ÷ 6000) | 2 | 2 | 4 | Acceptable approximation for a pre-submit cost preview; actual credits deducted always come from the backend's real chunk count, never the client estimate |

## Timeline

| Step | Effort |
|------|--------|
| Backend: chunking algorithm + tests | M |
| Backend: orchestration rewrite in `translate()` | S |
| Backend: 20,000-char cap in controller | S |
| Frontend: char counter + dynamic cost label | S |
| **Total** | **M** |

## Verification

1. `cd backend && npm run test -- translation.service.spec` — chunking unit tests pass (paragraph split, sentence-fallback split, single-chunk no-op for short text).
2. Manual: paste a ~15,000-char multi-paragraph text → translate → output is complete (not truncated) and credits deducted = chunk count (verify via `GET /auth/me` credits delta).
3. Manual: paste 20,001 chars → `BadRequestException` shown as toast/error, no Gemini call made (check backend logs).
4. Regression: short text (<6000 chars) still does exactly 1 Gemini call, 1 credit deducted (unchanged from pre-Phase-2 behavior) — confirm via existing passing tests in `translation.service.spec.ts`.

## Rollback

Revert `translation.service.ts`, `translation.controller.ts`, `TextTranslationSection.tsx` to pre-phase state. No schema/migration involved — pure logic change.
