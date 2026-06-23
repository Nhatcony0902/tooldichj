# Phase 3: Auto-Detect Source Language

**Effort:** S
**Depends on:** Phase 2 (Long Text Chunking) — this phase's detect+translate prompt runs at the same call site Phase 2 restructured
**Blocks:** Phase 4 (Translation History) — history must store the *resolved* detected language code, never the literal string `"auto"`

## Goal

Add an "Auto-detect" option to the source-language dropdown. When selected, the backend detects the language AND translates in the flow already established by Phase 2, without a separate Gemini call (cost/latency reasons) — reusing the JSON-detect-prompt pattern already proven in `backend/src/translation/pipeline/stt.service.ts`.

## Files owned by this phase

- `backend/src/translation/translation.service.ts` — combined detect+translate prompt path when `sourceLang === 'auto'`
- `backend/src/translation/translation.controller.ts` — relax the `!sourceLang` required-check to allow `'auto'`
- `backend/src/translation/translation.service.spec.ts` — detect+translate tests
- `frontend/src/app/components/TextTranslationSection.tsx` — add "Auto-detect" `<option value="auto">` to the source `<select>`, display the resolved detected language in the result

## Implementation notes

### Backend — combined prompt (single Gemini call, not two)

In `translation.service.ts`, the per-chunk translate prompt (currently always `Translate the following text from "${sourceLang}" to "${targetLang}"`) branches when `sourceLang === 'auto'`:

```ts
const isAutoDetect = sourceLang.toLowerCase().trim() === 'auto';

const prompt = isAutoDetect
  ? `Detect the language of the following text (ISO 639-1 code, e.g. "en", "vi", "ja") and translate it to "${targetLang}".
Return ONLY a JSON object, no markdown fences, in this exact shape:
{"detectedLang":"<iso-code>","translatedText":"<the translated text>"}
Do not add any introductory phrases, explanations, notes, or extra markdown formatting in the translatedText value. Maintain the original format and line breaks within translatedText.

Text to translate:
${text}`
  : `Translate the following text from "${sourceLang}" to "${targetLang}".
Return ONLY the exact translated text. Do not add any introductory phrases, explanations, notes, or extra markdown formatting.
Maintain the original format and line breaks.

Text to translate:
${text}`;
```

Parsing: when `isAutoDetect`, `JSON.parse` the response (reuse the `stripMarkdownFence`-equivalent pattern already in `stt.service.ts` — extract to a small shared helper or duplicate the one-liner regex, given it's only used in two services) to get `{ detectedLang, translatedText }`. **Sanity-check** `detectedLang` against a small fixed ISO-639-1 allowlist matching the dropdown's existing options (`en`, `vi`, `zh`, `ja` — extend if the dropdown gains more); if the returned code isn't recognized, throw `Error('Could not reliably detect the source language; please select it manually')` so the controller returns a clear `success: false` instead of silently mistranslating (per the Risk Assessment in `plan.md`).

**Per-chunk detection consistency:** when text is split into multiple chunks (Phase 2) AND `sourceLang === 'auto'`, detect language ONLY on the FIRST chunk, then reuse that resolved `detectedLang` as the literal `sourceLang` for all subsequent chunks' prompts (still going through the normal non-auto prompt branch for chunks 2..N). This avoids each chunk independently "detecting" and potentially disagreeing, and avoids N redundant detect+translate combined calls when only 1 is needed.

`translate()`'s return type changes from `Promise<string>` to `Promise<{ translatedText: string; detectedLang: string | null }>` — `detectedLang` is `null` when `sourceLang !== 'auto'` (no detection happened, the manually-chosen language is already known). Update the controller and Phase 4's history-write call site accordingly (Phase 4 depends on this exact field).

### Backend — controller change

`translation.controller.ts::translate()`:
```ts
if (!sourceLang || !targetLang) {
  throw new BadRequestException('Source language and target language are required');
}
// 'auto' is now a valid sourceLang value — no extra check needed, translate() handles it.
```
Response shape gains `detectedLang`:
```ts
return { success: true, text, translatedText, sourceLang, targetLang, detectedLang };
```

### Frontend

`TextTranslationSection.tsx`:
- Source `<select>` gains `<option value="auto">🌐 Tự động nhận diện</option>` as the first option.
- After a successful translate where `sourceLang === 'auto'` and `data.detectedLang` is present, show a small inline hint above the output: `Đã nhận diện: {LANG_NAMES[data.detectedLang] || data.detectedLang}` (reuse a small local `LANG_NAMES` map: `{ en: "Tiếng Anh", vi: "Tiếng Việt", zh: "Tiếng Trung", ja: "Tiếng Nhật" }`).
- `handleSwapLanguages` (swap source/target) should refuse to set `targetLang` to `"auto"` — if `sourceLang === "auto"` when swap is clicked, swap is a no-op for the language fields (auto-detect has no symmetric "auto-detect target" concept) — show nothing, just skip the lang-swap part of that function while still swapping the text content.

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| Gemini misdetects language on short/ambiguous text (e.g. "OK", numbers-only) | 3 | 3 | 9 | ISO-639-1 allowlist sanity check rejects nonsense codes; user sees a clear "please select manually" error rather than a garbled silent mistranslation |
| Combined JSON-shaped prompt response fails to parse (Gemini adds markdown fences or extra text) | 2 | 3 | 6 | Reuse the exact `stripMarkdownFence` regex already proven reliable in `stt.service.ts`'s STT path |
| `handleSwapLanguages` edge case (swapping when source is "auto") confuses users | 2 | 1 | 2 | Documented behavior above (no-op on language fields, text still swaps) |

## Timeline

| Step | Effort |
|------|--------|
| Backend: combined prompt + JSON parsing + allowlist check | S |
| Backend: per-chunk detection-consistency logic | S |
| Backend: tests | S |
| Frontend: dropdown option + detected-lang hint + swap edge case | S |
| **Total** | **S** |

## Verification

1. `cd backend && npm run test -- translation.service.spec` — new auto-detect tests pass (valid detection, invalid/nonsense detection rejected, multi-chunk detection-once-reuse behavior).
2. Manual: select "Auto-detect", paste Vietnamese text, target=English → translates correctly, UI shows "Đã nhận diện: Tiếng Việt".
3. Manual: select "Auto-detect" with a >6000-char text spanning multiple chunks → confirm (via backend log line added at detection time) that the detect+translate combined call happens exactly once, not once per chunk.
4. Manual: click "Đổi chiều" (swap) while source="Auto-detect" → no crash, text content swaps, source dropdown does not flip to a nonsensical target-side "auto".

## Rollback

Revert `translation.service.ts`, `translation.controller.ts`, `TextTranslationSection.tsx` to pre-phase state (Phase 2's chunking logic remains intact — this phase only adds a branch, doesn't restructure Phase 2's orchestration).
