# Plan: tooldichj — TTS Voice, Real Video Pipeline, Billing & Hardening

**Status:** READY (all decisions CONFIRMED by user — see decisions table)
**Created:** 2026-06-22 10:35
**Branch base:** feature-verifyemail → recommend new branch `feature-tts-video-billing`
**Scope:** Take tooldichj from current state (working auth + mock video pipeline + text translation, no TTS, no billing) to a complete product.

## Overview

The project today has solid auth (register/login/email-OTP/MFA/JWT) and a working text-translation path (Gemini + DB cache + credit deduction). Three large gaps remain:

1. The video pipeline is **simulated** (`queue.service.ts` cron increments a fake progress counter; video bytes are never uploaded; no real audio/STT/subtitle/burn-in/dubbing happens).
2. There is **no TTS / voice feature** at all — the user's headline ask (voice selection first-class in BOTH text and video flows).
3. There is **no billing / credits top-up** (credits decrement but can never be replenished).

Plus hardening gaps mandated by `CLAUDE.md`: rate limiting, caching, tests (zero coverage today), forgot/reset-password, and cleanup of a stray sqlite `dev.db`.

## Phases

- **Phase 0: Config & Setup Fix** — GEMINI_API_KEY config + `/health` check (now also probes Redis), stray dev.db flag, dependency install batch (incl. `bullmq`/`ioredis`) | Effort: S
- **Phase 1: Video Upload Plumbing** — multer upload, `IStorageProvider` (local disk), download/stream endpoints, frontend wires real bytes | Effort: M
- **Phase 2: Real Video Pipeline** — ffmpeg audio extract → Gemini STT → translate (reuse) → hardsub burn-in, BullMQ producer/worker + Redis replacing cron sim | Effort: L
- **Phase 3: TTS Voice Feature** — voice-catalog endpoint, Gemini TTS audio gen + DB cache-by-hash, "listen" control + voice picker in text tab | Effort: M
- **Phase 4: Video Dubbing Integration** — TTS voice-over track + ffmpeg mux into output video, voice picker in video tab, wires the dead output-format select | Effort: L
- **Phase 5: Billing / Credits Top-up** — static VietQR bank-transfer QR (own account, no gateway), `CreditTopupRequest` model, manual admin confirm/reject flow | Effort: M
- **Phase 6: Hardening** — @nestjs/throttler rate limiting, caching, forgot/reset-password, test coverage (auth + translation + TTS + video + billing) | Effort: M

## Feasibility

- **Reuse check:** Gemini SDK (`@google/genai` ^2.8.0) already present — reused for translate AND TTS AND STT. DB cache-by-SHA256 pattern (`TranslationCache`) reused for TTS audio cache. Credit-deduction helper reused for TTS/video/billing. `@prisma/adapter-pg` present. Auth/JWT guard + OTP-token pattern reused for all new endpoints + reset-password. The existing-but-unused `User.role` field is reused as-is for the admin guard (no new field needed).
- **NEW:** ffmpeg integration (`fluent-ffmpeg`), multer upload, storage layer, BullMQ + Redis (queue infra, replaces `@nestjs/schedule` cron-pump design for video jobs), VietQR static-image URL templating (no SDK), `@nestjs/throttler`, reset-password template, all tests.
- **Complexity:** complex (real media pipeline + new queue infra are the two hardest areas; billing is now simple — a static QR image + manual admin click, no gateway integration).

## Dependencies (critical path)

```
Phase 0 (setup)
   ├─> Phase 1 (upload) ──> Phase 2 (pipeline) ──┐
   └─> Phase 3 (TTS) ─────────────────────────────┴─> Phase 4 (dubbing)
Phase 5 (billing)  — depends only on Phase 0 (parallelizable with 1–4)
Phase 6 (hardening) — last; touches throttler/tests across all prior phases
```

- **Blocks:** Phase 1 blocks 2; Phase 2 AND Phase 3 block Phase 4; Phase 0 blocks everything.
- **Parallel-safe:** Phase 3 (TTS) runs parallel to Phase 1/2; Phase 5 (billing) runs parallel to the whole media track.
- **Critical path:** 0 → 1 → 2 → 4 → 6.

## Decisions resolved by user (do not re-ask)

1. TTS engine = Gemini TTS (reuse existing key/SDK).
2. Build a REAL video pipeline (not mock).
3. Add credits top-up / billing.
4. Voice selection first-class in BOTH text and video flows (user-facing option, never a hardcoded default).

## Decisions — ALL CONFIRMED (no remaining sign-off needed)

All four decisions below were defaulted during planning and have since been **explicitly confirmed or overridden by the user**. Nothing in this section is pending — `/t1k:cook` may proceed without further confirmation.

| ID | Decision | Status | Confirmed approach | Rationale | Phase |
|----|----------|--------|---------------------|-----------|-------|
| DEC-A | Payment / top-up | **REJECTED default, REPLACED** | Static **VietQR.io bank-transfer QR** image (user's own personal bank account — `BANK_BIN`/`ACCOUNT_NO`/`TEMPLATE` from env), no gateway/merchant account, no SDK, no webhook/IPN. Manual admin approval: user submits a `CreditTopupRequest` (amount → QR + unique `orderCode`), it sits PENDING until an admin (the user themself, via `role === 'ADMIN'`) manually confirms or rejects on an admin-only page. Credit grant happens only on manual confirm, idempotently. | User explicitly rejected VNPay/Momo/Stripe; wants zero gateway integration and full manual control over reconciliation | 5 |
| DEC-B | Media storage | **CONFIRMED** | **Local disk** behind `IStorageProvider` (S3 impl opt-in) | Simplest MVP; decoupled per kit rule, S3 later with no rewrite | 1 |
| DEC-C | STT approach | **CONFIRMED** | **Gemini multimodal direct** (audio → transcript + translation) | Reuses existing key/SDK, zero new dep | 2 |
| DEC-D | Job execution | **REJECTED default, REPLACED** | **BullMQ + Redis.** Redis added as a `docker-compose.yml` service (internal network only); `bullmq` + `ioredis` added to `backend/package.json`; `queue.service.ts` becomes a BullMQ producer (enqueue on `POST /translation/video-job`); a new BullMQ worker module consumes the queue and runs extract→STT→translate→burn-in, using BullMQ's built-in retry/backoff instead of the manual progress-percentage simulation | User explicitly rejected in-process/cron-only; wants a real queue with Redis-backed retry/backoff | 2 |

## Risk Assessment (consolidated — per-phase tables in phase files)

| Risk | Likelihood (1-5) | Impact (1-5) | Score | Mitigation |
|------|-----------------|--------------|-------|------------|
| Gemini TTS model/API shape differs from assumed (preview model) | 4 | 4 | **16** | SPIKE FIRST in Phase 3: verify model id + audio format before building UI |
| ffmpeg not installed in runtime/CI/Jenkins env | 4 | 4 | **16** | Phase 0 `/health` surfaces it; CLAUDE.md + Jenkinsfile install step; Phase 2 gated on it |
| Redis not running in dev/CI/Jenkins env (new BullMQ dependency) | 4 | 4 | **16** | Extend Phase 0's `/health` check to also probe Redis connectivity (same pattern as the ffmpeg check); `docker-compose.yml` ships a `redis` service; Jenkinsfile ensures it's up; Phase 2 gated on it |
| Admin forgets to confirm / user disputes a transfer that wasn't matched to a `CreditTopupRequest` | 3 | 4 | 12 | `orderCode` required in the transfer description (pre-filled via the QR's `addInfo` param); pending requests surfaced prominently in the admin UI; optional auto-expire/auto-cancel of stale PENDING requests after N days |
| Long video processing blocks event loop / worker overlap | 3 | 4 | 12 | child_process ffmpeg; BullMQ worker concurrency setting (no manual guard flag needed) |
| Voice-over drift over long video | 4 | 3 | 12 | Per-segment slot alignment + bounded atempo; drift warning |
| STT timestamp/segment shape unreliable | 3 | 4 | 12 | Spike STT response shape; fallback whole-audio transcript + heuristic timing |

**Risk score >= 15 = high risk** — three items: the Phase 3 TTS spike, ffmpeg availability (Phase 0 health-check), and Redis availability (Phase 0 health-check, Phase 2 BullMQ dependency) each have mandated mitigation that must land before their phase's feature code.

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 0 | S | blocks everything (deps incl. `bullmq`/`ioredis` + key + health, now also probing Redis) |
| Phase 1 | M | blocked by 0 |
| Phase 2 | L | blocked by 1; ffmpeg + STT + **new Redis/BullMQ infra setup** risk (explicit sub-task: docker-compose `redis` service, `bullmq`/`ioredis` deps, producer/worker split) — kept at L; infra work is mechanical, not research-heavy |
| Phase 3 | M | blocked by 0; parallel to 1/2; **TTS spike first** |
| Phase 4 | L | blocked by 2 AND 3 |
| Phase 5 | M | blocked by 0; parallel to media track; no gateway integration risk (static QR image + manual admin confirm) — effort reduced from L to M vs. the original VNPay design |
| Phase 6 | M | last; cross-cutting (throttler + tests + reset-password) |
| Total | ~XL | Critical path: 0 → 1 → 2 → 4 → 6 |

## Behavioral checklist (verified)

- Data flows traced: upload→storage→pipeline→outputs→download (Phase 1/2); text→TTS→cache→audio (Phase 3); segments→TTS→mux (Phase 4); topup-request→QR→manual-admin-confirm→credits (Phase 5).
- Dependency graph + critical path explicit above.
- Every risk ≥15 has a mitigation gating its phase.
- Backwards-compat: all phases additive; migrations have down paths; default `outputMode` preserves Phase 2 behavior.
- Every phase has a verification command/criteria.
- Rollback documented per phase (single-file reverts + down-migrations).
- File ownership: no two phases own the same file at the same step (queue.service.ts is owned by Phase 2 then extended in Phase 4 — sequenced, not concurrent).
- Cleanup (dev.db, fake VideoJob URL fields) flagged for user confirmation, not silent deletion.

## Handoff

`/t1k:cook plans/260622-1035-tts-video-pipeline-billing/plan.md`
