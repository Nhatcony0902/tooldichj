# Plan: Video Job Cancel / Delete + UI tiến trình

Thêm khả năng **Cancel** (huỷ job đang chờ/đang xử lý) và **Delete** (xoá job đã kết thúc + dọn file storage) cho tính năng dịch video, cùng với việc làm đẹp/rõ ràng hơn phần hiển thị tiến trình. Không thêm package mới.

## Scope đã xác nhận từ scout

- Credits chỉ bị trừ **sau khi COMPLETED** (trong transaction ở `video-pipeline.worker.ts` dòng 226-253). Cancel PENDING/PROCESSING → KHÔNG hoàn credits (chưa từng trừ). Delete COMPLETED/FAILED/CANCELLED → an toàn về credits.
- `VideoJob.status` là cột `String` (không phải enum DB) → thêm giá trị `CANCELLED` KHÔNG cần migration schema.
- Storage có sẵn `delete(key)` trong `IStorageProvider` (`storage.interface.ts`).
- Worker (`video-pipeline.worker.ts`) hiện chỉ check `status === 'COMPLETED'` để skip — KHÔNG có checkpoint cho `CANCELLED` giữa chừng → đây là rủi ro chính (xem Risk R1).
- Frontend type `VideoJob.status` (frontend/src/app/types/index.ts) chưa có `CANCELLED`.

---

## Phases

- **Phase 1: Backend** — cancel endpoint + delete endpoint + 2 service methods + status `CANCELLED`. | Effort: M
- **Phase 2: Frontend** — nút Cancel/Delete + UI polish (badge tiếng Việt, progress bar, label). | Effort: M

### Feasibility
- **Reuse check:** Tái sử dụng `storage.delete()`, pattern guard `getVideoJobById` + ownership check (đã có ở `getOutput`), pattern `@Delete('history')`. KHÔNG cần package mới, KHÔNG cần Prisma migration (status là String). Controller đã import `Delete`, `Patch`-tương-đương dùng `Post`.
- **Complexity:** moderate — phần khó duy nhất là đảm bảo worker tôn trọng job đã CANCELLED (R1).

### Dependencies
- **Phase 2 blocked by Phase 1** — frontend gọi các endpoint mới; cần contract cố định trước (xem Contract bên dưới).
- Phase 1 không bị block bởi gì.

---

## API Contract (cố định trước — cả 2 phase tuân theo)

| Thao tác | Method + Path | Body | Success resp | Lỗi |
|---|---|---|---|---|
| Cancel | `POST /translation/video-jobs/:id/cancel` | none | `{ success: true, job }` | `{ success: false, error }` |
| Delete | `DELETE /translation/video-jobs/:id` | none | `{ success: true }` | `{ success: false, error }` |

- Cả hai dùng `JwtAuthGuard`; ownership bắt buộc (`job.userId === req.user.id`, nếu sai → `ForbiddenException`).
- Job không tồn tại → `NotFoundException`.
- Cancel khi status ∈ {COMPLETED, FAILED, CANCELLED} → `BadRequestException('Chỉ huỷ được job đang chờ hoặc đang xử lý')`.
- Delete khi status === PROCESSING → `BadRequestException('Không thể xoá job đang xử lý. Hãy huỷ trước.')`.
- Status mới: `CANCELLED`. Frontend type union phải đồng bộ.

---

## Phase 1 — Backend

### Files cần sửa
1. `backend/src/translation/translation.service.ts` — thêm `cancelVideoJob(userId, jobId)` + `deleteVideoJob(userId, jobId)`.
2. `backend/src/translation/translation.controller.ts` — thêm 2 route (`POST .../cancel`, `DELETE .../:id`).
3. `backend/src/translation/pipeline/video-pipeline.worker.ts` — thêm checkpoint CANCELLED (R1 mitigation).

### Steps cụ thể

**Service — `cancelVideoJob(userId, jobId)`** (đặt cạnh `getVideoJobs`, ~dòng 462):
1. `const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } })`.
2. `if (!job) throw new NotFoundException(...)`; `if (job.userId !== userId) throw new ForbiddenException(...)`.
3. Guard: `if (job.status !== 'PENDING' && job.status !== 'PROCESSING') throw new BadRequestException('Chỉ huỷ được job đang chờ hoặc đang xử lý')`.
4. Dùng `updateMany` có điều kiện để tránh race với worker hoàn tất:
   ```
   const result = await this.prisma.videoJob.updateMany({
     where: { id: jobId, status: { in: ['PENDING', 'PROCESSING'] } },
     data: { status: 'CANCELLED', stepDescription: 'Đã huỷ bởi người dùng.', errorMessage: null },
   });
   if (result.count === 0) throw new BadRequestException('Job đã hoàn tất hoặc đã thay đổi trạng thái, không thể huỷ');
   ```
5. Trả về job đã cập nhật (`findUnique` lại).
6. KHÔNG hoàn credits (chưa từng trừ — đã xác nhận).

**Service — `deleteVideoJob(userId, jobId)`**:
1. `findUnique` + ownership check như trên.
2. Guard: `if (job.status === 'PROCESSING') throw new BadRequestException('Không thể xoá job đang xử lý. Hãy huỷ trước.')`.
3. Cleanup storage — xoá mọi key non-null, mỗi key bọc try/catch để 1 file thiếu không chặn xoá DB (file có thể chưa từng được tạo):
   - `job.inputStorageKey`, `job.subtitlesUrl`, `job.outputVideoUrl`, `job.outputAudioUrl`.
   - Pattern: `for (const key of keys) { if (key) await this.storage.delete(key).catch(err => this.logger.warn(...)); }`.
4. `await this.prisma.videoJob.delete({ where: { id: jobId } })`.
5. Trả void → controller trả `{ success: true }`.

> **Import cần thêm vào service:** `NotFoundException`, `ForbiddenException`, `BadRequestException` từ `@nestjs/common`. Service cần inject storage: thêm `@Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider` vào constructor (hiện service KHÔNG inject storage — đây là thay đổi DI cần kiểm tra module providers). **Lựa chọn thay thế (đơn giản hơn, ưu tiên):** giữ cleanup storage Ở CONTROLLER (controller đã inject storage), service `deleteVideoJob` chỉ làm guard + DB delete và trả về danh sách key đã xoá để controller dọn. Quyết định: **dọn storage ở controller** để tránh đổi DI của service. (xem R4)

**Controller** (cạnh `getVideoJobs`, ~dòng 219):
```ts
@UseGuards(JwtAuthGuard)
@Post('video-jobs/:id/cancel')
async cancelVideoJob(@Param('id') id, @Request() req) {
  try { const job = await this.translationService.cancelVideoJob(req.user.id, id); return { success: true, job }; }
  catch (e) { /* re-throw Http exceptions, hoặc map sang {success:false,error} theo style hiện tại */ }
}

@UseGuards(JwtAuthGuard)
@Delete('video-jobs/:id')
async deleteVideoJob(@Param('id') id, @Request() req) {
  // 1. service trả keys cần xoá (sau guard+DB delete) HOẶC controller lấy job trước, gọi service delete, rồi storage.delete từng key
}
```
> Quyết định style lỗi: dùng **HTTP exceptions** (NestJS tự trả 400/403/404) — đúng convention CLAUDE.md #4 ("báo lỗi tường minh, mã HTTP chuẩn"). Frontend đọc `response.ok` + body. Khác với `translate`/`createVideoJob` (vốn nuốt lỗi thành `{success:false}` cho UX toast) — cancel/delete nên trả status code chuẩn vì là thao tác CRUD đơn giản. (xem R3 — cần thống nhất với frontend fetch handling).

**Worker checkpoint (R1 mitigation)** trong `video-pipeline.worker.ts`:
- Thêm helper `assertNotCancelled(jobId)`: `findUnique` → nếu `status === 'CANCELLED'` thì `throw new Error('JOB_CANCELLED')` (hoặc return sớm).
- Gọi tại các checkpoint giữa các bước nặng: sau extractAudio, sau STT, sau translate, trước burn-in, trước dub. Tối thiểu 2-3 checkpoint ở ranh giới bước tốn thời gian nhất.
- Trong `process()`, bọc để khi gặp CANCELLED: KHÔNG flip về FAILED, KHÔNG trừ credits, chỉ return/cleanup tmpDir (đã có `finally`).
- `onFailed`: nếu error là cancel-marker, KHÔNG ghi đè `errorMessage`/status (job đã là CANCELLED). Thêm guard: `if (job CANCELLED) return` trước khi set FAILED — dùng `updateMany where status NOT IN [CANCELLED, COMPLETED]`.

### Verification
- `cd backend && npm run build` (tsc strict pass).
- `cd backend && npm run test` (unit suite hiện có pass; thêm/không bắt buộc test mới nếu suite không cover service video — kiểm tra `translation.service.spec` tồn tại không).
- Manual: tạo job → cancel khi PENDING → DB status CANCELLED, credits không đổi. Delete COMPLETED → record mất + file outputs/<id>/* mất. Delete PROCESSING → 400.
- `git status` outputs storage thư mục sạch sau delete.

### Risk Assessment — Phase 1
| Risk | L (1-5) | I (1-5) | Score | Mitigation |
|------|---------|---------|-------|------------|
| R1: Worker vẫn xử lý xong job đã CANCELLED → trừ 10 credits oan + ghi đè status | 3 | 4 | 12 | Thêm checkpoint `assertNotCancelled` ở các bước; transaction completion đã dùng `status NOT COMPLETED` — đổi thành `NOT IN [COMPLETED, CANCELLED]` để completion không hồi sinh job đã huỷ. |
| R2: Race cancel vs completion (cancel ngay lúc worker đang commit COMPLETED) | 2 | 3 | 6 | `updateMany` có điều kiện `status IN [PENDING,PROCESSING]` → atomic; nếu count=0 báo "đã hoàn tất". |
| R3: BullMQ job vẫn trong queue sau cancel (retry/backoff) | 2 | 2 | 4 | Checkpoint trong worker đủ để no-op; KHÔNG cần xoá BullMQ job (giữ KISS). Job khi chạy sẽ thấy CANCELLED và thoát. |
| R4: Đổi DI inject storage vào service làm vỡ module wiring | 2 | 3 | 6 | Tránh hẳn: dọn storage ở controller (đã inject sẵn). Service chỉ guard + DB. |
| R5: storage.delete ném lỗi khi file không tồn tại → chặn xoá DB | 3 | 2 | 6 | Bọc từng `.delete()` trong try/catch + log warn; chỉ key non-null. |

Không có risk ≥ 15. R1 (score 12) là cao nhất — bắt buộc làm mitigation trước khi merge.

---

## Phase 2 — Frontend

### Files cần sửa
1. `frontend/src/app/types/index.ts` — thêm `"CANCELLED"` vào union `VideoJob.status`.
2. `frontend/src/app/components/VideoTranslationSection.tsx` — handler `handleCancel`/`handleDelete`, nút Cancel/Delete, badge tiếng Việt, polish.
3. `frontend/src/app/page.module.css` — class `.badgeCancelled`, nút action (`.jobActionBtn` / `.jobCancelBtn` / `.jobDeleteBtn`).

> **LƯU Ý (frontend/AGENTS.md):** "This is NOT the Next.js you know" — đọc `node_modules/next/dist/docs/` cho bất kỳ API Next.js mới trước khi viết. Thay đổi ở đây là React client component thuần (useState/fetch), KHÔNG đụng App Router API → rủi ro thấp, nhưng implementer phải xác nhận không có deprecation khi build.

### Steps cụ thể

**types/index.ts:**
- `status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED" | "CANCELLED";`

**VideoTranslationSection.tsx:**
1. Thêm `handleCancelJob(jobId)`: `POST .../video-jobs/${jobId}/cancel` với Authorization header. Nếu `res.ok` → `fetchJobs(token)` + toast success "Đã huỷ job". Nếu không → đọc body `.error` → toast error.
2. Thêm `handleDeleteJob(jobId)`: `DELETE .../video-jobs/${jobId}`. Nên có `confirm()` trước khi xoá (thao tác phá huỷ). `res.ok` → `setJobs(prev => prev.filter(j => j.id !== jobId))` (optimistic) + toast. Lỗi → toast.
3. Badge tiếng Việt — map status → label:
   - PENDING → "Đang chờ", PROCESSING → "Đang xử lý", COMPLETED → "Hoàn tất", FAILED → "Thất bại", CANCELLED → "Đã huỷ".
   - Thêm nhánh class cho CANCELLED (`styles.badgeCancelled`). Hiện ternary chỉ có 4 nhánh → đổi sang helper/map object để rõ ràng & không rơi nhầm FAILED.
4. Progress bar polish:
   - PROCESSING: bar gradient + (tuỳ chọn) hiệu ứng animated stripe; hiển thị `{progress}%`.
   - CANCELLED: bar màu xám/mờ, ẩn % hoặc hiện "Đã huỷ".
   - FAILED: bar màu đỏ (hoặc giữ progress hiện tại nhưng badge đỏ).
5. Nút action trong `.jobDetails` hoặc hàng riêng dưới progress:
   - PENDING | PROCESSING → nút **Huỷ** (`handleCancelJob`).
   - COMPLETED | FAILED | CANCELLED → nút **Xoá** (`handleDeleteJob`).
6. Label rõ ràng: "Tiến trình: {progress}%" giữ cho active; với CANCELLED/FAILED đổi thành trạng thái cuối.

**page.module.css:**
- `.badgeCancelled { background: rgba(148,163,184,0.15); color: var(--text-muted); }` (xám trung tính).
- `.jobCancelBtn` (viền warning/đỏ nhạt), `.jobDeleteBtn` (viền error), nhỏ gọn, hover state. Theo phong cách glassmorphism hiện có (border `rgba(255,255,255,...)`, border-radius ~8px).

### Verification
- `cd frontend && npm run build` (Next build + tsc pass; xác nhận không deprecation warning theo AGENTS.md).
- `cd frontend && npx eslint .` (eslint.config.mjs đã có).
- Manual E2E: tạo job → thấy badge "Đang chờ"/"Đang xử lý" → bấm Huỷ → badge "Đã huỷ", credits không đổi. Job COMPLETED → bấm Xoá (confirm) → biến mất khỏi list. Bấm Xoá job PROCESSING (nếu nút hiện sai) → backend trả 400, toast lỗi.

### Risk Assessment — Phase 2
| Risk | L (1-5) | I (1-5) | Score | Mitigation |
|------|---------|---------|-------|------------|
| R6: Contract lệch (path/method/field) giữa FE-BE | 2 | 4 | 8 | Contract cố định ở bảng trên; cả 2 phase tham chiếu. Phase 1 merge trước. |
| R7: Polling 3s ghi đè optimistic delete (job hiện lại) | 3 | 2 | 6 | Backend đã xoá record → lần poll kế không trả job đó; optimistic chỉ để mượt. Không cần lock. |
| R8: Next.js API thay đổi (theo AGENTS.md) làm build vỡ | 2 | 3 | 6 | Chỉ dùng React client thuần; đọc `node_modules/next/dist/docs/` nếu chạm API mới; verify bằng `npm run build`. |
| R9: User xoá nhầm (không hoàn tác) | 3 | 2 | 6 | `confirm()` trước delete; nút Xoá tách khỏi nút tải. |

Không có risk ≥ 15.

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 (Backend) | M | Không blocker. R1 mitigation (worker checkpoint) là phần tốn công nhất. |
| Phase 2 (Frontend) | M | Blocked by Phase 1 (cần endpoint live). |
| **Total** | **M-L** | **Critical path: Phase 1 → Phase 2** (tuần tự, vì FE phụ thuộc contract BE). |

## Backwards compatibility
- **Additive** — thêm status `CANCELLED` (cột String, không migration), 2 endpoint mới, không đổi endpoint cũ. Job cũ không ảnh hưởng. Frontend type mở rộng union (tương thích ngược).

## Rollback
- Phase 2: revert 3 file frontend → UI về như cũ, endpoint BE vẫn tồn tại nhưng không gọi → vô hại.
- Phase 1: revert 3 file backend. Job đang ở CANCELLED (nếu có) sẽ hiển thị status thô "CANCELLED" trên FE cũ (rơi vào nhánh `badgeFailed` ternary) — chấp nhận được, không crash.

## Rule check (planning constraints)
- Reuse-first: dùng `storage.delete`, guard pattern có sẵn, `@Delete('history')` pattern. ✔
- YAGNI: không xoá BullMQ job thủ công, không hoàn credits (không cần). ✔
- KISS: dọn storage ở controller thay vì đổi DI service. ✔
- DRY: badge label dùng 1 map dùng chung cho text + class. ✔
- No hardcoded: dùng env/const sẵn có; chuỗi UI tiếng Việt là copy, không phải config. ✔
