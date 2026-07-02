# Phase 4 — Frontend degraded-completion warning banner

Effort: **S** · Depends on: Phase 1 (fields exist in the API payload). Coding may parallelize with Phase 2/3; validate after they populate the fields.

## Goal

Surface the degradation to the user so it stops being silent. On a COMPLETED job that was degraded, render a small warning line: some segments untranslated (`untranslatedSegmentCount > 0`) and/or the original-subtitle blur was skipped due to an API error (`blurStatus === 'skipped_error'`). Read-only; no new endpoint (`getVideoJobs` already returns the columns).

## Files owned

- `frontend/src/app/types/index.ts`
- `frontend/src/app/components/VideoTranslationSection.tsx`

## Pre-flight (MANDATORY — `frontend/AGENTS.md`)

This is a non-standard Next.js. Read the relevant guide under `frontend/node_modules/next/dist/docs/` before writing any frontend code; heed deprecation notices. No new data-fetching or server-component patterns are needed here (pure render tweak), but confirm the existing client-component conventions in this file before editing.

## Tasks

### 1. `types/index.ts` — extend the `VideoJob` interface (`:10-23`)

```typescript
untranslatedSegmentCount?: number; // B1: segments left as source after retries
blurStatus?: "applied" | "skipped_no_subtitle" | "skipped_error" | null; // B2
```

Optional (`?`) so old payloads / old jobs (defaults `0` / `null`) type-check and render clean.

### 2. `VideoTranslationSection.tsx` — warning line on COMPLETED jobs (near `:455-460`)

Where the COMPLETED branch renders the video (`:460`), add a warning line ABOVE it, shown only when degraded:

```tsx
{job.status === "COMPLETED" && (job.untranslatedSegmentCount ?? 0) > 0 && (
  <div className={styles.jobWarning}>
    ⚠ {job.untranslatedSegmentCount} câu chưa dịch được và đang giữ nguyên ngôn ngữ gốc.
  </div>
)}
{job.status === "COMPLETED" && job.blurStatus === "skipped_error" && (
  <div className={styles.jobWarning}>
    ⚠ Không thể làm mờ phụ đề gốc (lỗi tạm thời của dịch vụ). Phụ đề gốc vẫn còn trong video.
  </div>
)}
```

- Only `skipped_error` warns. `applied` / `skipped_no_subtitle` / `null` render nothing (legit outcomes).
- Add a `.jobWarning` style consistent with the existing error/secondary text styling (`color: var(--error)` / warning token) — match the module's existing CSS approach; do not invent a new design system.

## Verify

- `cd frontend && npm run build` → exits 0.
- Manual/component: COMPLETED job with `untranslatedSegmentCount=3` → the "3 câu chưa dịch được" line shows above the video.
- Manual/component: COMPLETED job with `blurStatus='skipped_error'` → the blur warning shows; `blurStatus='applied'`/`'skipped_no_subtitle'`/`null` → no warning.

## Rollback

Revert both frontend files. Backend still records the fields; only the banner disappears.
