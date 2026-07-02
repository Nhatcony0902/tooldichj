# Phase 2 — Subtitle Style + Concise Translation

**Issue 2** (subtitle too large / fills frame) and **Issue 5** (translation not concise for subtitles). Grouped because both shape the on-screen subtitle text.

## Goal

- Render Netflix/YouTube-style subtitles: smaller font in an opaque box, bottom-center, max 2 lines.
- Make subtitle-context translations concise (≤10 words) without changing existing text-translation behavior.

## Files touched

| File | Change |
|------|--------|
| `backend/src/translation/pipeline/burn-in.service.ts` | rewrite `TIKTOK_SUBTITLE_STYLE`; add `PlayResY=288` |
| `backend/src/translation/pipeline/subtitle.service.ts` | add 2-line word-wrap in `buildSrt()` |
| `backend/src/translation/translation.service.ts` | add `mode: 'subtitle' \| 'text'` param to `translate()` + `translateChunk()`; conciseness prompt for subtitle mode |
| `backend/src/translation/pipeline/subtitle.service.ts` | `translateSegments()` passes `mode='subtitle'` |

Ownership: `burn-in.service.ts` also touched by Phase 3 (new `blurSubtitleArea`). **Phase 2 before Phase 3.** `subtitle.service.ts` touched by Phase 1 (`translateSegments`) — **Phase 1 before Phase 2.**

## Exact changes

### 1. `burn-in.service.ts` — new style (Issue 2)
```typescript
// Netflix/YouTube style: small font in an opaque box, bottom-center.
// PlayResY anchors FontSize units; 14/288 ≈ 4.9% of frame height.
const TIKTOK_SUBTITLE_STYLE = [
  'FontName=Arial',
  'FontSize=14',          // was 20
  'Bold=1',
  'PrimaryColour=&H00FFFFFF',
  'OutlineColour=&H00000000',
  'BorderStyle=3',        // NEW: opaque box (vs outline)
  'BackColour=&H66000000',// NEW: 60% opacity black box
  'Outline=0',            // was 3 (not needed with BorderStyle=3)
  'Shadow=0',             // was 1
  'MarginV=20',           // was 50
  'Alignment=2',
].join(',');
```
**CRITICAL — add `PlayResY`:** the current `force_style` does NOT set `PlayResY`, so `FontSize=14` is interpreted against libass's default (288). To make the font math deterministic regardless of source resolution, prepend `PlayResY=288` (and `PlayResX=512`, 16:9) to the style list. Without this the font size is not reliably "4.9% of frame". Update the doc comment block (lines 4-13) to match the new params.

### 2. `subtitle.service.ts` — 2-line wrap in `buildSrt()` (Issue 2, R5)
```typescript
const MAX_LINE_CHARS = 42;

function wrapToTwoLines(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text; // R5: don't touch short text
  const words = text.split(/\s+/);
  const lines: string[] = ['', ''];
  let li = 0;
  for (const w of words) {
    const candidate = lines[li] ? `${lines[li]} ${w}` : w;
    if (candidate.length > MAX_LINE_CHARS && li === 0) { li = 1; lines[1] = w; }
    else lines[li] = candidate; // never split mid-word
  }
  return lines.filter(Boolean).join('\n');
}
```
Apply in `buildSrt()`: `...\n${wrapToTwoLines(segment.translatedText)}\n`. (With concise ≤10-word translations from Issue 5, wrapping rarely triggers — defense in depth.)

### 3. `translation.service.ts` — concise prompt (Issue 5, R7)
Thread an optional `mode` param, default `'text'` (preserves existing behavior):
```typescript
async translate(
  userId: string, text: string, sourceLang: string, targetLang: string,
  chargeCredit = true,
  mode: 'subtitle' | 'text' = 'text',   // NEW, default preserves behavior
): Promise<{ translatedText: string; detectedLang: string | null }>

private async translateChunk(
  text: string, sourceLang: string, targetLang: string, sLang: string, tLang: string,
  mode: 'subtitle' | 'text' = 'text',   // NEW
): Promise<string>
```
In `translateChunk()`, append for subtitle mode only:
```typescript
const subtitleHint = mode === 'subtitle'
  ? '\nKeep the translation concise and natural for subtitles. Use at most 10 words. Preserve meaning over literal translation.'
  : '';
const prompt = `Translate the following text from "${sourceLang}" to "${targetLang}".
Return ONLY the exact translated text. Do not add any introductory phrases, explanations, notes, or extra markdown formatting.
Maintain the original format and line breaks.${subtitleHint}

Text to translate:
${text}`;
```
Thread `mode` from `translate()` → every `translateChunk()` call site.

### 4. `subtitle.service.ts` — `translateSegments()` passes subtitle mode
```typescript
await withRetry(() =>
  translationService.translate(userId, segment.text, sourceLang, targetLang, false, 'subtitle'),
);
```

## Risk assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Wrap breaks short segments (R5) | 2 | 2 | 4 | only wrap >42 chars; word-boundary only |
| `mode` thread changes text behavior (R7) | 2 | 4 | 8 | default `'text'`; unit-test both modes |
| FontSize math wrong without PlayResY | 3 | 3 | 9 | add `PlayResY=288` explicitly |

## Verify steps

1. `cd backend && npm run build` → 0.
2. Unit `buildSrt`/`wrapToTwoLines`: >42-char input → ≤2 lines, no mid-word break; ≤42-char input → unchanged.
3. Unit `translateChunk`: `mode='subtitle'` prompt contains the conciseness sentence; `mode='text'` does not.
4. `cd backend && npm test` → green.
5. Manual: burn a job → subtitles sit in a compact bottom box, ≤2 lines, do not fill the frame.
