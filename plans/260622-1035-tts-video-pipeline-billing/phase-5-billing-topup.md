# Phase 5 — Billing / Credits Top-up (VietQR + Manual Admin Confirm)

**Effort:** M | **Blocked by:** Phase 0 | **Blocks:** none | **Parallel-safe with media track (1–4)**

## Goal

Let users buy credits. Today `credits` only decrements and can never be replenished. Add a **VietQR static bank-transfer QR top-up flow** with **manual admin approval** — no payment gateway, no merchant account, no SDK, no webhook/IPN.

## Decision (CONFIRMED — DEC-A)

User rejected VNPay/Momo/Stripe entirely. No `IPaymentProvider`, no gateway account, no automated bank-statement reconciliation (no SePay/Casso/third-party API). Flow is:

1. User picks/enters a top-up amount → backend generates a unique `orderCode` and returns a **VietQR.io static image URL** built from the user's own personal bank account (`BANK_BIN`, `ACCOUNT_NO` from env) with `amount` and `addInfo` (the orderCode) baked into the URL query string:
   `https://img.vietqr.io/image/{BANK_BIN}-{ACCOUNT_NO}-{TEMPLATE}.png?amount={amount}&addInfo={orderCode}`
2. A `CreditTopupRequest` row is created with `status=PENDING`.
3. User manually transfers the money via their banking app, scanning the QR (which pre-fills amount + transfer description = orderCode).
4. User (acting as admin) opens an **admin-only page** listing PENDING requests, matches the request against their own bank app/SMS notification (by orderCode + amount), and clicks **Confirm Received** — this is the only path that credits the account. Reject is also available.
5. No webhook, no polling a bank API, no IPN. Matching is manual, by the orderCode embedded in the transfer description.

## Scope & file ownership

- `backend/src/billing/vietqr.util.ts` (NEW) — pure function building the VietQR.io image URL from `BANK_BIN`, `ACCOUNT_NO`, `BANK_TEMPLATE` (env-configured, no hardcoded bank info) + `amount` + `orderCode`. No SDK, just URL templating.
- `backend/src/billing/order-code.util.ts` (NEW) — generates a short, unique, human-typeable order code (e.g. `TD` + timestamp/random base36) safe to appear in a bank transfer description (no spaces/special chars banks might strip).
- `backend/src/billing/billing.service.ts` (NEW) —
  - `createTopupRequest(userId, amount)` → computes `credits` from `amount` (rate from `packages.config.ts` or a simple VND-per-credit constant), generates `orderCode`, inserts `CreditTopupRequest{status:PENDING}`, returns `{ orderCode, qrUrl, amount, credits }`.
  - `listPending()` — admin-only, returns PENDING requests ordered oldest-first.
  - `confirmRequest(requestId, adminUserId)` — **idempotent**: inside a transaction, re-fetch the request; if `status !== 'PENDING'` → throw/return a clear 409 "already processed" (no double-credit); else set `status=CONFIRMED`, `confirmedAt=now()`, `confirmedBy=adminUserId`, and `user.credits += credits` atomically.
  - `rejectRequest(requestId, adminUserId)` — same idempotent guard, sets `status=REJECTED` (no credit change).
- `backend/src/billing/billing.controller.ts` (NEW) —
  - `POST /billing/topup` `{ amount }` (auth required) → `{ orderCode, qrUrl, amount, credits, requestId }`.
  - `GET /billing/my-requests` (auth required) → caller's own topup request history + status.
  - `GET /billing/admin/pending` (auth + `role === 'ADMIN'` guard) → list PENDING requests (with requester email/name for matching against bank statement).
  - `POST /billing/admin/:id/confirm` (auth + ADMIN guard) → confirm, credit user.
  - `POST /billing/admin/:id/reject` (auth + ADMIN guard) → reject.
- `backend/src/billing/admin.guard.ts` (NEW) — small `CanActivate` checking `req.user.role === 'ADMIN'` (reuses the existing JWT auth guard's attached user; the `role` field already exists on `User` — currently unused — this is its first consumer).
- `backend/src/billing/packages.config.ts` (NEW) — VND-per-credit rate (or fixed package tiers) as a named config constant, not hardcoded inline in the service.
- `backend/.env.example` — add `VIETQR_BANK_BIN`, `VIETQR_ACCOUNT_NO`, `VIETQR_ACCOUNT_NAME`, `VIETQR_TEMPLATE` (placeholders only, per `rules/security.md`).
- `backend/prisma/schema.prisma` — new model:
  ```prisma
  model CreditTopupRequest {
    id          String   @id @default(uuid())
    userId      String
    amount      Int      // VND
    credits     Int      // credits granted on confirm
    orderCode   String   @unique
    status      String   @default("PENDING") // PENDING, CONFIRMED, REJECTED
    createdAt   DateTime @default(now())
    confirmedAt DateTime?
    confirmedBy String?  // admin userId who actioned it
    user        User     @relation(fields: [userId], references: [id], onDelete: Cascade)
  }
  ```
  Add `topupRequests CreditTopupRequest[]` back-relation on `User`. Migration.
- `frontend/src/app/page.tsx` (or a new admin route, e.g. `frontend/src/app/admin/page.tsx`) —
  - User-facing "Nạp Credits" section: amount input → shows the VietQR image (`<img src={qrUrl}>`) + orderCode + plain-language instruction ("transfer with this exact content, then wait for admin confirmation") + the request's current status (poll `GET /billing/my-requests`).
  - Admin-only page (gate client-side on `user.role === 'ADMIN'`, but the real enforcement is server-side): list of PENDING requests with Confirm/Reject buttons.

## Idempotency (the critical correctness property)

- Credit grant happens ONLY inside `confirmRequest`, inside a DB transaction that:
  1. re-fetches the `CreditTopupRequest` row by id,
  2. if `status !== 'PENDING'` → no-op / 409 (handles double-click, double-submit, or two admin tabs open),
  3. else sets `status=CONFIRMED` + `user.credits += credits` atomically in the same transaction.
- `orderCode @unique` prevents two requests from colliding on the same transfer-matching string.

## Verification

- Create a topup request → QR image URL resolves and encodes the right amount + orderCode.
- Admin confirms a PENDING request → user credits increase by exactly the computed amount, request becomes CONFIRMED.
- Confirm the same request a second time (double-click / replay) → second call is a no-op / 409, credits do NOT increase again (idempotency proven by test).
- Non-admin user hitting `/billing/admin/*` → 403.
- Reject a PENDING request → status REJECTED, no credit change, cannot later be confirmed.

## Risk Assessment

| Risk | L | I | Score | Mitigation |
|------|---|---|-------|------------|
| Admin forgets to confirm / user disputes a transfer that wasn't matched | 3 | 4 | 12 | orderCode required in transfer description (pre-filled by the QR's `addInfo`); pending requests surfaced prominently in the admin UI (count badge); optional auto-expire/auto-cancel a PENDING request after N days (configurable) so stale requests don't linger silently — user is told to contact support/re-submit if expired |
| Double-confirm via double-click or concurrent admin tabs | 2 | 5 | 10 | `confirmRequest`/`rejectRequest` re-check status inside the transaction; non-PENDING short-circuits with no credit change |
| User transfers without the orderCode in the description (manual override in banking app) | 3 | 3 | 9 | UI instructs user not to edit the pre-filled description; admin can still manually match by amount + timestamp + requester name shown alongside each pending row |
| Wrong amount→credits rate hardcoded inline | 1 | 2 | 2 | rate lives in `packages.config.ts`, not inline in the service |

## Rollback

Self-contained new module + one migration. Revert phase commit + down-migration drops `CreditTopupRequest`. No impact on existing credit-decrement paths.
