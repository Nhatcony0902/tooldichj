# Phase 2 — Real Video Pipeline

**Effort:** L (Redis/BullMQ infra setup adds a sub-task; see Tasks below — kept at L, not bumped, because the infra is mechanical/well-trodden, but flagged explicitly) | **Blocked by:** Phase 1 | **Blocks:** Phase 4

## Goal

Replace `queue.service.ts`'s simulated progress with real job-step workers: audio extraction → STT → subtitle translation (reuse existing service) → hardsub burn-in. Surface real errors via the existing `VideoJob.errorMessage` field.

## Decisions

- **STT = Gemini multimodal direct** (CONFIRMED — DEC-C). Feed extracted audio to Gemini; obtain timestamped transcript (source lang). Reuses existing `@google/genai` key/SDK, no new STT dependency.
- **Job model = BullMQ + Redis** (CONFIRMED — DEC-D, user rejected in-process/cron-only). A producer enqueues a job on `POST /translation/video-job`; a separate BullMQ worker process/module consumes the queue and runs the pipeline steps (extract → STT → translate → burn-in). BullMQ's built-in retry/backoff replaces the old manual progress-percentage simulation. `@nestjs/schedule` cron-pump design is dropped for video jobs.

## New infra sub-task (BullMQ + Redis setup)

This is genuinely new infrastructure, not just new application code — call it out as its own checklist item before pipeline-step code:

1. **`docker-compose.yml`** — add a `redis` service (`redis:7-alpine`), no host port published (internal Docker network only — `db` already uses host port `5435:5432`, so Redis stays container-internal to avoid any conflict; backend reaches it via the Docker network hostname `redis:6379`). Add a `redis_data` volume if persistence across restarts is desired (optional — job queue data is transient, so an unnamed/ephemeral volume is acceptable).
2. **`backend/package.json`** — add `bullmq` + `ioredis` to `dependencies` (install in the same batch as Phase 0's other new deps if Phase 0 hasn't shipped yet; otherwise install now).
3. **`backend/.env.example`** — add `REDIS_HOST`, `REDIS_PORT` (placeholders matching the compose service).
4. **`backend/src/queue/queue.module.ts`** (NEW) — registers the BullMQ connection (`ioredis` client from env) + the `video-pipeline` queue, shared by producer and worker.

## Scope & file ownership

- `backend/src/translation/queue.service.ts` — REWRITE as the **BullMQ producer**: `POST /translation/video-job` enqueues `{ jobId }` onto the `video-pipeline` queue (via `@nestjs/bullmq`'s `@InjectQueue`) instead of relying on a cron pump. No more progress-percentage simulation — progress now comes from the worker's real step completions (BullMQ job `updateProgress` / DB row updates the frontend already polls).
- `backend/src/translation/pipeline/video-pipeline.worker.ts` (NEW) — the **BullMQ worker** (`@Processor('video-pipeline')` or `Worker` class): consumes one job at a time (concurrency configured on the `Worker`, not a manual guard flag), runs extract → STT → translate → burn-in in sequence, updates `VideoJob.progress`/`stepDescription` after each real step. On any throw: BullMQ's built-in retry/backoff kicks in (configurable attempts); on final exhaustion, set `status:FAILED`, `errorMessage`, do NOT decrement credits.
- `backend/src/translation/pipeline/audio-extractor.ts` (NEW) — ffmpeg extract wav/mp3 from input via `fluent-ffmpeg`.
- `backend/src/translation/pipeline/stt.service.ts` (NEW) — Gemini multimodal: audio → timestamped segments (source text). Returns `Segment[] {start,end,text}`.
- `backend/src/translation/pipeline/subtitle.service.ts` (NEW) — translate each segment via existing `TranslationService.translate` (reuse cache + credits), assemble `.srt`.
- `backend/src/translation/pipeline/burn-in.service.ts` (NEW) — ffmpeg hardsub: input video + srt → output mp4, save via storage.
- `backend/prisma/schema.prisma` — add `FAILED` to status usage (string already; ensure frontend handles it); add `transcript Json?` and `srtStorageKey String?`, `outputVideoKey String?` to `VideoJob` (migration). Keep existing `subtitlesUrl`/`outputVideoUrl` or migrate to storage keys (prefer keys; deprecate the fake URL fields).
- `frontend/src/app/page.tsx` — render `FAILED` state with `errorMessage`; real step descriptions already display via polling (polling target is unchanged — it still reads `VideoJob` rows, now updated by the BullMQ worker instead of the cron pump).

## Pipeline steps (progress mapping)

| Step | progress | stepDescription |
|------|----------|-----------------|
| extract audio | 15 | Trích xuất âm thanh... |
| STT | 40 | Nhận dạng giọng nói... |
| translate segments | 70 | Dịch phụ đề bằng Gemini... |
| burn-in | 90 | Chèn cứng phụ đề vào video... |
| save outputs + deduct credits | 100 | Hoàn tất |

## Credit model

Deduct credits **only on COMPLETED** (matches current 10-credit deduction), inside the same transaction that flips status. On FAILED (including after BullMQ exhausts its configured retries), no deduction. Avoids charging for failed jobs.

## Verification

- Upload a short real mp4 with speech → job reaches COMPLETED, produces a real `.srt` (downloadable via Phase 1 endpoint) and a burned-in mp4.
- Kill ffmpeg mid-run → BullMQ retries per configured backoff; after retries exhaust, job goes FAILED with a clear `errorMessage`, credits unchanged.
- BullMQ worker concurrency setting prevents overlap-processing the same job; two enqueues of the same `jobId` do not double-process (dedupe on `VideoJob.status` check at worker start).
- `docker-compose up` brings up `redis` alongside `db`; backend connects to it via `REDIS_HOST`/`REDIS_PORT` env.

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| ffmpeg missing/slow blocks event loop | 4 | 4 | 16 | child_process (not sync); /health gate from Phase 0; BullMQ worker concurrency cap |
| Redis dependency not running in dev/CI/Jenkins | 4 | 4 | 16 | extend Phase 0's `/health` check to also probe Redis connectivity (`ioredis` ping), same pattern as the existing ffmpeg-absent check; Jenkinsfile + `docker-compose.yml` ensure Redis is started alongside Postgres; document as a runtime prerequisite in `CLAUDE.md` |
| Gemini STT timestamp/segment shape unreliable | 3 | 4 | 12 | spike STT response shape before wiring; fall back to whole-audio transcript + heuristic timing |
| Long jobs exceed Gemini token/audio limits | 3 | 3 | 9 | chunk audio by silence/duration; document max input length |
| Credit double-deduct if worker retries/re-enters | 2 | 4 | 8 | deduct only inside the COMPLETED transition transaction; worker re-checks `VideoJob.status` before processing (idempotent re-entry) |

## Rollback

`queue.service.ts` rewrite + new `video-pipeline.worker.ts` are additive/isolated — revert the phase commit restores the cron simulation. Removing `redis` from `docker-compose.yml` and `bullmq`/`ioredis` from `package.json` fully reverts the infra. Down-migration drops new VideoJob columns.
