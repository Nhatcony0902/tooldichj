# Plan: Video Translation Improvements

Created: 2026-06-28 (260628-0030)
Branch: `feature-ux-completeness` (current) — recommend a dedicated `feature-video-translation-improvements` branch off `main`.

Fixes 5 issues in the `tooldichj` video-translation pipeline (NestJS backend + Next.js frontend). All design decisions are confirmed (see "Confirmed Decisions" below) — no open questions remain in this plan.

---

## Confirmed Decisions (do not re-ask)

1. **Rate limit** — sequential + 4.2s delay between segments + exponential backoff (4s → 8s → 16s) on HTTP 429; mock only as last resort after retries exhausted.
2. **Subtitle style** — Netflix/YouTube style: `FontSize=14` (ASS units at `PlayResY=288`), `BorderStyle=3` (opaque box), `BackColour=&H66000000` (60% black), `MarginV=20`, max 2 lines, bottom-center.
3. **Source-subtitle removal** — optional FFmpeg blur of bottom 20% of each frame, user-toggled via a new "Xóa phụ đề gốc (nếu có)" checkbox.
4. **TTS** — fix dub mode, then root-cause. (Verified: errors are currently SWALLOWED into mock audio — see Phase 4.)
5. **Concise translation** — subtitle-mode prompt instructs "concise, ≤10 words, meaning over literal".

---

## Verified Codebase Facts (ground truth as of 2026-06-28)

| Fact | Location | Note |
|------|----------|------|
| Segment loop has NO delay | `subtitle.service.ts:16-35` | confirmed root cause of Issue 1 |
| `translate()` is public, returns `{translatedText, detectedLang}` | `translation.service.ts:51-57` | `translateSegments` calls this |
| Prompt built in PRIVATE `translateChunk()` | `translation.service.ts:224-262` | model `gemini-2.5-flash` (line 264) |
| Prompt has no conciseness instruction | `translation.service.ts:257-262` | confirmed root cause of Issue 5 |
| `TIKTOK_SUBTITLE_STYLE` FontSize=20, no box, MarginV=50 | `burn-in.service.ts:14-24` | confirmed root cause of Issue 2 |
| `force_style` does NOT set `PlayResY` | `burn-in.service.ts:14-24` | **must add `PlayResY=288`** for FontSize math to hold |
| `buildSrt()` does no line-wrapping | `subtitle.service.ts:39-46` | Issue 2 wrap target |
| TTS errors SWALLOWED → mock audio | `tts.service.ts:209-215` | **refines Issue 4 root cause** |
| Translation errors also fall back to mock silently | `translation.service.ts` (mock fallback) | same swallow pattern |
| `TTS_MODEL = 'gemini-2.5-flash-preview-tts'` | `voices.config.ts:5` | verify still valid in Phase 4 |
| `buildDubbingTrack` loops TTS with NO delay | `dubbing.service.ts:47-103` | TTS hits same 15 RPM wall as Issue 1 |
| `CreateVideoJobDto` = {targetLang, outputMode?, dubVoiceId?} | `dto/create-video-job.dto.ts:1-5` | add `removeSourceSubs?` |
| `VideoJob` model, add field after `dubVoiceId` (line 78) | `prisma/schema.prisma:69-88` | add `removeSourceSubs Boolean @default(false)` |
| Frontend state + FormData payload | `VideoTranslationSection.tsx:37-43, 114-120` | add checkbox + state + append |
| Worker burns at line 142-152, dubs at 154-180 | `video-pipeline.worker.ts` | blur insertion point: before line 150 `burnInSubtitles` |
| NO shared delay/rate-limit constant exists | (grep negative) | **create one shared helper** (DRY) — used by Phase 1 + Phase 4 |

---

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Rate-limit fix (translation) | `subtitle.service.ts`, NEW `rate-limit.util.ts` | M |
| 2 | Subtitle style + concise translation | `burn-in.service.ts`, `subtitle.service.ts`, `translation.service.ts` | M |
| 3 | Source-subtitle removal (blur + schema + frontend) | `burn-in.service.ts`, `dto`, `translation.controller.ts`, `video-pipeline.worker.ts`, `schema.prisma`, `VideoTranslationSection.tsx` | L |
| 4 | TTS / dub fix | `dubbing.service.ts`, `tts.service.ts`, `voices.config.ts` (verify) | M |

Detail cards: `phase-1.md` … `phase-4.md`.

---

## File Ownership Map (no two parallel phases write the same file without sequencing)

| File | Phase(s) | Conflict handling |
|------|----------|-------------------|
| `subtitle.service.ts` | 1 (`translateSegments`), 2 (`buildSrt`) | **SEQUENCE: Phase 1 before Phase 2** (different functions, same file) |
| `burn-in.service.ts` | 2 (style const), 3 (new `blurSubtitleArea`) | **SEQUENCE: Phase 2 before Phase 3** (different regions, same file) |
| `translation.service.ts` | 2 (prompt + mode param) | Phase 2 only |
| NEW `rate-limit.util.ts` | 1 (create), 4 (reuse) | Phase 1 creates; Phase 4 imports |
| `dubbing.service.ts` | 4 | Phase 4 only |
| `tts.service.ts` | 4 | Phase 4 only |
| `schema.prisma`, `dto`, `controller`, `worker`, frontend | 3 | Phase 3 only |

---

## Dependency Graph

```
Phase 1 (rate-limit util + translateSegments delay)
   │  creates rate-limit.util.ts
   ├──> Phase 2 (buildSrt wrap — same file as P1, sequence after)
   └──> Phase 4 (imports rate-limit.util.ts for TTS delay)

Phase 2 (subtitle style + concise prompt)
   └──> Phase 3 (blurSubtitleArea — same file burn-in.service.ts, sequence after)

Phase 3 (independent otherwise: schema/dto/controller/worker/frontend)
Phase 4 (independent otherwise; only shares rate-limit.util.ts from P1)
```

- **Critical path:** Phase 1 → Phase 2 → Phase 3 (burn-in.service.ts chain).
- **Parallel-safe after Phase 1 lands:** Phase 4 can run in parallel with Phase 2/3 (only consumes `rate-limit.util.ts`, owns disjoint files).
- **Blocked by:** Phase 1 blocks Phase 2 (file) and Phase 4 (util). Phase 2 blocks Phase 3 (file).

---

## Cross-Cutting: Shared Rate-Limit Utility (DRY)

Both Issue 1 (translation) and Issue 4 (TTS) need the SAME "delay + 429-aware exponential backoff" logic. Per `development-principles.md` (SSOT) and `code-conventions.md` (No Duplicated Logic), Phase 1 creates ONE helper and Phase 4 imports it — do NOT copy-paste the loop.

`backend/src/translation/pipeline/rate-limit.util.ts`:
```typescript
export const GEMINI_FREE_RPM_DELAY_MS = 4200; // 60s / 15 RPM + margin
export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
export function isRateLimitError(err: unknown): boolean; // detect HTTP 429 / RESOURCE_EXHAUSTED
export async function withRetry<T>(fn: () => Promise<T>, opts?: {...}): Promise<T>; // 3 attempts, 4s→8s→16s on 429
```
All magic numbers live as named constants here (no hardcoded literals scattered across services).

---

## Risk Assessment (likelihood × impact, score = L × I; ≥15 = HIGH, mitigate before phase starts)

| # | Risk | L (1-5) | I (1-5) | Score | Mitigation | Phase |
|---|------|---------|---------|-------|------------|-------|
| R1 | 4.2s delay makes translation slow (20 segs ≈ 84s + retries) | 5 | 2 | 10 | Per-segment progress "Đang dịch... (X/Y)"; document expected time in completion UX | 1 |
| R2 | TTS model `gemini-2.5-flash-preview-tts` deprecated/renamed → cannot auto-fix | 3 | 5 | **15 HIGH** | **Mitigate FIRST in Phase 4:** verify model via Context7 / Gemini docs before coding; surface real error (de-swallow) so it's visible | 4 |
| R3 | Swallowed errors hide the TRUE dub failure → fix the wrong thing | 4 | 4 | **16 HIGH** | **De-swallow FIRST:** Phase 4 step 1 = stop masking errors into mock; log + propagate real error to job `errorMessage` BEFORE applying delay/model fixes | 4 |
| R4 | Blur bottom 20% clips important video content | 2 | 2 | 4 | Opt-in checkbox (default off); document in UI label | 3 |
| R5 | 2-line wrap breaks short segments / mid-word | 2 | 2 | 4 | Wrap only when text > 42 chars; break on word boundary, never mid-word | 2 |
| R6 | Prisma migration fails / drifts in shared DB | 2 | 4 | 8 | Run `migrate dev` on a dev DB; commit migration file; additive nullable-with-default = backwards compatible | 3 |
| R7 | `mode` param threaded wrong → text translation behavior changes | 2 | 4 | 8 | Default `mode='text'` preserves existing behavior; only video pipeline passes `'subtitle'`; add a unit test for both | 2 |
| R8 | Same-file edits (P1/P2 on subtitle.service.ts; P2/P3 on burn-in.service.ts) collide | 3 | 3 | 9 | Enforce sequencing in dependency graph; never run colliding phases in parallel | all |
| R9 | FFmpeg blur + burn run as two passes → quality loss / slow re-encode | 2 | 3 | 6 | Acceptable for opt-in feature; document; consider single filtergraph as future optimization (YAGNI now) | 3 |

**HIGH-risk gate:** R2 and R3 (both Phase 4) MUST be addressed at the START of Phase 4 — de-swallow the error and verify the model name before any other dub change. See `phase-4.md` step ordering.

---

## Backwards Compatibility

- **Additive only.** `removeSourceSubs` is nullable-with-default (`@default(false)`) — existing rows and existing API callers (no field) keep working.
- `mode` param defaults to `'text'` — existing text-translation callers unchanged.
- New `rate-limit.util.ts` is new code; no existing import touched except the two consumers.
- Subtitle style change is cosmetic (output rendering only); no data/schema impact.
- **Migration path:** one additive Prisma migration (`add_remove_source_subs`); no destructive change, no data backfill needed.

---

## Rollback Plan (per phase)

| Phase | Rollback |
|-------|----------|
| 1 | Revert `subtitle.service.ts` + delete `rate-limit.util.ts` — restores no-delay loop (Phase 4 must also revert its import) |
| 2 | Revert the 3 files — restores FontSize=20 + non-wrapped SRT + original prompt |
| 3 | Revert 6 files + `prisma migrate resolve --rolled-back` / drop column — feature was opt-in so no user data depends on it |
| 4 | Revert `dubbing.service.ts` + `tts.service.ts` — restores prior (swallowed-error) behavior |

Each phase is an independent revert; reverting a later phase never breaks an earlier one EXCEPT Phase 1↔4 share the util (revert P4 import first, then P1 file).

---

## Test Matrix (every phase has at least one measurable pass/fail command)

| Phase | Verify command | Pass criterion |
|-------|----------------|----------------|
| all | `cd backend && npm run build` | exits 0 (TS strict, no `any`) |
| all | `cd backend && npm test` | existing suite green (no regressions) |
| 1 | unit test on `withRetry` (mock 429 then success) | retries then resolves; mock only after 3 fails |
| 2 | unit test `buildSrt` with >42-char text | output has ≤2 lines, break on word boundary |
| 2 | unit test `translateChunk` mode='subtitle' | prompt contains the conciseness instruction; mode='text' does not |
| 3 | `cd backend && npx prisma migrate dev --name add_remove_source_subs` | migration applies clean |
| 3 | `cd frontend && npm run build && npm run lint` | exits 0 |
| 3 | manual: upload with checkbox on | bottom 20% blurred in output, subtitles still legible |
| 4 | manual: run a dub job end-to-end | produces REAL spoken audio (not silent mock); on failure, job `errorMessage` shows the actual cause |

---

## Docs Sync

No `docs/` architecture file currently describes the video pipeline. After implementation, recommend adding a short `docs/video-pipeline.md` (out of scope for this plan unless requested) covering the segment-delay rate-limit strategy and the opt-in blur feature. Flagged, not mandated.

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 | M | Blocks P2 (file) + P4 (util); start here |
| Phase 2 | M | After P1; blocks P3 (file) |
| Phase 3 | L | After P2; largest (6 files + migration + frontend) |
| Phase 4 | M | After P1 util; can parallel with P2/P3; HIGH-risk items first |
| **Total** | **~L** | Critical path: P1 → P2 → P3. P4 parallel after P1. |
