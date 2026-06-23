# Plan: tooldichj — UX Feature Completeness (Profile, Chunking, History, Notifications)

**Status:** READY (all decisions confirmed by user — see Decisions table)
**Created:** 2026-06-23 14:50
**Branch base:** feature-tts-video-billing (current) → recommend new branch `feature-ux-completeness`
**Scope:** Close the remaining gaps in the user-facing product surface after the TTS/video/billing pipeline (prior plan: `plans/260622-1035-tts-video-pipeline-billing/`) — profile self-service, long-text translation, translation history, credit UX, and upload validation.

## Scope correction (verified against code, not the original backlog doc)

The user's input list had 7 items. Item #1 ("Quên mật khẩu / Reset password — Backend đã có API nhưng Frontend chưa có giao diện") is **already fully implemented** end-to-end:
- Backend: `backend/src/auth/auth.controller.ts` (`POST /auth/forgot-password`, `POST /auth/reset-password`) + `auth.service.ts` (`requestPasswordReset`, `resetPassword` — 6-digit OTP, 10-min TTL, 5 max attempts, 60s resend cooldown) + `mail.service.ts` (`sendPasswordResetEmail`).
- Frontend: `frontend/src/app/components/AuthCard.tsx` (lines 94-216 — 2-step UI: request OTP → enter OTP + new password) wired via `frontend/src/app/hooks/useAuth.ts` (`handleForgotPasswordRequest`, `handleResetPasswordSubmit`).

User confirmed (AskUserQuestion): **excluded from this plan.** This plan covers the remaining 6 items only.

## Overview

The project today (post `260622-1035-tts-video-pipeline-billing`) has working auth, real video pipeline with TTS dubbing, and manual-confirm billing. Six gaps remain in the day-to-day product experience:

1. No dedicated Profile/Settings page (name/phone/avatar edit, in-session password change) despite the DB already having every field.
2. Long text translations (no chunking) risk poor quality / failure past ~6-8K chars in a single Gemini call.
3. No "Auto-detect" source language option — user must always pick manually, even though the STT pipeline already proves Gemini can detect language reliably.
4. No per-user backend translation history — today it's `localStorage`-only (lost on browser switch/clear), and the DB-side `TranslationCache` is a global dedup cache, not a user history.
5. Credit-exhausted errors are generic text/toasts with no path to the Billing section.
6. Video upload size validation is FE/BE-inconsistent (FE says "Tối đa 50MB", BE enforces 100MB via `MAX_UPLOAD_MB`) and has zero client-side pre-check.

## Phases

- **Phase 1: Profile Page** — `PATCH /auth/profile` (name/phone/avatarUrl), `PATCH /auth/change-password` (old+new, bcrypt-verified), new `ProfileSection.tsx` + Profile tab in `page.tsx` | Effort: M
- **Phase 2: Long Text Chunking** — paragraph/sentence-aware chunker in `translation.service.ts`, 20,000-char hard cap, N-credit pricing (1 credit/chunk), dynamic button cost in `TextTranslationSection.tsx` | Effort: M
- **Phase 3: Auto-Detect Source Language** — `sourceLang = "auto"` combined detect+translate Gemini prompt (reuses `stt.service.ts` JSON-detect pattern), "Auto-detect" dropdown option | Effort: S
- **Phase 4: Per-User Translation History** — new `TranslationHistory` Prisma model (capped 50/user, auto-pruned), `GET /translation/history` + `DELETE /translation/history`, FE switches from `localStorage` to backend-backed history | Effort: M
- **Phase 5: Credit-Exhausted Notification + Billing Link** — `InsufficientCreditsError` class + `code: 'INSUFFICIENT_CREDITS'` on translate/TTS/video-job responses, `Toast` gets an optional action button, anchor + smooth-scroll to `BillingSection` | Effort: S
- **Phase 6: Video File Size Validation Sync** — `NEXT_PUBLIC_MAX_UPLOAD_MB` env synced with backend `MAX_UPLOAD_MB`, client-side pre-check before upload, dynamic "Tối đa NMB" label | Effort: S

## Feasibility

- **Reuse check:** bcrypt + `auth.service.ts` password-hash pattern reused for change-password (Phase 1). `stt.service.ts`'s JSON-shaped Gemini detect-prompt pattern reused for text-language auto-detect (Phase 3). `TranslationCache`'s hash-by-SHA256 pattern stays untouched — `TranslationHistory` is a new, separate, per-user model (no schema collision). `Toast`/`showToast` extended, not replaced (Phase 5). `MAX_UPLOAD_MB` env var already exists server-side — Phase 6 only adds the mirrored `NEXT_PUBLIC_` var.
- **NEW:** `TranslationHistory` Prisma model + migration; `InsufficientCreditsError` class in `credit/`; chunking algorithm (no new dependency — pure string splitting); dynamic credit-cost UI state.
- **Complexity:** moderate. No new infra (no new queue, no new third-party service). The riskiest item is the chunking quality (does Gemini-translated chunk boundary preserve meaning/formatting) — mitigated by paragraph-first splitting.

## Dependencies (critical path)

```
Phase 1 (Profile)             — fully independent
Phase 2 (Chunking) ──> Phase 3 (Auto-detect) ──> Phase 4 (History)
Phase 5 (Credit notif)         — independent, but sequenced after 2-4 to avoid
                                  re-touching TextTranslationSection.tsx mid-stream
Phase 6 (Video size sync)      — fully independent
```

- **Blocks:** Phase 2 blocks Phase 3 (auto-detect's combined detect+translate prompt is built on the chunking call site). Phase 3 blocks Phase 4 (history must store the *resolved* detected language, never the literal string `"auto"`).
- **Parallel-safe:** Phase 1 and Phase 6 have zero file overlap with anything else and can run in any order relative to the rest.
- **Critical path:** 2 → 3 → 4 (the only true chain). 1, 5, 6 are off-path.

## Decisions resolved by user (do not re-ask)

| ID | Decision | Confirmed approach | Rationale |
|----|----------|---------------------|-----------|
| DEC-1 | Forgot/reset password (original item #1) | **Excluded from plan** — already fully implemented FE+BE | Verified directly in code (`AuthCard.tsx`, `auth.service.ts`); backlog doc was stale |
| DEC-2 | Profile avatar storage | **URL text field only** — no file upload, no new storage endpoint | Simplest MVP; avoids re-opening `IStorageProvider` for a low-value field |
| DEC-3 | Profile change-password while logged in | **In scope** — `PATCH /auth/change-password` (old password verified server-side) | Basic expectation of any profile page; distinct from the email-OTP forgot-password flow |
| DEC-4 | Translation history retention | **Cap at 50 most-recent rows per user**, auto-prune older rows past the cap | Avoids unbounded DB growth; simple to implement (no pagination needed) |
| DEC-5 | Chunked-translation credit pricing | **N credits = 1 credit per ~6,000-char chunk** | Reflects actual Gemini API call cost; button must show dynamic cost, not a hardcoded "1 Credit" |
| DEC-6 | Max text length per translate request | **20,000 characters hard cap** (BadRequestException above this) | Bounds worst-case Gemini call count (~4 chunks) and abuse/cost risk |

## Risk Assessment

| Risk | Likelihood (1-5) | Impact (1-5) | Score | Mitigation |
|------|-----------------|--------------|-------|------------|
| Chunk-boundary splitting breaks sentence/paragraph meaning, degrading translation quality | 3 | 4 | 12 | Split on paragraph (`\n\n`) boundaries first; only fall back to sentence-boundary splitting for a single paragraph that itself exceeds the chunk size; never split mid-sentence as a first resort |
| Dynamic per-chunk credit cost surprises users (translate button cost changes as they type) | 3 | 3 | 9 | Live character counter + live "~N Credits" label recalculated on every keystroke, shown before the user clicks Translate |
| Auto-detect Gemini call misidentifies language → garbled "translation" | 2 | 3 | 6 | Reuse the proven `stt.service.ts` JSON-detect-prompt shape; if Gemini's returned language code fails ISO-639-1 sanity check, fall back to requiring manual `sourceLang` (existing behavior) instead of silently mistranslating |
| `TranslationHistory` writes on every translate call add DB load | 2 | 2 | 4 | Capped at 50/user with an immediate prune-after-insert (delete rows beyond the 50 most recent for that user) — bounded table size per user |
| Frontend/backend `MAX_UPLOAD_MB` drift recurs in the future (env var typo, forgetting to update one side) | 2 | 3 | 6 | Single source of truth: backend `.env` value is the only place the number is set; frontend reads `NEXT_PUBLIC_MAX_UPLOAD_MB` from the same `.env` convention, with a build-time default matching backend's `100` |
| `InsufficientCreditsError` code wiring missed on one of the 3 credit-consuming endpoints (translate/TTS/video-job) | 2 | 2 | 4 | Single shared error class thrown from `CreditService`-adjacent checks in all 3 services; Phase 5 explicitly lists all 3 call sites as required edits |

**No risk scores ≥ 15** — this plan has no mandatory pre-phase spike.

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1: Profile Page | M | independent, can run first or last |
| Phase 2: Long Text Chunking | M | blocks Phase 3 |
| Phase 3: Auto-Detect Source Language | S | blocked by 2; blocks Phase 4 |
| Phase 4: Translation History | M | blocked by 3 |
| Phase 5: Credit-Exhausted Notification | S | sequenced after 2-4 (shared file: `TextTranslationSection.tsx`) |
| Phase 6: Video File Size Validation Sync | S | fully independent |
| Total | ~M+ (6 phases, none individually L) | Critical path: 2 → 3 → 4 |

## Behavioral checklist (verified)

- Data flows traced: profile edit → `PATCH /auth/profile` → DB → `GET /auth/me` refresh (Phase 1); text input → chunk split → N×Gemini calls → concat → cache per-chunk → credit deduct ×N (Phase 2); text+`auto` → detect-prompt → resolved `sourceLang` → same chunked-translate path (Phase 3); every successful translate → `TranslationHistory` insert → prune >50 (Phase 4); insufficient-credit error → `code` field → Toast action button → scroll-to-billing (Phase 5); video file select → client size check → reject before upload if over cap (Phase 6).
- Dependency graph + critical path explicit above.
- No risk ≥ 15 — no mandatory pre-phase spike gates this plan.
- Backwards-compat: all phases additive. `TranslationCache` (global dedup) is untouched and continues to work alongside the new per-user `TranslationHistory`. Existing single-call translate behavior is preserved for text ≤ chunk-size (effectively 1 chunk = 1 Gemini call, same as today).
- Every phase has a verification command/criteria (see phase files).
- Rollback documented per phase (single-file reverts + down-migration for Phase 4's schema change).
- File ownership: `translation.service.ts` and `translation.controller.ts` are touched by Phases 2, 3, 4, 5 — sequenced (not concurrent) per the dependency chain above; single-agent execution means no actual race, just an ordering requirement.
- `TextTranslationSection.tsx` touched by Phases 2, 3, 4, 5 — same sequencing note.

## Handoff

`/t1k:cook plans/260623-1450-ux-feature-completeness/plan.md`
