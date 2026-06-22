# Phase 0 — Config & Setup Fix

**Effort:** S | **Blocked by:** none | **Blocks:** all other phases

## Goal

Eliminate silent-mock pitfalls and install all new dependencies in one batch (per `ai-velocity-batch-compile.md`), before any feature code.

## Scope & file ownership

- `backend/.env.example` — add `GEMINI_API_KEY`, VietQR, storage, Redis vars (placeholders only; NEVER commit real values per `rules/security.md`).
- `backend/src/main.ts` — add a startup health-check log block (own this file in Phase 0 only).
- `backend/src/health/health.controller.ts` (NEW) — `GET /health` returning `{ gemini: bool, ffmpeg: bool, db: bool, smtp: bool, redis: bool }`. The `redis` probe is added once Phase 2 introduces the BullMQ/Redis dependency (same pattern as the ffmpeg check — a cached child/client ping at boot) — if Phase 0 lands before Phase 2 in execution order, this field can be a stubbed `false` until Phase 2 wires the real `ioredis` ping.
- `backend/package.json` — add deps (install batch below).
- Stray `backend/dev.db` (sqlite) — FLAG for user (schema is postgres-only). Do NOT delete silently; propose `git rm` after confirming nothing reads it.

## Tasks

1. **GEMINI_API_KEY config**: document in `.env.example`; on boot, if unset, log a prominent `WARN` (already exists in `TranslationService`) AND expose `gemini:false` via `/health`. Decision: a missing key is a **warning, not a hard fail** (mock fallback is intentional for dev) — but the health endpoint makes the mock state explicit (resolves the "silent mock mode" pitfall without breaking dev).
2. **ffmpeg availability check**: `/health` runs `ffmpeg -version` (child process) once at boot, caches result. Document ffmpeg as a runtime prerequisite in `CLAUDE.md` + Jenkinsfile (add an install step).
3. **Dependency install batch** (single `npm install`):
   - `@nestjs/throttler` (Phase 6 rate limiting)
   - `multer` + `@types/multer` (Phase 1 upload)
   - `fluent-ffmpeg` + `@types/fluent-ffmpeg` (Phase 2/4) — wraps ffmpeg child process
   - `bullmq` + `ioredis` (Phase 2 — BullMQ producer/worker + Redis client)
   - Phase 5 (billing) needs no new SDK — VietQR is a static image URL (no SDK, no merchant account)
4. **dev.db cleanup**: confirm no code references sqlite at runtime (schema datasource is `postgresql`; `better-sqlite3`/`@prisma/adapter-better-sqlite3` are in deps — verify they are unused before proposing removal). Report finding; let user decide deletion.

## Verification (success criteria)

- `cd backend && npm run build` passes.
- `GET /health` returns 200 with all four booleans; `ffmpeg:true` on a machine with ffmpeg installed.
- Boot log shows the GEMINI warning when key absent, no warning when present.

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| ffmpeg absent on dev/CI/Jenkins | 4 | 4 | 16 | /health surfaces it; Jenkinsfile + CLAUDE.md install step; Phase 2 hard-depends on this passing |
| Redis absent on dev/CI/Jenkins (Phase 2 BullMQ dependency) | 4 | 4 | 16 | `/health` redis probe (same pattern as ffmpeg check); `docker-compose.yml` ships a `redis` service; Jenkinsfile ensures it's up before tests; Phase 2 hard-depends on this passing |
| sqlite deps actually in use (deleting dev.db breaks something) | 2 | 3 | 6 | grep for adapter-better-sqlite3 usage before any removal; report, don't auto-delete |
| New deps version-conflict with NestJS 11 | 2 | 3 | 6 | install + build in one batch; pin compatible majors |

## Rollback

All changes additive (new files + .env.example + deps). Revert by `git checkout` of the phase commit; no data migration.
