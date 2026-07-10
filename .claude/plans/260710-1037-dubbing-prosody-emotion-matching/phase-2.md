# Phase 2 — (Optional) TTS provider seam + emotion-capable opt-in provider

**Effort:** L · **Status:** OPTIONAL, demand-gated. Do NOT start until Phase 1 is shipped and a human has judged the Edge-TTS prosody result insufficient for the emotional range wanted (e.g. wants true style/emotion, not just rate/pitch/volume).

## Why this might be needed

msedge-tts (free) exposes only `prosody` (rate/pitch/volume) — no `<mstts:express-as>` emotional styles, and `vi-VN` neural voices have limited style support regardless. If Phase 1's rate/pitch/volume range still sounds flat, a provider with real per-segment emotion/style control for Vietnamese may be warranted.

## Research summary (candidates, to finalize at phase start)

| Provider | VN emotion/style control | Cost vs free Edge | Latency | Notes |
|---|---|---|---|---|
| **MiniMax TTS** (named in `t1k-extended-multimodal` skill) | Emotion params on some voices; VN coverage must be re-verified at phase start | Paid per-char | Network round-trip | Verify current VN voice list + emotion API before committing. |
| **Google Cloud TTS** | Neural2/Studio voices; SSML prosody, limited style; VN available | Paid, free tier | Low | Closest API-shape to current SSML approach. |
| **Gemini TTS** | Emerging; check current VN + style support | Paid | Network | Same vendor as existing Gemini client — auth reuse. |
| **ElevenLabs** | Strong expressive control; VN support improving | Paid, pricier | Network | Best expressiveness, highest cost. |

**This table must be re-validated with live docs at phase start** (pricing/voice lists change) — do not implement off these notes alone.

## Architecture — MUST follow `library-third-party-decoupling.md`

The project ships `.claude/rules/library-third-party-decoupling.md` (interface + opt-in provider from day one). Apply it:

```
backend/src/tts/provider/
  tts-provider.interface.ts     ITtsProvider { synthesize(text, voiceId, prosody?): Promise<Buffer> }  — generic types only, NO vendor types
  edge-tts.provider.ts          EdgeTtsProvider implements ITtsProvider  (moves current callEdgeTts here)
  <vendor>-tts.provider.ts      opt-in; the ONLY file importing the vendor SDK; registered via Nest DI token
```

- `TtsService` depends on `ITtsProvider` (injected), not on `msedge-tts` directly.
- Provider selection via config/env (`TTS_PROVIDER=edge|<vendor>`); **absent/misconfigured vendor → warn + fall back to Edge** (graceful degrade, never throw by default — decoupling rule's sanctioned "warn+skip").
- Interface signatures use only platform/first-party types (Buffer, string, the library-owned `ProsodyOptions`) — no vendor type leaks (objective test #4 of the rule).

## Project-convention constraints (from `CLAUDE.md`)

- **NestJS backend is the only third-party caller** — the new provider lives in the backend; frontend never calls it. ✅ inherent (TTS is already backend-only).
- **Explicit HTTP error codes** — surface provider failures as proper NestJS exceptions (e.g. 429 on vendor rate-limit, 502 on vendor outage), never a silent crash.
- **TypeScript strict**, no `any` on the vendor SDK boundary — wrap untyped SDK responses at the provider edge.

## Files owned

| File | Change |
|------|--------|
| `backend/src/tts/provider/tts-provider.interface.ts` | NEW — `ITtsProvider` (vendor-free). |
| `backend/src/tts/provider/edge-tts.provider.ts` | NEW — extract current `callEdgeTts` here. |
| `backend/src/tts/provider/<vendor>-tts.provider.ts` | NEW — opt-in; only vendor import. |
| `backend/src/tts/tts.service.ts` | Depend on injected `ITtsProvider` instead of `new MsEdgeTTS()` inline. |
| `backend/src/tts/tts.module.ts` | Wire provider DI + selection token. |
| `.env.example` | Document `TTS_PROVIDER` + vendor key vars (no values — `security.md`). |

## Cache interaction

The Phase-1 prosody-aware key already distinguishes params; add the **provider id** to the cache-key input as well (so Edge vs vendor audio for the same text/prosody don't collide). Same zero-migration approach: widen the hashed input.

## Verification

```bash
cd backend
npm run build
npm test -- tts.provider.spec.ts     # interface conformance + Edge-fallback-when-vendor-absent
grep -rn "msedge-tts\|<vendor-sdk>" src/tts/tts.service.ts   # expect 0 hits — no vendor import in the orchestrator
```

Objective decoupling tests (rule §"Objective tests"): grep core for vendor import = 0; remove vendor pkg → build clean; provider absent → warn+skip, Edge still dubs; interface has no vendor types; vendor import in exactly one file.

## Rollback

`TTS_PROVIDER=edge` (default) → vendor path never exercised. Removing the vendor provider file + dep leaves core building clean (that IS the decoupling guarantee).

## Success criteria

1. Core TTS orchestrator has zero vendor imports.
2. Vendor-absent build + dub both succeed (Edge fallback).
3. Vendor path produces audibly better VN emotion on the A/B line than Phase 1 (the only reason to adopt it).
