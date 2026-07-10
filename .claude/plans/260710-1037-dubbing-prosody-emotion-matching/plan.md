# Plan: Dubbing Prosody / Emotion Matching (make the dub voice stop sounding "flat")

Created: 2026-07-10
Branch: `feature-dubbing-soft-sync` (current)
Source: this-session read of the TTS + dubbing pipeline (`tts.service.ts`, `voices.config.ts`, `dubbing.service.ts`, `subtitle.service.ts`, `video-pipeline.worker.ts`, `schema.prisma`) + inspection of the installed `msedge-tts@2.0.6` type defs and README.

## Problem restated

Every dubbed segment is synthesized with plain text and a single fixed voice (`vi-VN-HoaiMyNeural`), no rate/pitch/volume variation — the voice reads an urgent line ("Nhanh lên, đi bắt hải sản!") in the same flat tone as a calm one. User feedback: the dub "feels off somewhere I can't explain" — the most likely cause is missing prosody/emotion matching. This is a **quality improvement, not an urgent bug**. Plan it incrementally: cheapest, lowest-risk win first; provider-swap and LLM analysis are later, optional phases gated on Phase 1 results.

---

## Headline research finding (de-risks the whole plan)

**The already-installed `msedge-tts@2.0.6` supports prosody out of the box — no new dependency, no provider migration needed for Phase 1.**

- `MsEdgeTTS.toStream(input, options?: ProsodyOptions)` accepts `{ rate, pitch, volume }` (see `node_modules/msedge-tts/dist/MsEdgeTTS.d.ts` + `Prosody.d.ts`). The library wraps the text in `<speak><voice><prosody rate pitch volume>…</prosody></voice></speak>` (README §"Change voice rate, pitch and volume").
- `rate`: number (`0.5`), relative % (`"+15%"`), or enum (`slow`/`fast`). `pitch`: relative Hz/semitone/% (`"+2st"`, `"+10%"`). `volume`: absolute/relative number or % .
- **Limitation (verified, must be stated):** msedge-tts only emits `speak`/`voice`/`prosody` elements — it does NOT support `<mstts:express-as>` emotional *styles* (cheerful/sad/angry). Those styles are also largely unavailable for `vi-VN` neural voices anyway. So the available lever for Vietnamese is **rate + pitch + volume**, not named emotion styles. That is enough for a first, meaningful improvement.

Consequence: the current call `tts.toStream(text)` (no options) is leaving prosody on the table. Phase 1 = derive rate/pitch/volume per segment and pass them in.

---

## The load-bearing design constraint: prosody `rate` vs soft-sync timing

`dubbing.service.ts` measures each rendered clip's `actualDuration` and, if it overruns its subtitle slot by >1.15x, applies `atempo` up to `MAX_ATEMPO_RATIO=1.15` (never pads short clips). Prosody `rate` changes clip duration, so it composes with soft-sync as follows:

| Prosody rate direction | Effect on clip duration | Interaction with soft-sync | Verdict |
|---|---|---|---|
| Faster (urgent lines, `+X%`) | Shorter clip | Less overrun → fewer atempo warps → *better* timing | **Safe — use it** |
| Slower (calm lines, `-X%`) | Longer clip | More overrun → MORE atempo compression, which speeds it back up and fights the "calm" intent | **Avoid — timing risk** |

**Decision (Phase 1): carry emotion primarily via PITCH and VOLUME (zero duration change → zero timing risk), and use `rate` only in the neutral-to-faster direction.** Never emit a negative rate that would enlarge a clip the soft-sync will then compress. This keeps the feature fully compatible with the existing anti-choppiness algorithm.

---

## Phases

- **Phase 1 — Deterministic local prosody heuristic on Edge TTS** — `tts.service.ts`, new `prosody.util.ts`, `dubbing.service.ts` (call site), cache-key change, `tts.service.spec.ts`. | Effort: **M** | The cheapest, lowest-risk win. Ships alone.
- **Phase 2 — (Optional) TTS provider seam + emotion-capable opt-in provider** — new `tts/provider/*` (`ITtsProvider`, `EdgeTtsProvider`, opt-in `MiniMax`/`Gemini` provider), `tts.module.ts`. | Effort: **L** | Gated on Phase 1 being judged insufficient after a real listen.
- **Phase 3 — (Optional) LLM-driven prosody derivation via Gemini** — `subtitle.service.ts` (annotate segments), reuse Phase-1 prosody plumbing + cache key. | Effort: **M** | Gated on Phase 1 heuristic being too coarse.

Phases 2 and 3 are independent options, both building on Phase 1's plumbing. Do NOT start them until Phase 1 is shipped and a human has listened to a dubbed sample.

---

## Feasibility

- **Reuse check:**
  - Prosody synthesis — **REUSE** installed `msedge-tts@2.0.6` `toStream(text, {rate,pitch,volume})`. No new dep.
  - Cache — **REUSE** existing `TtsCache` + `synthesizeOrServeFromCache`; only the hashed key input changes (Phase 1) — **no schema migration**.
  - Emotion derivation — **NEW** small pure util (Phase 1 heuristic); Phase 3 reuses the existing `GeminiClientService` (`src/gemini/gemini-client.service.ts`) already wired into `translation.service.ts`.
  - Provider seam (Phase 2) — **NEW**, follows `.claude/rules/library-third-party-decoupling.md` (interface + opt-in provider).
- **Complexity:** Phase 1 simple→moderate (the only subtlety is the cache key + the rate/timing rule, both resolved above). Phases 2–3 moderate.

---

## Dependencies

- **Blocks:** Phase 1 blocks Phases 2 and 3 (both consume the `ProsodyOptions` plumbing + prosody-aware cache key introduced in Phase 1).
- **Blocked by:** nothing. Phase 1 is self-contained; `msedge-tts` prosody is already installed and verified.
- **Parallel-safe:** Phases 2 and 3 are mutually independent *after* Phase 1, but should not run before a human listens to Phase 1 output (they are demand-gated, not schedule-gated).

---

## Risk Assessment (MANDATORY)

| Risk | Likelihood (1-5) | Impact (1-5) | Score | Mitigation |
|------|-----------------|--------------|-------|------------|
| `vi-VN-HoaiMyNeural` ignores/poorly-honors prosody rate/pitch/volume | 2 | 4 | 8 | Phase-1 smoke: synthesize the same line at neutral vs `pitch:+10%,rate:+12%`, A/B listen BEFORE wiring the heuristic into the pipeline. rate/pitch/volume are standard Azure neural features (unlike express-as styles) so support is expected, but verify empirically. |
| Prosody `rate` fights soft-sync atempo → timing desync / re-introduced choppiness | 3 | 5 | **15** | **HIGH — mitigate before phase starts.** Enforce the "pitch/volume for emotion; rate neutral-or-faster only" rule (above). Add a hard clamp so derived `rate` is never negative. Verify `driftSeconds` on a dubbed sample is not worse than the pre-change baseline. |
| Cache-key collision: same text synthesized with vs without prosody serves the wrong audio | 3 | 4 | 12 | Fold a compact prosody signature into the hashed cache-key input AND the storage-key filename so plain-text (`getSample`/`synthesize`) and prosody-variant (dubbing) entries never collide. Covered by a dedicated unit test. |
| Over-expressive/inconsistent heuristic makes the dub sound worse, not better | 3 | 3 | 9 | Keep Phase-1 adjustments SMALL and bounded (e.g. pitch ±10%, rate 0..+15%, volume ±10%); ship behind an env flag (`DUB_PROSODY_ENABLED`, default on) so it can be disabled without a redeploy; human A/B listen gates rollout. |
| msedge-tts 0-byte WebSocket drops become more frequent with SSML/prosody payloads | 2 | 3 | 6 | Existing `callEdgeTts` already throws on 0 bytes and `buildDubbingTrack` already wraps each call in `withRetry(retryable:()=>true)`. No new handling needed; confirm the empty-buffer guard still fires with an options payload. |
| Phase 2/3 provider integration violates project conventions (FE→3rd-party, HTTP codes, decoupling) | 2 | 3 | 6 | Phase 2/3 are gated & specced to follow `CLAUDE.md` (NestJS is the only third-party caller; explicit HTTP codes) and `library-third-party-decoupling.md` (interface + opt-in provider, graceful warn+skip when absent). |

**Highest score = 15 (rate vs soft-sync).** Its mitigation (rate clamp + pitch/volume-first) is baked into Phase 1's design and MUST be in place before the heuristic is wired into `buildDubbingTrack`.

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 — local heuristic on Edge TTS | M | Self-contained; the shippable improvement. Blocks 2 & 3. |
| Phase 2 — provider seam + opt-in emotion provider | L | Optional; blocked-by Phase 1; demand-gated on a human listen. |
| Phase 3 — Gemini-driven prosody derivation | M | Optional; blocked-by Phase 1; demand-gated on heuristic being too coarse. |
| **Total** | **M (+ optional L, M)** | **Critical path: Phase 1 only.** Ship Phase 1, listen, then decide if 2 or 3 is warranted. |

---

## Backwards compatibility

- **Additive.** Phase 1 changes the *hashed input* of the TTS cache key, so existing `TtsCache` rows for the dubbing path become cache-misses (they'll be re-synthesized once and re-cached). No migration, no data loss — old rows are simply orphaned/overwritten by key. Flag this explicitly at rollout; optionally note that old `tts/edge-*.mp3` blobs for dub segments are now unreferenced (harmless; a later cleanup job could prune, out of scope).
- The manual `synthesize`/`getSample` paths keep plain-text (no prosody) behavior — an empty prosody signature preserves their existing cache keys exactly.
- No `VideoJob`/`schema.prisma` change in Phase 1 (the feature stays a backend-only heuristic; no user-facing voice/style picker — consistent with the existing "no dubVoiceId column" product decision).

---

## Success criteria (objective)

1. A dubbed video where an exclamatory/imperative segment is synthesized with measurably different prosody params than a neutral segment (assert via unit test on `deriveProsody`).
2. `driftSeconds` on a reference dubbed clip is **≤ the pre-change baseline** (prosody must not worsen timing).
3. Cache correctness: same text with vs without prosody produces two distinct cache entries (unit test).
4. Backend `npm run build` (tsc strict) + `npm test` for `tts.service.spec.ts` pass with zero failures.
5. Human A/B listen confirms the urgent line now sounds more urgent than the neutral line (subjective gate before merge).

---

## Verification strategy per phase

- **Phase 1:** unit tests for `deriveProsody` (heuristic outputs) + cache-key distinctness; `npm run build`; a scripted A/B synth of one urgent vs one neutral Vietnamese line; `driftSeconds` non-regression check on a sample.
- **Phase 2:** interface-conformance test + "provider absent → warn+skip, Edge still works" degradation test (per decoupling rule's objective tests); no third-party import in core TTS module (grep = 0 hits).
- **Phase 3:** Gemini annotation batch returns a valid prosody label per segment; malformed/absent annotation falls back to the Phase-1 heuristic (no silent failure); latency delta measured against the translate batch it piggybacks on.

See `phase-1.md`, `phase-2.md`, `phase-3.md` for file ownership, exact edits, and per-phase test commands.
