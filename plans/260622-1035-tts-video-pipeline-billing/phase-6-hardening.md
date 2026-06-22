# Phase 6 — Hardening (rate limiting, caching, reset-password, tests)

**Effort:** M | **Blocked by:** all prior phases (cross-cutting) | **Blocks:** none

## Goal

Close the gaps `CLAUDE.md` mandates but the codebase lacks: rate limiting, caching, error-code hygiene, plus the missing forgot/reset-password flow and the zero test coverage.

## Scope & file ownership

### 6a. Rate limiting (`@nestjs/throttler`, installed in Phase 0)
- `backend/src/app.module.ts` — register `ThrottlerModule` (global) with sane limits from env.
- Tighter per-route limits on expensive endpoints: `POST /tts/speak`, `POST /translation/video-job`, `POST /translation/translate`, all `auth/*` (anti-brute-force), `POST /billing/topup`.
- Ensure 429 responses carry a clear message (per `CLAUDE.md` rule #4).

### 6b. Caching
- Text translation + TTS already DB-cache by hash (reuse). Add an in-memory/`@nestjs/cache-manager` layer for hot read endpoints (`GET /tts/voices`, `GET /health`) to avoid recompute. Keep it simple (KISS) — Redis is already present in the stack (Phase 2's BullMQ dependency), but reuse it only if convenient; do not introduce a second cache backend just because Redis exists.

### 6c. Forgot / Reset password (currently missing)
- `backend/src/auth/auth.service.ts` — add `requestPasswordReset(email)` (generic anti-enumeration response, reuse the OTP/token + TTL + cooldown pattern already proven for email verification) and `resetPassword(token, newPassword)`.
- `backend/src/auth/auth.controller.ts` — `POST /auth/forgot-password`, `POST /auth/reset-password`.
- `backend/src/mail/mail.service.ts` — add a reset-password email template (reuse nodemailer transport).
- `backend/prisma/schema.prisma` — add reset-token fields on `User` (or reuse a generic token table) + migration.
- `frontend/src/app/page.tsx` — "Quên mật khẩu?" link → request screen → reset screen.

### 6d. Tests (zero coverage today)
- `backend/src/auth/*.spec.ts` — register/login/verify-OTP/MFA happy + failure paths, anti-enumeration, reset-password.
- `backend/src/translation/translation.service.spec.ts` — cache hit/miss, credit deduction, mock-fallback, credits-exhausted error.
- `backend/src/tts/tts.service.spec.ts` — cache-by-(text,voice), deduct-on-miss-only.
- `backend/src/billing/billing.service.spec.ts` — **idempotent double-confirm test** (mandatory — the headline correctness risk: confirming an already-CONFIRMED `CreditTopupRequest` must no-op, not double-credit), admin-guard rejection test (non-ADMIN role gets 403).
- `backend/src/translation/queue.service.spec.ts` — pipeline FAILED state sets errorMessage + no credit deduction.
- Mock Gemini/ffmpeg/payment at the boundary; do not call real external services in unit tests.

### 6e. Cleanup items noticed
- Stray `backend/dev.db` sqlite file (schema is postgres-only) — confirm `@prisma/adapter-better-sqlite3` / `better-sqlite3` are unused at runtime, then propose removal (FLAG to user, do not silently delete — `rules/development-principles.md` Pre-Delete Reference Check).
- Deprecated fake fields on `VideoJob` (`subtitlesUrl` as `/downloads/...`) — migrate consumers to storage-key fields, then drop.

## Verification (success criteria)

- `cd backend && npm test` → all suites pass, **zero failures** (Test Pass Gate, `rules/development-principles.md`).
- Hammer an auth route past the limit → 429 with a clear message.
- Forgot-password end-to-end: request → email → reset → login with new password.
- Coverage report shows auth + translation + tts + billing services covered (not just framework boilerplate).

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Throttler blocks legit polling (frontend polls jobs every 3s) | 3 | 3 | 9 | exempt/relax the job-status GET; only throttle mutating + expensive routes |
| Tests flaky due to real external calls | 3 | 3 | 9 | mock Gemini/ffmpeg/payment boundaries; no network in unit tests |
| Reset-token reuse / leak | 2 | 4 | 8 | single-use token, short TTL, hash stored, invalidate on use (reuse verify-email proven pattern) |

## Rollback

Each sub-item (6a–6e) is an independent commit; revert individually. Tests are additive. Migrations have down paths.
