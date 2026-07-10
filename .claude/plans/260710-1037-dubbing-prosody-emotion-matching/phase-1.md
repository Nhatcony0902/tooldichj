# Phase 1 — Deterministic local prosody heuristic on Edge TTS

**Effort:** M · **Risk:** the rate-vs-soft-sync interaction (score 15) is mitigated here · **Ships alone** as the primary improvement.

## Goal

Derive a small, bounded `{rate, pitch, volume}` per dubbing segment from cheap local signals (punctuation, imperative cues, length, caps) and pass it to `msedge-tts`, so urgent/exclamatory lines read differently from neutral ones — WITHOUT breaking soft-sync timing or the TTS cache.

## Files owned by this phase

| File | Change |
|------|--------|
| `backend/src/tts/prosody.util.ts` | **NEW** — pure `deriveProsody(text): ProsodyOptions \| undefined` + a `prosodySignature(opts): string` helper for the cache key. No I/O, fully unit-testable. |
| `backend/src/tts/tts.service.ts` | Thread an optional `prosody?: ProsodyOptions` param through `synthesize` → `synthesizeOrServeFromCache` → `callEdgeTts`; pass it to `tts.toStream(text, prosody)`; fold `prosodySignature` into the hashed cache-key input + storage-key filename. |
| `backend/src/translation/pipeline/dubbing.service.ts` | At the per-segment call site, compute `deriveProsody(segment.translatedText)` and pass it into `ttsService.synthesize(...)`. |
| `backend/src/tts/tts.service.spec.ts` | Add cases: prosody-aware cache-key distinctness; plain-text path unchanged. |
| `backend/src/tts/prosody.util.spec.ts` | **NEW** — heuristic unit tests. |

**No** `schema.prisma` change. **No** frontend change. **No** new dependency.

## Design detail

### 1. The heuristic (`deriveProsody`)

Keep it small and bounded (KISS). Signals → adjustments, all clamped:

- **Urgency / imperative** (ends with `!`, or contains a leading imperative Vietnamese cue such as `Nhanh`, `Mau`, `Đi`, `Dừng`, `Cẩn thận`, or ALL-CAPS run): `rate: "+12%"`, `pitch: "+8%"`, slight `volume: "+8%"`.
- **Question** (ends with `?`): mild `pitch: "+6%"`, `rate: "+0%"`.
- **Calm / trailing-off** (ends with `…` or `.` and long, low-signal): `pitch: "-6%"` ONLY (no negative rate — see timing rule).
- **Neutral** (default): return `undefined` → plain synthesis, identical to today (and preserves existing cache entries for those texts).

**Hard clamps (enforce in code):**
- `rate` ∈ `[0, +15%]` — **never negative** (negative rate lengthens the clip → soft-sync would compress it back; see plan §"load-bearing constraint"). Add an assertion/clamp so a future edit can't reintroduce a negative rate.
- `pitch` ∈ `[-10%, +10%]`, `volume` ∈ `[-10%, +10%]`.

All thresholds/cue-lists are named constants at the top of `prosody.util.ts` (no magic literals — `code-conventions.md`).

### 2. Cache-key change (prevents wrong-audio collision)

Current key: `hashText(text)` + `voiceId`; storage `tts/edge-${textHash}-${voiceId}.mp3`; unique `(textHash, voiceId)`.

Change: hash `text + "" + prosodySignature(prosody)` where `prosodySignature(undefined) === ""`. So:
- Plain-text path (`getSample`, manual `synthesize` with no prosody) → signature `""` → **identical hash to today** → existing cache rows still hit. ✅ backwards compatible.
- Dubbing path with prosody → distinct hash → its own cache entry; no collision with the plain-text entry for the same words.
- Deterministic heuristic means the same `translatedText` always derives the same prosody → same key → cache still works across re-runs.

Also append the signature to the storage-key filename for traceability: `tts/edge-${textHash}-${voiceId}.mp3` (textHash already encodes prosody, so the filename stays unique — no extra field needed). **No schema migration** because the composite `(textHash, voiceId)` still holds; only the *value* fed into `hashText` widened.

### 3. Feature flag

Gate the whole heuristic behind `process.env.DUB_PROSODY_ENABLED !== 'false'` (default ON) so it can be disabled without a redeploy if the A/B listen is unfavorable. Read via the existing config pattern; document in `.env.example`.

## Composition with soft-sync (must verify)

`dubbing.service.ts` measures the rendered clip and only compresses overruns. Because Phase-1 rate is neutral-or-faster, prosody either shrinks a clip slightly (leaves a tiny natural gap — fine) or leaves duration unchanged (pitch/volume only). Verify on a sample that `driftSeconds` is **≤ baseline**.

## Verification (pass/fail commands)

```bash
cd backend
npm run build                       # tsc strict — zero errors
npm test -- prosody.util.spec.ts    # heuristic outputs + clamps (rate never < 0)
npm test -- tts.service.spec.ts     # cache-key distinctness; plain path unchanged
```

Manual (subjective gate before merge):
- Script a one-off synth of `"Nhanh lên, đi bắt hải sản!"` vs `"Hôm nay trời khá đẹp."` through the dubbing prosody path; A/B listen — the first must sound more urgent.
- Run one real dubbing job; confirm the logged `driftSeconds` is not worse than a pre-change run of the same input.

## Rollback

Set `DUB_PROSODY_ENABLED=false` (instant, no deploy) — `deriveProsody` short-circuits to `undefined`, restoring today's exact plain-text behavior and cache keys. Full revert = drop `prosody.util.ts` + the optional param (no schema state to unwind).

## Success criteria

1. `deriveProsody` returns distinct params for urgent vs neutral (unit test).
2. `rate` is provably never negative (clamp unit test).
3. Same text with/without prosody → two cache entries (unit test).
4. `driftSeconds` ≤ baseline on a reference job.
5. Build + tests green; human A/B listen positive.
