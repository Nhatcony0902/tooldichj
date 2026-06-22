# Phase 3 — TTS Voice Feature (headline ask)

**Effort:** M | **Blocked by:** Phase 0 | **Blocks:** Phase 4 | **Parallel-safe with Phase 1/2**

## Goal

Add Gemini TTS so the user can **listen to a translation with a voice they pick**. This phase delivers the text-tab "listen" control + the shared voice infrastructure that Phase 4 (dubbing) also consumes. Voice selection is a first-class, user-facing option — NEVER a hardcoded default.

## SPIKE FIRST (mandatory, high-risk)

Before any UI: verify the Gemini TTS model id + request/response shape (`gemini-2.5-flash-preview-tts` style, ~30 prebuilt voices, PCM/wav audio out). Confirm: model name, how a voice is selected in the request, audio encoding returned, and rate/quota. Pin the working model id in a constant. This de-risks the highest-scoring risk in the plan.

## Decisions (defaults — flag to user)

- **Voice catalog = static config**, not a DB table. ~30 prebuilt Gemini voices rarely change; a `voices.config.ts` constant (id, displayName, gender, accent/locale, sampleKey) is SSOT. (A `Voice` Prisma table would be over-engineering for a fixed vendor list — YAGNI.)
- **User preference**: add `preferredVoiceId String?` to `User` (Prisma migration) so the picker remembers a default; per-request voice still overrides.

## Scope & file ownership

- `backend/src/tts/voices.config.ts` (NEW) — the voice catalog constant.
- `backend/src/tts/tts.service.ts` (NEW) — `synthesize(text, voiceId): audioBuffer`; **cache-by-hash** reusing the established pattern: SHA256(text + voiceId) → `TtsCache` row / stored audio key, so repeated text+voice never re-bills Gemini. Deduct credit on cache miss only.
- `backend/src/tts/tts.controller.ts` (NEW) —
  - `GET /tts/voices` → catalog (id/name/gender/accent/sampleUrl).
  - `POST /tts/speak` → `{ text, voiceId }` → returns/streams audio (or returns an output key Phase 1's stream endpoint serves).
  - `GET /tts/sample/:voiceId` → short prebuilt sample for the picker.
- `backend/src/tts/tts.module.ts` (NEW).
- `backend/prisma/schema.prisma` — add `TtsCache { id, textHash, voiceId, audioStorageKey, createdAt, @@unique([textHash, voiceId]) }` and `User.preferredVoiceId`. Migration.
- `frontend/src/app/page.tsx` — text-translation tab: a voice-picker `<select>` (populated from `GET /tts/voices`, with per-voice sample play) + a "Listen" / speaker button on the translated output that calls `POST /tts/speak` and plays via an `<audio>` element. Persist chosen voice to `preferredVoiceId`.

## Reuse

- Credit deduction → reuse `TranslationService.deductCredit` pattern (extract to a shared `CreditService` if duplicated — DRY).
- Cache-by-SHA256 → mirror `TranslationCache` exactly.

## Verification

- `GET /tts/voices` lists ≥1 voice with metadata; sample plays.
- `POST /tts/speak` with two different voiceIds for same text → two distinct audio outputs, each cached; a repeat call is a cache hit (no Gemini call, log confirms).
- Frontend: pick a voice, click Listen, audio plays. Voice choice persists across reload.

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Gemini TTS model/API shape differs from assumed | 4 | 4 | 16 | SPIKE FIRST (above) before UI; pin model id constant; isolate in tts.service |
| TTS audio format not browser-playable (raw PCM) | 3 | 3 | 9 | transcode to mp3/wav via ffmpeg (already available) before serving |
| Re-billing on repeat text+voice | 2 | 3 | 6 | TtsCache @@unique([textHash,voiceId]); deduct on miss only |

## Rollback

Entirely additive (new module + 2 migrations + frontend additions). Revert phase commit; down-migration drops TtsCache + preferredVoiceId.
