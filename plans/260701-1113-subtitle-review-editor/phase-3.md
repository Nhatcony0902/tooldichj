# Phase 3: Frontend Review / Edit UI + Status Wiring

Effort: M-L · Depends on: Phase 2 (live endpoints) · Blocks: none

> **AGENTS.md gate:** `frontend/AGENTS.md` — "This is NOT the Next.js you know." Our changes are a plain React client component (`useState`/`fetch`), no App Router API surface, so risk is low — but the implementer must confirm no deprecation warnings on `npm run build` and read `node_modules/next/dist/docs/` before touching any Next-specific API.

## Goal

When a job reaches `AWAITING_REVIEW`, show an editable table of subtitle lines (translated text editable; original text + timing read-only per Decision 1), a "Save draft" action (PATCH), and a "Confirm & finalize" action (POST confirm). Add the new status badge/label and keep polling alive through review.

## Files Owned

- `frontend/src/app/types/index.ts`
- `frontend/src/app/components/VideoTranslationSection.tsx`
- `frontend/src/app/page.module.css`

## API Contract (verbatim from plan.md)

- `GET  /translation/video-jobs/:id/segments` → `{ success, segments: [{ index, start, end, text, translatedText }] }`
- `PATCH /translation/video-jobs/:id/segments` body `{ segments: [{ index, translatedText }] }` → `{ success: true }`
- `POST /translation/video-jobs/:id/confirm` → `{ success: true, job }`

Base URL `http://localhost:3001` and `Authorization: Bearer ${token}` — same pattern as existing handlers (`VideoTranslationSection.tsx:145-203`).

## Steps

### 1. `types/index.ts`

- Extend the union (line 13): add `"AWAITING_REVIEW"`.
  ```ts
  status: "PENDING" | "PROCESSING" | "AWAITING_REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED";
  ```
- Add an editable-segment type:
  ```ts
  export interface SubtitleSegment {
    index: number;
    start: number;
    end: number;
    text: string;           // original (read-only)
    translatedText: string; // editable
  }
  ```

### 2. `VideoTranslationSection.tsx`

**State** (near line 36):
```ts
const [reviewJobId, setReviewJobId] = useState<string | null>(null);
const [reviewSegments, setReviewSegments] = useState<SubtitleSegment[]>([]);
const [reviewLoading, setReviewLoading] = useState(false);
const [reviewSaving, setReviewSaving] = useState(false);
```

**Polling (lines 64-89):** add `AWAITING_REVIEW` to the `hasActiveJobs` predicate so the 3s poll keeps running while a job waits for review and through the subsequent burn phase (R8):
```ts
const hasActiveJobs = jobs.some(
  (job) => job.status === "PENDING" || job.status === "PROCESSING" || job.status === "AWAITING_REVIEW"
);
```

**Handlers** (beside `handleCancelJob`):
```ts
const openReview = async (jobId: string) => {
  if (!token) return;
  setReviewLoading(true);
  setReviewJobId(jobId);
  try {
    const res = await fetch(`http://localhost:3001/translation/video-jobs/${jobId}/segments`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok && data.success) setReviewSegments(data.segments);
    else { showToast("error", data.message || "Không tải được phụ đề."); setReviewJobId(null); }
  } catch { showToast("error", "Lỗi kết nối khi tải phụ đề."); setReviewJobId(null); }
  finally { setReviewLoading(false); }
};

const editSegment = (index: number, value: string) =>
  setReviewSegments((prev) => prev.map((s) => (s.index === index ? { ...s, translatedText: value } : s)));

const saveDraft = async () => {
  if (!token || !reviewJobId) return;
  setReviewSaving(true);
  try {
    const res = await fetch(`http://localhost:3001/translation/video-jobs/${reviewJobId}/segments`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        segments: reviewSegments.map((s) => ({ index: s.index, translatedText: s.translatedText })),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) showToast("success", "Đã lưu bản chỉnh sửa.");
    else showToast("error", data.message || "Không lưu được. Kiểm tra các dòng trống.");
  } catch { showToast("error", "Lỗi kết nối khi lưu."); }
  finally { setReviewSaving(false); }
};

const confirmReview = async () => {
  if (!token || !reviewJobId) return;
  // save first so the burn uses the latest edits, then confirm
  await saveDraft();
  try {
    const res = await fetch(`http://localhost:3001/translation/video-jobs/${reviewJobId}/confirm`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      showToast("success", "Đã xác nhận — đang tạo video.");
      setReviewJobId(null); setReviewSegments([]);
      await fetchJobs(token);
    } else showToast("error", data.message || "Không xác nhận được.");
  } catch { showToast("error", "Lỗi kết nối khi xác nhận."); }
};
```

**Status badge/label maps (lines 332-351):** add `AWAITING_REVIEW`:
- badge class map: `AWAITING_REVIEW: styles.badgeReview,`
- label map: `AWAITING_REVIEW: "Chờ duyệt",`

**Job-row actions (lines 414-434):** add an `AWAITING_REVIEW` branch before the PENDING/PROCESSING branch — a "Kiểm tra & sửa phụ đề" button that calls `openReview(job.id)`, plus the existing "Huỷ" button (cancel now allowed for this status):
```tsx
) : job.status === "AWAITING_REVIEW" ? (
  <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
    <button className={styles.jobReviewBtn} onClick={() => openReview(job.id)}>
      Kiểm tra & sửa phụ đề
    </button>
    <button className={styles.jobCancelBtn} onClick={() => handleCancelJob(job.id)}>Huỷ</button>
  </div>
) : job.status === "PENDING" || job.status === "PROCESSING" ? (
```

**Review editor panel** — render a modal/inline panel when `reviewJobId` is set (place inside the outer return, e.g. after the jobs list). A scrollable table keyed by `segment.index`:
- Columns: `#` (index+1), timing `mm:ss → mm:ss` (read-only, formatted from `start`/`end`), original `text` (read-only, muted), and a `<textarea>`/`<input>` bound to `translatedText` via `editSegment`.
- Footer buttons: **Lưu nháp** (`saveDraft`, disabled while `reviewSaving`), **Xác nhận & tạo video** (`confirmReview`), **Đóng** (`() => { setReviewJobId(null); setReviewSegments([]); }`).
- Show a spinner while `reviewLoading`.
- Timing formatter: reuse a small `mm:ss` helper (`Math.floor(sec/60)`:`sec%60`) — no new dependency.

### 3. `page.module.css`

- `.badgeReview` — an "attention/amber" tone distinct from the neutral `.badgeCancelled` and the blue `.badgeProcessing` (e.g. `background: rgba(251,191,36,0.15); color: #f59e0b;`), matching the existing glassmorphism badge style.
- `.jobReviewBtn` — a primary-accent small button (reuse the visual language of `.jobCancelBtn`/`.jobDeleteBtn` at lines added by the cancel/delete feature).
- Review panel classes: `.reviewPanel`, `.reviewTable`, `.reviewRow`, `.reviewOriginal` (muted), `.reviewInput`, `.reviewActions` — glassmorphism-consistent (border `rgba(255,255,255,...)`, radius ~8-12px, dark-mode friendly). If a modal overlay is used, add `.reviewOverlay` (fixed, backdrop blur).

## Verification

```bash
cd frontend && npm run build
cd frontend && npx eslint .
```

- 0 TS/lint errors, no Next deprecation warnings.
- Manual E2E: submit a job → badge flips to "Chờ duyệt" (polling continues) → click "Kiểm tra & sửa phụ đề" → editor lists all lines with editable translated text and read-only original/timing → edit a line → "Lưu nháp" (toast) → "Xác nhận & tạo video" → panel closes, job progresses to "Hoàn tất" without a page reload, download appears, credits drop by 10.
- Manual: from "Chờ duyệt", click "Huỷ" → status "Đã huỷ", credits unchanged.
- Manual: clear a line to empty → "Lưu nháp" → error toast (backend 400), edit not persisted.

## Risk Notes

plan.md R7 (contract embedded verbatim; Phase 2 merged first), R8 (polling predicate includes `AWAITING_REVIEW`), R9 (single-PATCH full-array is fine for typical subtitle counts; list keyed by `index`; no pagination — YAGNI).
