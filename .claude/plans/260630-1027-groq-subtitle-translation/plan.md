# Plan: Chuyển dịch subtitle video sang Groq LLaMA (giữ Gemini cho text + làm fallback)

## Bối cảnh & Quyết định

Video pipeline hiện gọi `translationService.translateBatch()` (Gemini `gemini-2.0-flash`) cho bước dịch subtitle. Gemini free tier (15 RPM / 1,500 RPD) cạn quota nhanh khi xử lý nhiều video. Groq free tier (6,000 RPM / 14,400 RPD / 500K TPM) dư thừa.

Chốt:
- **Chỉ** thay Groq cho video pipeline (`subtitle.service.ts`). Text translation (`translate` endpoint) **giữ Gemini** vì đã có cache DB.
- Tạo standalone function `translateBatchViaGroq` trong file mới — consistent với pattern `stt.service.ts` (gọi `fetch` trực tiếp, không SDK).
- Model: `llama-3.3-70b-versatile`.
- Giữ `TranslationService.translateBatch` (Gemini) làm **fallback** khi `GROQ_API_KEY` không có HOẶC Groq trả JSON không hợp lệ.

## Phases

- Phase 1: Groq subtitle translator + wiring fallback — Effort: S
  - Files owned:
    - **TẠO** `backend/src/translation/pipeline/groq-translate.service.ts` — standalone `translateBatchViaGroq`
    - **SỬA** `backend/src/translation/pipeline/subtitle.service.ts` — `translateSegments` thử Groq trước, fallback Gemini
    - **(verify)** `backend/.env.example` — xác nhận `GROQ_API_KEY` đã có (đã dùng cho STT; chỉ thêm comment nếu cần)

## Feasibility

- **Reuse check:**
  - `withRetry` / `isRateLimitError` / `isQuotaExhaustedError` từ `rate-limit.util.ts` — REUSE (Groq trả 429 → regex `\b429\b` của `isRateLimitError` đã khớp).
  - Pattern `fetch` + `Bearer ${GROQ_API_KEY}` từ `stt.service.ts` — REUSE.
  - Logic parse + pad/trim JSON array từ `translateBatch` (Gemini) — REPLICATE (cùng shape output: `string[]` same-order, same-length).
  - `translationService.translateBatch` — REUSE nguyên vẹn làm fallback.
- **Complexity:** simple. 1 file mới ~70 dòng + 1 chỉnh sửa nhỏ.

## API Contract — `translateBatchViaGroq`

```ts
// backend/src/translation/pipeline/groq-translate.service.ts
export async function translateBatchViaGroq(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]>
```

**Input:**
- `texts: string[]` — các segment text gốc, đúng thứ tự.
- `sourceLang`, `targetLang` — ISO code (vd `"en"`, `"vi"`).

**Behavior:**
- `texts.length === 0` → trả `[]` ngay (không gọi API).
- `process.env.GROQ_API_KEY` rỗng → **throw** (caller bắt và fallback Gemini). KHÔNG mock — mock chỉ hợp lệ cho STT vì STT là điểm đầu pipeline.
- Gọi `POST https://api.groq.com/openai/v1/chat/completions`:
  - Headers: `Authorization: Bearer ${apiKey}`, `Content-Type: application/json`
  - Body: `{ model: "llama-3.3-70b-versatile", temperature: 0.2, response_format: { type: "json_object" }, messages: [...] }`
  - **Lưu ý JSON mode của Groq:** `response_format: json_object` BẮT BUỘC trả về object, KHÔNG phải array trần. Vì vậy prompt yêu cầu shape `{ "translations": ["...", ...] }` và parse `parsed.translations`. (Khác với Gemini hiện tại trả array trần — đây là điểm dễ sai, ghi rõ trong code.)
  - System message: "You are a subtitle translator. Return ONLY valid JSON."
  - User message: yêu cầu dịch từ `sourceLang`→`targetLang`, ≤12 từ mỗi câu, trả `{"translations": [...]}` cùng thứ tự + cùng số phần tử, input là `JSON.stringify(texts)`.
- `!response.ok` → throw `Error("Groq translate ${status}: ${body}")` (cho `withRetry` xử lý 429).

**Output (`string[]`):**
- Parse `data.choices[0].message.content` → JSON object → field `translations`.
- Validate `Array.isArray(translations) && every(v => typeof v === "string")`.
- Length khớp → trả thẳng.
- Length lệch → pad/trim: `texts.map((_, i) => translations[i] ?? texts[i])` + `logger.warn` (replicate Gemini behavior).
- Không parse được / `translations` không phải string[] → **throw** (caller fallback Gemini).

**Wrap retry:** caller bọc `withRetry(() => translateBatchViaGroq(...))` — KHÔNG bọc bên trong function (giữ function thuần, đúng pattern `transcribeAudio` bọc `withRetry` ở caller-level).

## Data flow (sau thay đổi)

`video-pipeline.worker.ts` → `translateSegments(translationService, ...)` →
  1. `texts = segments.map(s => s.text)`
  2. **try** `withRetry(() => translateBatchViaGroq(texts, src, tgt))`
  3. **catch** → `logger.warn("Groq dịch lỗi, fallback Gemini")` → `withRetry(() => translationService.translateBatch(texts, src, tgt))`
  4. map kết quả về `TranslatedSegment[]` (giữ nguyên `splitLongSegment`/`buildSrt` downstream)

Worker giữ nguyên signature `translateSegments(translationService, ...)` — `translationService` vẫn cần cho fallback. KHÔNG đổi `video-pipeline.worker.ts`.

## Backwards compatibility

- **Additive + fallback** — nếu `GROQ_API_KEY` không set, pipeline tự fallback về hành vi Gemini cũ. Không breaking.
- Output shape `string[]` không đổi → `buildSrt` / split logic không cần sửa.
- Text translation endpoint không chạm tới.

## Risk Assessment

| Risk | Likelihood (1-5) | Impact (1-5) | Score | Mitigation |
|------|-----------------|--------------|-------|------------|
| Groq JSON mode trả object thay vì array → parse sai nếu copy nguyên prompt Gemini | 4 | 3 | 12 | Prompt yêu cầu `{"translations":[...]}`, parse `.translations`; ghi comment cảnh báo trong code |
| LLaMA dịch kém hơn Gemini cho ngôn ngữ ít tài nguyên (vi/zh/ja) | 2 | 3 | 6 | `temperature: 0.2`; giữ Gemini fallback; có thể đánh giá thủ công 1 video mẫu trước khi merge |
| Groq trả số phần tử lệch (gộp/tách câu) | 3 | 2 | 6 | Pad/trim như Gemini hiện tại; warn log |
| Vượt 500K TPM với video dài (nhiều segment trong 1 call) | 2 | 2 | 4 | 1 call/video; nếu cần sau này chunk theo token — YAGNI hiện tại |
| Fallback che giấu lỗi Groq thật (cạn quota Groq vẫn fallback im lặng) | 2 | 2 | 4 | `logger.warn` rõ ràng mỗi lần fallback; không silent |

Không có risk ≥ 15 → không cần mitigation chặn phase.

## Testing — pass/fail commands

- **Build/typecheck:** `cd backend && npx tsc --noEmit` → 0 lỗi.
- **Lint:** `cd backend && npm run lint` (nếu có) → 0 lỗi mới.
- **Manual smoke (gate trước merge):** chạy 1 video ngắn (en→vi) với `GROQ_API_KEY` set → kiểm tra SRT output có bản dịch tiếng Việt hợp lý; xem log xác nhận dùng Groq (không fallback).
- **Fallback test:** tạm bỏ `GROQ_API_KEY` → chạy lại → log phải hiện fallback Gemini và vẫn ra SRT.
- Unit test: pattern project (theo `tts.service.spec.ts`) không bắt buộc cho standalone fetch function; nếu thêm thì mock `global.fetch` test parse `.translations` + pad/trim + throw-on-invalid.

## Rollback

- Revert 2 file (xóa `groq-translate.service.ts`, hoàn `subtitle.service.ts`) → quay về 100% Gemini. Không có migration DB, không có schema change.

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1: Groq translator + fallback wiring | S | Không blocker; `GROQ_API_KEY` env đã tồn tại |
| Total | S | Critical path: Phase 1 (đơn lẻ) |
