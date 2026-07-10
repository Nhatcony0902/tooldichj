# Phase 3 — (Optional) LLM-driven prosody derivation via Gemini

**Effort:** M · **Status:** OPTIONAL, demand-gated. Start only if the Phase-1 punctuation/keyword heuristic proves too coarse (e.g. misreads sarcasm, context-dependent urgency, or emotion that isn't signaled by punctuation).

## Why this might be needed

Phase 1 reads only surface signals (`!`, imperative words, caps, length). It cannot tell that "Chúng ta sắp hết thời gian rồi." is urgent despite ending in a period. An LLM can infer emotion/urgency from meaning. This phase replaces the Phase-1 heuristic's *decision* while reusing all of Phase 1's *plumbing* (the `ProsodyOptions` param + prosody-aware cache key).

## Reuse — the Gemini client already exists

`src/gemini/gemini-client.service.ts` (`GeminiClientService`) is already injected into `translation.service.ts`. Phase 3 adds ONE batched annotation call, ideally piggybacked on the existing translate batch so it adds no extra pipeline round-trip per segment.

## Where it slots in

`subtitle.service.ts` `translateSegments()` already does one batch LLM translate for all segments. Extend it (or add a sibling `annotateProsody`) so each returned segment carries a coarse emotion label:

```
TranslatedSegment  ->  { ...seg, translatedText, emotion?: 'urgent'|'calm'|'neutral'|'question'|'excited' }
```

Then a pure mapper `emotionToProsody(label): ProsodyOptions` (living next to Phase-1's `prosody.util.ts`, sharing the SAME clamps — including **rate never negative**, per the soft-sync timing rule) converts the label to `{rate,pitch,volume}`. `dubbing.service.ts` prefers `segment.emotion` when present, else falls back to the Phase-1 text heuristic.

## Design constraints

- **Deterministic-enough for caching:** the emotion label becomes part of the prosody signature already folded into the cache key (Phase 1), so an LLM-labeled segment caches correctly. If the LLM is re-run and returns a different label, it's a natural cache-miss + re-synth (acceptable, rare).
- **Errors over silent fallbacks** (`development-principles.md`): a failed/malformed Gemini annotation MUST fall back to the Phase-1 heuristic with a logged warning — never crash the dub, never silently drop emotion.
- **Cost/latency:** batch ALL segments in one call (mirror the existing translate batch), not per-segment. Measure the added latency against the translate call it rides alongside; if it doubles job time, keep it opt-in via env flag.
- **Cheaper alternative to weigh at phase start:** ask the translate prompt to *also* emit an emotion tag per line in the same JSON response (one call, near-zero extra cost) instead of a second Gemini call. Prefer this if the translate prompt can carry it cleanly.

## Files owned

| File | Change |
|------|--------|
| `backend/src/tts/prosody.util.ts` | Add `emotionToProsody(label)` (shares Phase-1 clamps). |
| `backend/src/translation/pipeline/subtitle.service.ts` | Emit per-segment `emotion` (extend translate batch or add annotate step). |
| `backend/src/translation/pipeline/dubbing.service.ts` | Prefer `segment.emotion` → `emotionToProsody`; else Phase-1 text heuristic. |
| `backend/src/translation/translation.service.ts` (only if a dedicated Gemini annotate method is added) | New batched `annotateEmotions` method. |
| Relevant `*.spec.ts` | Mapper + fallback-on-bad-LLM-output tests. |

## Verification

```bash
cd backend
npm run build
npm test -- prosody.util.spec.ts        # emotionToProsody mapping + shared clamps
npm test -- subtitle.service.spec.ts    # emotion emitted; malformed LLM output falls back, no throw
```

Manual: run a job with a context-dependent urgent line (no `!`), confirm it now gets urgent prosody where Phase 1 would have read it neutral; confirm job latency delta is acceptable.

## Rollback

Env flag `DUB_PROSODY_LLM_ENABLED=false` → `dubbing.service.ts` ignores `segment.emotion` and uses only the Phase-1 heuristic. Removing the annotate step leaves Phase 1 fully functional.

## Success criteria

1. Context-dependent urgent line (no punctuation cue) gets urgent prosody.
2. Malformed/absent LLM annotation degrades to Phase-1 heuristic with a logged warning (no crash, no silent drop).
3. Job-time delta measured and acceptable (or the feature is flagged opt-in).
