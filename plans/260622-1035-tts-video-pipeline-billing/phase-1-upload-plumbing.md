# Phase 1 — Video Upload Plumbing

**Effort:** M | **Blocked by:** Phase 0 | **Blocks:** Phase 2

## Goal

Make the frontend actually send video bytes to the backend, persist them via a storage abstraction, and serve generated outputs back. Today only the filename is sent; no file storage or download route exists.

## Decision (default — flag to user)

**Storage = local disk behind an `IStorageProvider` interface.** Per `rules/library-third-party-decoupling.md`, define the interface first; ship a `LocalDiskStorageProvider`; leave `S3StorageProvider` as an opt-in stub. Files live under `backend/storage/{uploads,outputs}/` (gitignored).

## Scope & file ownership

- `backend/src/storage/storage.interface.ts` (NEW) — `IStorageProvider { save(buf, key), read(key), stream(key), exists(key), delete(key) }`, generic types only.
- `backend/src/storage/local-disk.provider.ts` (NEW) — disk impl under a configurable `STORAGE_ROOT` env var (no hardcoded path).
- `backend/src/storage/storage.module.ts` (NEW) — DI wiring; provider chosen by `STORAGE_DRIVER` env.
- `backend/src/translation/translation.controller.ts` — change `POST /translation/video-job` to `@UseInterceptors(FileInterceptor('video'))` (multer), accept the real file; add `GET /translation/output/:jobId/:kind` (kind = srt|video|audio) streaming from storage with auth + ownership check.
- `backend/src/translation/dto/create-video-job.dto.ts` — keep `targetLang`; `fileName` now derived from upload; add optional `sourceUrl` (URL-paste path).
- `backend/src/translation/translation.service.ts` — `createVideoJob` accepts a stored `storageKey` instead of a bare fileName; persist key on `VideoJob` (add field, see schema).
- `backend/prisma/schema.prisma` — add `inputStorageKey String?` to `VideoJob` (migration).
- `frontend/src/app/page.tsx` — change video submit to `FormData` with the real `videoFile` blob; wire the "download SRT" link to the new `GET /translation/output/:jobId/srt`.

## Data flow

```
browser videoFile (Blob)
  → FormData POST /translation/video-job (multipart)
  → multer → IStorageProvider.save → storageKey
  → VideoJob row { inputStorageKey, status:PENDING }
  ... (Phase 2 processes) ...
  → outputs saved via storage → GET /translation/output/:jobId/:kind streams back
```

## Verification

- Upload a 10MB mp4 → file appears under `storage/uploads/`, job row has `inputStorageKey`.
- `GET /translation/output/:jobId/srt` returns 404 until Phase 2 produces it; returns 403 for a non-owner; never path-traverses (`:kind` whitelisted).
- Frontend network tab shows multipart body with real bytes.

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Large upload exhausts memory / no size limit | 3 | 4 | 12 | multer disk storage (not memory) + `limits.fileSize` from env; reject >N MB with 413 |
| Path traversal via :kind or :jobId | 2 | 5 | 10 | whitelist kind enum; resolve key from DB row by jobId, never from client string |
| Output download leaks other users' files | 2 | 5 | 10 | ownership check (job.userId === req.user.id) before stream |

## Rollback

Revert controller to old DTO + drop `inputStorageKey` migration (down migration). Storage dir is gitignored; safe to delete.

## Known limitation (deferred, not fixed)

The implemented upload path deviates from this phase's own mitigation above: `FileInterceptor('video')` uses multer's default **memory** storage (`file.buffer`), not disk storage, and `IStorageProvider.save`/`read` are buffer-based (no streaming variant). Phase 2's worker inherits this — it buffers whole input/output videos in memory rather than streaming them. Bounded today by `MAX_UPLOAD_MB` (default 100MB) and worker concurrency (2), so worst case is ~2 large buffers in flight at once. User-confirmed 2026-06-22: defer a streaming I/O rework (multer disk storage + stream-based `IStorageProvider` methods) to a future hardening pass (Phase 6 or later) rather than redoing the already-shipped Phase 1 interface now.
