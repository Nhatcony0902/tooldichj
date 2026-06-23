# Phase 6: Video File Size Validation Sync

**Effort:** S
**Depends on:** none (fully independent)
**Blocks:** none

## Goal

Fix the FE/BE mismatch — `VideoTranslationSection.tsx` line 173 hardcodes `"Hỗ trợ MP4, MOV, MKV (Tối đa 50MB)"` while `translation.controller.ts` line 45-46 actually enforces `MAX_UPLOAD_MB` env var (default 100MB). Add a real client-side pre-check so oversized files are rejected before upload starts, not after a failed multer round-trip.

## Files owned by this phase

- `frontend/.env.example` (or `.env.local.example` if that's the existing convention — check first) — add `NEXT_PUBLIC_MAX_UPLOAD_MB=100`
- `frontend/src/app/components/VideoTranslationSection.tsx` — read the env var, dynamic label, client-side size check before `fetch`
- `backend/.env.example` — confirm `MAX_UPLOAD_MB` is already documented there (if not, add it as part of this phase since it's the source of truth this phase mirrors)

## Implementation notes

### Single source of truth

Backend's `MAX_UPLOAD_MB` (default `100`, see `translation.controller.ts` line 45-46) is authoritative — it's what multer actually enforces. Frontend gets `NEXT_PUBLIC_MAX_UPLOAD_MB` as a **build-time mirror** of the same number (Next.js `NEXT_PUBLIC_*` vars are inlined at build time, not read at runtime — document this clearly so a future env change on one side without rebuilding the other doesn't silently drift again, same Risk Assessment item as `plan.md`'s DEC-area note).

### Frontend changes

```tsx
const MAX_UPLOAD_MB = Number(process.env.NEXT_PUBLIC_MAX_UPLOAD_MB) || 100;
const MAX_UPLOAD_BYTES = MAX_UPLOAD_MB * 1024 * 1024;
```

Dynamic label (replaces the hardcoded line):
```tsx
<p style={{ fontSize: "0.75rem", color: "var(--text-muted)", marginTop: "0.25rem" }}>
  Hỗ trợ MP4, MOV, MKV (Tối đa {MAX_UPLOAD_MB}MB)
</p>
```

Client-side pre-check in the file input's `onChange` (currently `onChange={(e) => setVideoFile(e.target.files?.[0] || null)}`):
```tsx
onChange={(e) => {
  const file = e.target.files?.[0] || null;
  if (file && file.size > MAX_UPLOAD_BYTES) {
    showToast("error", `File quá lớn (${(file.size / 1024 / 1024).toFixed(1)}MB). Tối đa ${MAX_UPLOAD_MB}MB.`);
    e.target.value = "";
    setVideoFile(null);
    return;
  }
  setVideoFile(file);
}}
```

Also add the same check at the top of `handleVideoSubmit` (defense in depth — covers the case where `videoFile` state was somehow set without going through the input's `onChange`, e.g. a future drag-and-drop addition):
```ts
if (videoFile && videoFile.size > MAX_UPLOAD_BYTES) {
  showToast("error", `File quá lớn. Tối đa ${MAX_UPLOAD_MB}MB.`);
  return;
}
```

### Env files

Check `frontend/` for an existing `.env.example` (or equivalent) before creating one — match the project's existing convention rather than introducing a new file pattern. Add:
```
NEXT_PUBLIC_MAX_UPLOAD_MB=100
```
Confirm `backend/.env.example` documents `MAX_UPLOAD_MB=100` already (it should, given the controller already reads it) — if missing, add it here so both sides are documented in the same phase that fixes their sync.

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| Frontend deployed without rebuilding after `NEXT_PUBLIC_MAX_UPLOAD_MB` changes on the backend `.env` → stale client-side limit | 2 | 2 | 4 | Documented inline (Next.js `NEXT_PUBLIC_*` build-time inlining behavior) — operational note for whoever changes the env var in the future, not something code can prevent |
| Client check uses `file.size` (actual bytes) vs. backend's `fileSize` multer limit — should match exactly since both are byte-for-byte comparisons against the same MB×1024×1024 formula | 1 | 1 | 1 | Both sides use the identical `MB * 1024 * 1024` formula — verified by inspection, no drift possible from the formula itself |

## Timeline

| Step | Effort |
|------|--------|
| Frontend: env var + dynamic label + client-side check (2 call sites) | S |
| Env file documentation | S |
| **Total** | **S** |

## Verification

1. Manual: with `NEXT_PUBLIC_MAX_UPLOAD_MB` unset (default 100), the dropzone label reads "Tối đa 100MB" (not the old hardcoded 50MB).
2. Manual: select a file >100MB → immediate toast error, `videoFile` state stays `null`, no network request fires (confirm via browser devtools Network tab — zero `POST /translation/video-job` calls).
3. Manual: select a file just under the limit → proceeds normally, uploads successfully (regression check — confirms the check doesn't false-positive on valid files).
4. Set `NEXT_PUBLIC_MAX_UPLOAD_MB=10` in `.env.local`, rebuild/restart `npm run dev` → label updates to "Tối đa 10MB", confirms the env var is actually wired (not a hardcoded fallback silently always winning).

## Rollback

Revert `VideoTranslationSection.tsx` to the hardcoded-50MB-label, no-client-check state. Remove the added env var lines (harmless to leave them, since unused env vars don't break anything, but revert for cleanliness if needed).
