# Phase 3: Frontend Confirm-Flow Fix (I3)

**Files owned:** `frontend/src/app/components/VideoTranslationSection.tsx`

File-disjoint from all other phases.

---

## I3 — `confirmReview` proceeds even when `saveDraft` failed

**Root cause:** `saveDraft` (`VideoTranslationSection.tsx:196-218`) catches its own errors, shows a toast, and returns `undefined` either way — it never signals failure to its caller. `confirmReview` (line 220-241) does `await saveDraft();` then unconditionally calls the `/confirm` endpoint, burning whatever segments are already stored server-side (the LAST successfully saved version, not the user's latest unsaved edit).

**Fix:**

1. Make `saveDraft` return a boolean success signal instead of swallowing silently:
   ```typescript
   const saveDraft = async (): Promise<boolean> => {
     if (!token || !reviewJobId) return false;
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
       if (res.ok) {
         showToast("success", "Đã lưu bản chỉnh sửa.");
         return true;
       }
       showToast("error", data.message || "Không lưu được. Kiểm tra các dòng trống.");
       return false;
     } catch {
       showToast("error", "Lỗi kết nối khi lưu.");
       return false;
     } finally {
       setReviewSaving(false);
     }
   };
   ```
2. Gate `confirmReview` on the result:
   ```typescript
   const confirmReview = async () => {
     if (!token || !reviewJobId) return;
     // save first so the burn uses the latest edits — abort confirm if the save failed
     const saved = await saveDraft();
     if (!saved) return;
     try {
       const res = await fetch(`http://localhost:3001/translation/video-jobs/${reviewJobId}/confirm`, {
         method: "POST",
         headers: { Authorization: `Bearer ${token}` },
       });
       const data = await res.json().catch(() => ({}));
       if (res.ok) {
         showToast("success", "Đã xác nhận — đang tạo video.");
         setReviewJobId(null);
         setReviewSegments([]);
         await fetchJobs(token);
       } else {
         showToast("error", data.message || "Không xác nhận được.");
       }
     } catch {
       showToast("error", "Lỗi kết nối khi xác nhận.");
     }
   };
   ```
3. Check the existing `onClick={saveDraft}` binding at line 591 — since `saveDraft`'s signature changes from `Promise<void>` to `Promise<boolean>`, confirm no caller relies on its return value being `void` (TypeScript will catch any real incompatibility at build time; a `Promise<boolean>` handler bound to `onClick` is still valid).

**Verify:**
- Manual: blank out a subtitle line (triggers the backend's "Danh sách phụ đề không hợp lệ" 400), click "Xác nhận" — expect the error toast from the failed save, `/confirm` is NEVER called (verify via network tab / a spy in a component test), and the review screen stays open so the user can fix the line.
- Manual: valid edits, click "Xác nhận" — unchanged happy path, save succeeds then confirm succeeds.
- `cd frontend && npm run build && npm run lint` exits 0.
