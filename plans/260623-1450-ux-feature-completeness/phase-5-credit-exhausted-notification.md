# Phase 5: Credit-Exhausted Notification + Billing Link

**Effort:** S
**Depends on:** none strictly, but sequenced after Phases 2-4 to avoid re-touching `TextTranslationSection.tsx` mid-stream (file-ownership convenience, not a hard blocker)
**Blocks:** none

## Goal

Today, insufficient-credit errors are generic strings (`"Tài khoản đã hết Credits..."` from `translation.service.ts` line ~53, similarly in `tts.service.ts` line ~60, and `"...cần có ít nhất 10 credits..."` in `translation.service.ts::createVideoJob` line ~156) shown as plain error text/toast with no path to the Billing section. Add a distinguishable error code and a clickable "Nạp thêm →" action in the toast that scrolls to `BillingSection`.

## Files owned by this phase

- `backend/src/credit/insufficient-credits.error.ts` — **new** shared error class
- `backend/src/translation/translation.service.ts` — throw the new class instead of plain `Error` (2 call sites: `translate()`, `createVideoJob()`)
- `backend/src/tts/tts.service.ts` — throw the new class instead of plain `Error` (1 call site: `synthesize()`)
- `backend/src/translation/translation.controller.ts` — catch `InsufficientCreditsError`, add `code: 'INSUFFICIENT_CREDITS'` to the JSON response
- `backend/src/tts/tts.controller.ts` — same catch/code addition
- `frontend/src/app/components/Toast.tsx` — optional `actionLabel` + `onAction` props, renders a small button
- `frontend/src/app/hooks/useAuth.ts` — `showToast` signature gains an optional 3rd arg
- `frontend/src/app/components/BillingSection.tsx` — wrap the root `<div>` with `id="billing-section"`
- `frontend/src/app/components/TextTranslationSection.tsx` — on `data.code === 'INSUFFICIENT_CREDITS'`, call `showToast` with the scroll-to-billing action
- `frontend/src/app/components/VideoTranslationSection.tsx` — same as above

## Implementation notes

### Backend — shared error class

```ts
// backend/src/credit/insufficient-credits.error.ts
export class InsufficientCreditsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsufficientCreditsError';
  }
}
```

Replace the 3 `throw new Error('Tài khoản đã hết Credits...')` / `'...cần có ít nhất 10 credits...'` call sites with `throw new InsufficientCreditsError(...)` — same message strings, just a different class (zero user-facing text change).

### Backend — controller response shape

`translation.controller.ts::translate()`'s existing catch block:
```ts
} catch (error: unknown) {
  const errorMessage = error instanceof Error ? error.message : 'An error occurred during translation';
  return {
    success: false,
    error: errorMessage,
    code: error instanceof InsufficientCreditsError ? 'INSUFFICIENT_CREDITS' : undefined,
  };
}
```
Same pattern for `createVideoJob()`'s catch block and `tts.controller.ts`'s `synthesize` catch block.

### Frontend — Toast action support

```tsx
// Toast.tsx
interface ToastProps {
  type: "success" | "error" | null;
  message: string;
  actionLabel?: string;
  onAction?: () => void;
}

export default function Toast({ type, message, actionLabel, onAction }: ToastProps) {
  if (!type) return null;
  return (
    <div className={`${styles.toast} ${type === "error" ? styles.toastError : ""}`}>
      <span>{type === "success" ? "✅" : "⚠️"}</span>
      <span>{message}</span>
      {actionLabel && onAction && (
        <button onClick={onAction} className={styles.toastAction}>{actionLabel}</button>
      )}
    </div>
  );
}
```
Add a `.toastAction` class to `page.module.css` (small button, inherits toast's color scheme — match the existing `.authSwitchLink` minimal-button style already used elsewhere for visual consistency).

`useAuth.ts::showToast` — extend to carry an optional action through to the `toast` state object:
```ts
const [toast, setToast] = useState<{ type: "success" | "error" | null; message: string; actionLabel?: string; onAction?: () => void }>({ type: null, message: "" });

const showToast = useCallback((type: "success" | "error", message: string, action?: { label: string; onClick: () => void }) => {
  setToast({ type, message, actionLabel: action?.label, onAction: action?.onClick });
  setTimeout(() => setToast({ type: null, message: "" }), 4000);
}, []);
```
`page.tsx`'s `<Toast type={toast.type} message={toast.message} />` becomes `<Toast type={toast.type} message={toast.message} actionLabel={toast.actionLabel} onAction={toast.onAction} />`.

### Frontend — scroll-to-billing action

Shared helper (inline in each section, or a tiny exported function in `types/index.ts` or a new `utils.ts` — given it's a 1-liner used in 2 places, inline is fine, no new file needed):
```ts
const scrollToBilling = () => document.getElementById("billing-section")?.scrollIntoView({ behavior: "smooth" });
```
In `TextTranslationSection.tsx::handleTranslate`'s `else` branch (where `data.success === false`):
```ts
} else {
  setOutputText(`[Lỗi]: ${data.error || "Không thể dịch thuật"}`);
  if (data.code === "INSUFFICIENT_CREDITS") {
    showToast("error", data.error, { label: "Nạp thêm →", onClick: scrollToBilling });
  }
}
```
Same pattern added to `VideoTranslationSection.tsx::handleVideoSubmit`'s existing `showToast("error", data.error || ...)` call — check `data.code` first.

## Risk Assessment

| Risk | Likelihood | Impact | Score | Mitigation |
|------|-----------|--------|-------|------------|
| `BillingSection` is not mounted/visible when scroll is triggered (e.g. user is deep in a different tab state) | 1 | 2 | 2 | `BillingSection` renders unconditionally below the text/video tabs in `page.tsx` (confirmed in current code) — always present in the DOM once logged in, so `scrollIntoView` always finds it |
| Toast auto-dismisses (4s timeout) before user clicks the action button | 2 | 2 | 4 | Acceptable — same 4s window as every other toast in the app today; not a regression, just inherits existing UX. If this proves too short in practice, bump the timeout specifically for action-toasts in a follow-up, not in this phase |
| Missing one of the 3 credit-check call sites when swapping `Error` → `InsufficientCreditsError` | 2 | 2 | 4 | Explicit checklist above names all 3 (translate, createVideoJob, TTS synthesize) — verify via `grep -rn "InsufficientCreditsError" backend/src` shows exactly 3 `throw` sites + 2 controller `catch`/`instanceof` sites after the phase |

## Timeline

| Step | Effort |
|------|--------|
| Backend: error class + 3 throw-site swaps + 2 controller catch updates | S |
| Frontend: `Toast` action prop + `useAuth.ts` signature change | S |
| Frontend: wire the 2 section components' error branches | S |
| **Total** | **S** |

## Verification

1. `grep -rn "InsufficientCreditsError" backend/src` — exactly 3 throw sites (`translation.service.ts` ×2, `tts.service.ts` ×1) + 2 controller references.
2. Manual: set a test user's credits to 0 (via Prisma Studio or admin), attempt a text translation → toast shows the error message AND a "Nạp thêm →" button; clicking it smooth-scrolls to the Billing card.
3. Manual: same with 0 credits attempting a video job (needs ≥10 credits) — same toast+action behavior.
4. Regression: a NON-credit error (e.g. malformed request) still shows a plain toast with no action button (confirms `code` is `undefined` for non-`InsufficientCreditsError` failures).

## Rollback

Revert all listed files to pre-phase state. No schema/migration involved.
