# Plan: Remove Video Dubbing Feature + Auto-Detect Subtitle Region for Blur

Created: 2026-07-01 (260701-0940)
Branch: `feature-ux-completeness` (current)

User feedback (verbatim intent): "Không dùng lồng tiếng nữa, sẽ dùng tiếng gốc của video, không giảm âm lượng nữa. Và phần làm mờ chữ vẫn chưa đúng — đang bắt chữ mặc định ở phần dưới video nên chữ gốc chưa được che."

Two independent issues, fixed in two phases:

1. **Dubbing removal** — the frontend `<select>` already dropped the `dub` / `burn+dub` `<option>`s (commit `dd7f473`), but the backend TTS-dub pipeline, the 50%-volume-ducking mux, `dubVoiceId` DTO/DB field, and matching frontend dead code are all still present and reachable. Confirmed decision: **delete the video-dub feature completely** (backend pipeline + DB column + dead frontend code). Standalone text-to-speech (`VoiceSelector.tsx`, `tts.service.ts`) is unrelated and stays.
2. **Subtitle-region blur** — `blurSubtitleArea()` hardcodes "bottom 20% of every frame," which doesn't match the actual position of the hardcoded subtitles in the user's videos. Confirmed decision: **auto-detect the burned-in subtitle region per video using Gemini vision** (the project's existing AI provider) instead of asking the user to manually configure a crop region.

---

## Confirmed Decisions (do not re-ask)

1. Delete the entire video-dub feature: output modes `dub`/`burn+dub`, `dubbing.service.ts`, `mux.service.ts` (both mux functions were dub-only), `dubVoiceId` field (DTO + Prisma column via migration), and all dead frontend state/JSX referencing it. `VoiceSelector.tsx` + `tts.service.ts` are kept — they back the separate standalone text-to-speech feature (`TextTranslationSection.tsx`).
2. Subtitle-region detection is fully automatic (Gemini vision on sampled frames) — no new user-facing UI control for position/height. The existing "Làm mờ phụ đề cứng có sẵn trong video" checkbox is the only trigger, unchanged.
3. If detection finds no burned-in subtitle in any sampled frame (or `GEMINI_API_KEY` is not configured), **skip the blur step** rather than guessing a region — blurring a region that doesn't contain subtitles would damage real video content for no benefit.
4. No pricing change — video jobs stay a flat 10 credits regardless of the extra Gemini calls used for region detection (matches existing flat-cost precedent in `translation.service.ts:433-436`).

---

## Verified Codebase Facts (ground truth as of 2026-07-01)

| Fact | Location | Note |
|------|----------|------|
| Frontend `<select>` already has only `burn`/`srt` options | `VideoTranslationSection.tsx:296-297` | dub UI already removed in `dd7f473` |
| Dead code still references `dub`/`burn+dub` | `VideoTranslationSection.tsx:41-43,119-122,302-313` | `dubVoiceIdVideo` state, `VoiceSelector` import/JSX block, formData append — all unreachable |
| `OUTPUT_MODES` still includes `'dub'`, `'burn+dub'` | `output-mode.ts:4` | backend still accepts them via direct API call |
| Mixed-audio dub mux (50% orig + 100% dub) | `mux.service.ts:37-64` | only consumer is the dub path in the worker |
| Dub pipeline call site | `video-pipeline.worker.ts:171-217` | full `if (outputModeIncludesDub(...))` block |
| `ttsService` used ONLY by the dub block | `video-pipeline.worker.ts:15,42,180` | becomes dead constructor param after removal |
| `DEFAULT_VOICE_ID` used ONLY by the dub block | `voices.config.ts:19`, `video-pipeline.worker.ts:16,177` | becomes dead export after removal |
| `isValidVoiceId` also used by standalone TTS | `tts.controller.ts:60,85,104`, `tts.service.ts:44,69` | keep the function; only remove the now-unused import in `translation.controller.ts:37` |
| `dubVoiceId` column, nullable | `schema.prisma:78` | additive-nullable when added; safe to drop via migration (feature never shipped to real users — UI never exposed it in production) |
| `blurSubtitleArea` hardcodes `ih*0.2` crop, bottom-anchored | `burn-in.service.ts:49-68` | root cause of Issue 2 |
| `getAudioDuration(path)` uses generic `ffmpeg.ffprobe` | `audio-extractor.ts:20-28` | works for any media file, not audio-specific — reuse for video duration instead of adding a new ffprobe call |
| Gemini client accessed via `translationService.getAi()` | `translation.service.ts:49`, used at `:256,306` | worker already holds `this.translationService`; no new DI needed for vision calls |
| Gemini calls use `ai.models.generateContent({ model: 'gemini-2.0-flash', contents })` | `translation.service.ts:266-269,327-330` | established pattern to mirror for the vision call (multimodal `contents` array instead of a bare string) |
| `stripMarkdownFence()` is a private, unexported helper | `translation.service.ts:25` | duplicated logic risk — extract to a shared util so the new vision-JSON parser doesn't reimplement it |
| No dedicated spec exists for `burn-in.service.ts` or `mux.service.ts` | (grep negative) | only `video-pipeline.worker.spec.ts` exists, covers `onFailed` only |
| `video-pipeline.worker.spec.ts` constructs worker with `({} as any)` for `ttsService` | `video-pipeline.worker.spec.ts:12-17` | must update after ctor signature changes |

---

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Remove video-dub feature (backend + DB + frontend dead code) | `output-mode.ts`, `translation.controller.ts`, `translation.service.ts`, `video-pipeline.worker.ts`, `video-pipeline.worker.spec.ts`, `dubbing.service.ts` (delete), `mux.service.ts` (delete), `dto/create-video-job.dto.ts`, `tts/voices.config.ts`, `schema.prisma` + new migration, `VideoTranslationSection.tsx` | M |
| 2 | Auto-detect subtitle region (Gemini vision) + dynamic blur | NEW `subtitle-region.service.ts`, NEW `json-parse.util.ts`, `burn-in.service.ts`, `translation.service.ts` (import shared util), `video-pipeline.worker.ts` | L |

Detail cards: `phase-1.md`, `phase-2.md`.

---

## File Ownership Map

| File | Phase(s) | Conflict handling |
|------|----------|-------------------|
| `video-pipeline.worker.ts` | 1 (remove dub block), 2 (add region-detect + blur wiring) | **SEQUENCE: Phase 1 before Phase 2** — same file, disjoint but adjacent regions |
| `burn-in.service.ts` | 2 only | no conflict |
| `translation.service.ts` | 1 (remove `dubVoiceId` field), 2 (export shared `stripMarkdownFence` via new util, update import) | **SEQUENCE: Phase 1 before Phase 2** — same file |
| all dub-only files | 1 only | deleted, no Phase 2 touch |
| NEW files | 2 only | no conflict |

## Dependency Graph

```
Phase 1 (delete dub feature: backend + DB + frontend dead code)
   └──> Phase 2 (subtitle-region detection + dynamic blur — touches the
                  worker/translation.service regions Phase 1 already cleaned up)
```

Strictly sequential — Phase 2's edits to `video-pipeline.worker.ts` land in the space Phase 1's removal opens up (the dub block sat directly above the burn/blur block).

---

## Risk Assessment (L×I, ≥15 = HIGH, mitigate before phase starts)

| # | Risk | L | I | Score | Mitigation | Phase |
|---|------|---|---|-------|------------|-------|
| R1 | Dropping the `dubVoiceId` Prisma column loses historical data for any past dub jobs | 2 | 2 | 4 | Feature was never in the production dropdown (only reachable via direct API call before this fix); acceptable, additive-only in reverse — document in rollback | 1 |
| R2 | Removing `ttsService` from worker ctor breaks DI wiring elsewhere | 1 | 3 | 3 | Grepped: only consumer is `video-pipeline.worker.ts`; NestJS DI needs no module change, only ctor signature + spec update | 1 |
| R3 | `gemini-2.0-flash` may not reliably return image-grounded bounding boxes (LLM vision bbox estimates are approximate, not pixel-precise OCR) | 3 | 3 | 9 | Ask for a generous region (small padding added in union step); explicitly instruct the model to err toward a slightly larger box; treat this as best-effort, not surgical precision | 2 |
| R4 | Extra Gemini calls (2-3 frames per video) add latency + API cost without a pricing change | 3 | 2 | 6 | Downscale extracted frames (640px wide) to cut tokens/latency; flat pricing already accepted as a product decision (Confirmed Decision #4) | 2 |
| R5 | Video has no Gemini key configured (`GEMINI_API_KEY` unset) → detection silently unavailable | 2 | 2 | 4 | Explicit `if (!ai) return null` → worker skips blur with a clear step message, same graceful-degradation pattern already used for dub failures | 2 |
| R6 | `gemini-2.0-flash` might reject/mishandle `inlineData` image parts (unverified assumption before coding) | 2 | 4 | 8 | **Mitigate FIRST in Phase 2:** verify multimodal image input against this exact model with a quick manual smoke call before wiring the full pipeline (mirrors the "verify model via docs before coding" precedent from the 260628 plan's R2) | 2 |
| R7 | Same-file edits (`video-pipeline.worker.ts`, `translation.service.ts` in both phases) collide if run out of order | 2 | 3 | 6 | Enforced sequencing in dependency graph; Phase 2 only starts after Phase 1 lands | all |

No risk ≥ 15; R3/R6 are the ones to watch during Phase 2 execution.

---

## Backwards Compatibility

- **Phase 1 is destructive to the dub feature by design** (user-confirmed) — not additive. `outputMode` values `dub`/`burn+dub` become invalid; any external caller still sending them gets a 400 from `isValidOutputMode`, same as any other invalid string today.
- **Phase 2 is additive/behavioral-only** — no schema change. `removeSourceSubs` boolean already exists; its effect just becomes smarter (real region vs. fixed guess).
- **Migration path:** one migration dropping `dubVoiceId` (Phase 1). No destructive migration in Phase 2.

---

## Rollback Plan (per phase)

| Phase | Rollback |
|-------|----------|
| 1 | Revert all listed files + `prisma migrate resolve --rolled-back` (re-add `dubVoiceId` column) — restores prior dub pipeline exactly as it was |
| 2 | Revert `burn-in.service.ts`, `video-pipeline.worker.ts`, delete the 2 new files, revert `translation.service.ts` import — restores the fixed bottom-20% blur |

Each phase reverts independently; Phase 2's revert never re-introduces the dub feature Phase 1 removed.

---

## Test Matrix

| Phase | Verify command | Pass criterion |
|-------|----------------|-----------------|
| all | `cd backend && npx tsc --noEmit` | 0 errors |
| all | `cd backend && npm test` | existing suite green, no regressions |
| all | `cd frontend && npm run lint` | 0 errors (dead-code removal must not leave unused imports) |
| 1 | `cd backend && npx prisma migrate dev --name drop_dub_voice_id` | migration applies clean |
| 1 | unit test: `isValidOutputMode('dub')` / `('burn+dub')` | both now return `false` |
| 1 | manual: submit a video job via the UI | only `burn`/`srt` selectable; output audio is the untouched original track (verify via `ffprobe` — same channel/duration as source, no `volume`/`amix` filter applied) |
| 2 | manual smoke (R6 mitigation): 1 raw `generateContent` call with an inline JPEG against `gemini-2.0-flash` | returns a text response referencing image content (proves multimodal input works before building the rest) |
| 2 | manual: video WITH visible burned-in subtitles, "Làm mờ phụ đề cứng" checked | output blurs the actual subtitle band, not a fixed bottom-20% guess |
| 2 | manual: video WITHOUT any burned-in subtitles, checkbox checked | job completes with blur step skipped (step message says so), original frames untouched |

---

## Docs Sync

No `docs/video-pipeline.md` exists yet (flagged, not mandated, by the prior 260628 plan). Still out of scope unless requested.

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 | M | Independent cleanup; unblocks Phase 2 |
| Phase 2 | L | New AI-vision feature; R6 smoke test gates the rest of the work |
| **Total** | **~L** | Critical path: Phase 1 → Phase 2 |

---

## Cook Handoff

`/t1k:cook plans/260701-0940-dub-removal-subtitle-region-detect/plan.md`
