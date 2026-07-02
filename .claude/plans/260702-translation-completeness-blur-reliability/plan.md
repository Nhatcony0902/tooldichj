# Plan: Translation Completeness + Blur Reliability (retry-before-fallback, no silent skips)

Created: 2026-07-02
Branch: `feature-dub-removal-subtitle-detect` (current)
Source: this-session root-cause read of the two-phase pipeline (`subtitle.service.ts`, `groq-translate.service.ts`, `translation.service.ts`, `subtitle-region.service.ts`, `rate-limit.util.ts`, `video-pipeline.worker.ts`)

Separate concern from `260702-fix-video-pipeline-bugs` (that plan = money-safety / controller / HTTP-code bugs — do not merge). This plan fixes TWO silent-fallback reliability bugs where a job reports `COMPLETED` while having quietly degraded: (B1) some subtitle segments left in the SOURCE language when the translate API returns short/empty results, and (B2) the original burned-in subtitle blur silently skipped on a transient rate-limit even though `removeSourceSubs` was requested and charged. Both violate `development-principles.md` § "Errors Over Silent Fallbacks"; the fix must NOT introduce a new silent fallback.

---

## Bugs In Scope

| ID | Severity | Summary |
|----|----------|---------|
| B1 | Important | Translate path pads short/empty API results with the ORIGINAL source text and reports success — segments silently untranslated, no retry, no signal to job/UI |
| B2 | Important | Blur-region detection skips (no retry) on transient 429; all 3 samples fail → blur silently no-ops even though `removeSourceSubs` was requested & charged; identical log to the legit "no subtitle" case |

---

## Design Decisions (resolved by planner judgment)

`AskUserQuestion` is unavailable inside a planning subagent, so the three genuinely-ambiguous decisions the brief flagged are resolved here with rationale (no TBD left in the plan):

| Decision | Chosen | Rationale |
|----------|--------|-----------|
| Frontend surfacing scope | **In-scope, Phase 4** | The whole point is to stop the degradation being *silent*. A DB field the user never sees is only marginally better than the current warn-log. `getVideoJobs` already returns every column, so the incremental cost is one small banner. Kept minimal (read-only badge/line, no new endpoint). |
| New `VideoJob` field shape | **Two typed columns**: `untranslatedSegmentCount Int @default(0)` + `blurStatus String?` | Matches the existing flat-column style (`removeSourceSubs Boolean`, `errorMessage String?`); queryable without JSON parse/validate; each column is a single fact. Not a derived-field/SSOT violation — see note below. |
| Retry aggressiveness | **Translate: `withRetry` defaults (maxAttempts=3). Blur per-sample: `maxAttempts=2` + short-circuit the whole loop on quota-exhausted** | Translate is one batch call → full 3-attempt retry is cheap and worth it. Blur runs a 3-sample loop; 3 samples × 3 attempts × honored `retryDelay` (~16s) could add ~90s to the burn phase, so blur uses 2 attempts (one retry) and short-circuits immediately on `isQuotaExhaustedError` (all 3 samples would fail identically). Worst-case blur latency: 3 × 1 wait ≈ 3×16s ≈ 48s (honored delay) or 3×4s ≈ 12s (default backoff). |

**Why `untranslatedSegmentCount` is NOT a derived field:** it cannot be reliably re-derived from stored data. Comparing `translatedText === text` per segment gives false positives (proper nouns, numbers, short interjections legitimately translate to themselves) and is destroyed the moment the user edits a segment at the AWAITING_REVIEW checkpoint. The count captures a point-in-time fact ("N segments fell back to source after retries exhausted") that is not recoverable later — so it is stored, per the SSOT exception for non-derivable facts.

---

## Verified Codebase Facts (ground truth as of 2026-07-02)

| Fact | Location | Note |
|------|----------|------|
| `withRetry` retries ONLY on a THROWN rate-limit error; a successful-but-short return is invisible to it | `rate-limit.util.ts:51-77` | honors Gemini `retryDelay`; else exp backoff 4s→8s→16s; `maxAttempts` default 3 |
| `isRateLimitError` / `isQuotaExhaustedError` already classify transient-429 vs daily-quota | `rate-limit.util.ts:14-28` | quota-exhausted → `UnrecoverableError` (no retry); reuse both |
| Groq pads length mismatch with original text, does NOT throw | `groq-translate.service.ts:83-92` | `logger.warn` + `texts.map((orig,i)=>translations[i] ?? orig)` — makes the call always "succeed" |
| Gemini fallback pads the SAME way (duplicated logic) | `translation.service.ts:618-622` | `parsed.length !== texts.length` → warn + `texts[i]` pad |
| Final segment build masks empties with source text | `subtitle.service.ts:82` | `translatedText: translatedTexts[i] \|\| segment.text` |
| `translateBatch` non-test caller = ONLY `subtitle.service.ts` | grep `translateBatch` | signature/throw change is safe (1 caller) |
| `translateBatchViaGroq` caller = ONLY `subtitle.service.ts` | grep `translateBatchViaGroq` | safe (1 caller) |
| `translateSegments` caller = ONLY the worker | `video-pipeline.worker.ts:128` | return-shape change safe (1 caller) |
| Blur per-sample call is a bare try/catch-and-skip, NO `withRetry` | `subtitle-region.service.ts:50-62` | any error (incl. 429) → `logger.warn` + continue |
| All 3 samples fail → `regions.length===0` → return `null` | `subtitle-region.service.ts:64` | indistinguishable from legit "no subtitle in any frame" |
| Caller logs identical warn for both cases + skips blur | `video-pipeline.worker.ts:260-264` | "no burned-in subtitle detected, skipping blur step" |
| `detectSubtitleRegion` caller = ONLY the worker | `video-pipeline.worker.ts:247` | return-shape change safe (1 caller) |
| `VideoJob` model — no field for partial-translation / blur-skip status | `schema.prisma:69-89` | `getVideoJobs` uses `findMany` with NO `select` → any new column auto-returns to the API/frontend |
| Migration precedent (single `ADD COLUMN ... DEFAULT`) | `migrations/20260629074522_add_remove_source_subs_to_video_job/migration.sql` | follow this exact pattern; provider = postgresql |
| `updateJob` only allows `{status?,progress,stepDescription}` | `video-pipeline.worker.ts:395-400` | new fields need a direct `prisma.videoJob.update`, mirroring the `translatedSegments` write at `:143-150` |
| Frontend `VideoJob` type + job-list render | `frontend/src/app/types/index.ts:10-23`, `VideoTranslationSection.tsx:420-530` | shows status badge + stepDescription/errorMessage; COMPLETED shows the video (`:460`); no warning banner today |
| Frontend Next.js is non-standard | `frontend/AGENTS.md` | MUST read `node_modules/next/dist/docs/` before writing frontend code |

---

## Phases

| Phase | Name | Files owned | Effort |
|-------|------|-------------|--------|
| 1 | Shared foundation: schema + migration + retry-predicate + typed error | `schema.prisma`, new migration dir, `rate-limit.util.ts`, new `incomplete-translation.error.ts` | S |
| 2 | B1 — translate retry-before-fallback + untranslated-count surfacing | `groq-translate.service.ts`, `translation.service.ts`, `subtitle.service.ts`, `video-pipeline.worker.ts` (translate site) | M |
| 3 | B2 — blur detection retry + fail-vs-empty distinction | `subtitle-region.service.ts`, `video-pipeline.worker.ts` (blur site) | M |
| 4 | Frontend degraded-completion warning banner | `frontend/src/app/types/index.ts`, `frontend/src/app/components/VideoTranslationSection.tsx` | S |

Detail cards: `phase-1.md` … `phase-4.md`.

---

## File Ownership Map

| File | Phase(s) | Conflict handling |
|------|----------|-------------------|
| `backend/prisma/schema.prisma` | 1 | Phase 1 only |
| `backend/prisma/migrations/<new>/migration.sql` | 1 | Phase 1 only (new file) |
| `backend/src/translation/pipeline/rate-limit.util.ts` | 1 | Phase 1 only (additive optional `retryable` param) |
| `backend/src/translation/pipeline/incomplete-translation.error.ts` | 1 | Phase 1 only (new file); consumed by Phase 2 |
| `backend/src/translation/pipeline/groq-translate.service.ts` | 2 | Phase 2 only |
| `backend/src/translation/translation.service.ts` | 2 | Phase 2 only |
| `backend/src/translation/pipeline/subtitle.service.ts` | 2 | Phase 2 only |
| `backend/src/translation/pipeline/subtitle-region.service.ts` | 3 | Phase 3 only |
| `backend/src/translation/pipeline/video-pipeline.worker.ts` | **2 AND 3** | **SHARED — sequence 2 before 3.** Phase 2 edits the translate site (~128) + persists `untranslatedSegmentCount`; Phase 3 edits the blur site (~242) + persists `blurStatus`. Non-overlapping methods, but same file → NOT parallel-safe. |
| `frontend/src/app/types/index.ts` | 4 | Phase 4 only |
| `frontend/src/app/components/VideoTranslationSection.tsx` | 4 | Phase 4 only |

---

## Dependency Graph

```
Phase 1 (schema + migration + retryable predicate + IncompleteTranslationError)
   │  provides: DB columns, withRetry({retryable}), the typed error
   ├──► Phase 2 (B1 translate) ──► Phase 3 (B2 blur)   [worker.ts shared → 2 before 3]
   └──► Phase 4 (frontend banner)   [needs the two columns to exist in the API payload]

Critical path: 1 → 2 → 3.  Phase 4 may run in parallel with 2/3 once 1 lands
(frontend only reads fields; its runtime correctness is validated after 2+3 populate them).
Single-agent recommended sequence: 1 → 2 → 3 → 4.
```

---

## Cross-Cutting: The retry-before-fallback contract (B1)

Currently BOTH `groq-translate` and `translation.service` pad an incomplete result with source text and return "success" — duplicated logic in two places, and it hides the degradation from `withRetry`. This plan **removes padding from both producers** and centralizes it in ONE place (`subtitle.service`), only after retries are exhausted:

1. An "incomplete" result = returned array length ≠ input length **OR** any item empty/whitespace.
2. `groq-translate` and `translation.service.translateBatch` THROW `IncompleteTranslationError(partial, expected)` (carrying the best-effort partial array) instead of padding.
3. `withRetry` gains an optional `retryable?: (err) => boolean`; `subtitle.service` passes `isIncompleteTranslationError`, so an incomplete result RETRIES the whole batch with backoff (rate-limit errors still retry via the existing path; quota-exhausted still short-circuits first).
4. Order of attempts unchanged: Groq (retry×3) → on final failure fall back to Gemini (retry×3).
5. Only after BOTH exhaust does `subtitle.service` do the final pad-with-source, count the padded indices (`untranslatedSegmentCount`), and return `{ segments, untranslatedCount }`.
6. **No new silent fallback:** a *non-incomplete* real error (missing key, unparseable Gemini JSON) still propagates → the job FAILS visibly (correct). Only genuine partial-success degrades-and-completes, now WITH a recorded count + prominent log.

---

## Risk Assessment

| # | Risk | L (1-5) | I (1-5) | Score | Mitigation | Phase |
|---|------|---------|---------|-------|------------|-------|
| R1 | Removing producer-side padding + throwing could FAIL jobs that previously "succeeded" (any mismatch now retries then, if a real non-429 error, propagates) | 3 | 4 | **12** | Only `IncompleteTranslationError` is caught-and-degraded in `subtitle.service`; it never propagates. Retries first. Add a unit test: Groq returns short array 3× then Gemini returns full → job COMPLETES fully translated, count 0 | 2 |
| R2 | Blur retry loop balloons burn-phase latency (3 samples × retries × honored `retryDelay`) | 3 | 3 | 9 | `maxAttempts=2` for blur; short-circuit the whole loop on `isQuotaExhaustedError` (all samples fail identically); worst-case ≈48s honored / ≈12s default — documented in Phase 3 | 3 |
| R3 | Persistent model mis-behavior (always returns N-1) makes EVERY job spend full retries before degrading | 2 | 2 | 4 | Retries are bounded (3); after exhaustion it degrades-and-completes (not infinite). Count surfaces the systemic issue to the operator | 2 |
| R4 | New migration requires a DB connection; `prisma migrate` against postgres can't run offline | 3 | 2 | 6 | Ship the `migration.sql` following the precedent; cook runs `npx prisma migrate deploy` (or `dev`) with `DATABASE_URL` set. Both columns are additive with defaults → zero-downtime, no backfill | 1 |
| R5 | `IncompleteTranslationError` thrown from `translateBatch` breaks existing `translation.service.spec.ts` expectations | 3 | 2 | 6 | Audit + update the spec in Phase 2 (it's already modified/uncommitted); assert the new throw path | 2 |
| R6 | Distinguishing "detection failed (error)" from "no subtitle found" changes `detectSubtitleRegion`'s return shape | 2 | 2 | 4 | Only caller is the worker; return `{ region, failedDueToError }` (or a status enum) — Phase 3 updates the single call site | 3 |
| R7 | Frontend banner reads a field absent on old jobs created before the migration | 2 | 1 | 2 | Columns have defaults (`0` / `null`); banner renders only when `untranslatedSegmentCount > 0` or `blurStatus === 'skipped_error'` — old jobs read as "clean" | 4 |
| R8 | Blur short-circuit on quota-exhausted must still let the job COMPLETE (burn without blur), not fail | 2 | 3 | 6 | Detection failure sets `blurStatus='skipped_error'` + logs prominently, but the worker proceeds to burn (can't blur an unlocated region); the degradation is recorded, not fatal | 3 |

**HIGH-risk gate:** R1 (score 12) — before Phase 2 merges, a unit test must prove that (a) an incomplete result retries then fully translates on a later attempt, and (b) a genuine non-incomplete error still FAILS the job (no new silent success).

---

## Backwards Compatibility

- **Additive schema change** — two nullable/defaulted columns (`untranslatedSegmentCount Int @default(0)`, `blurStatus String?`). No backfill; old jobs read as clean. Zero-downtime.
- **Internal signature changes only** — `translateSegments` return shape and `detectSubtitleRegion` return shape change, but each has exactly ONE (worker) caller, updated in the same phase. No external/API contract change to request bodies or existing response fields.
- **API response is a superset** — `getVideoJobs`/`getVideoJobById` return the two new columns automatically; existing frontend fields are untouched, so old clients keep working.
- `withRetry`'s new `retryable` param is optional → existing 2 call sites in `subtitle.service` and any future callers are unaffected.

---

## Test Matrix

| Phase | Verify command / test | Pass criterion |
|-------|----------------------|-----------------|
| all | `cd backend && npm run build` | exits 0 (TS strict, no `any`) |
| all | `cd backend && npm test` | existing suite green, no regressions |
| 1 | `cd backend && npx prisma validate` | schema valid; migration SQL matches precedent shape |
| 1 | unit: `withRetry(fn,{retryable})` where fn throws a non-429 "incomplete" error | retries up to `maxAttempts`, then propagates; rate-limit + quota paths unchanged |
| 2 | unit: Groq returns short array on attempts 1-2, full on 3 (mock) | job fully translated, `untranslatedSegmentCount === 0`, Gemini never called |
| 2 | unit: Groq throws 3×, Gemini returns full | fully translated via Gemini, count 0 |
| 2 | unit: both Groq + Gemini return short every attempt | `untranslatedSegmentCount` = number of missing indices; those segments = source text; job COMPLETES (degraded, not failed) |
| 2 | unit: Gemini returns unparseable (non-incomplete real error) after Groq fails | job FAILS visibly — NOT a silent success (R1 gate) |
| 3 | unit: one sample 429 then success on retry (mock `detectRegionInFrame`) | region detected, blur applied, `blurStatus='applied'`, ≤2 attempts/sample |
| 3 | unit: all 3 samples throw 429 after retries | `detectSubtitleRegion` reports `failedDueToError`; worker sets `blurStatus='skipped_error'` + prominent log; job still COMPLETES |
| 3 | unit: all samples return `found:false` (legit) | `blurStatus='skipped_no_subtitle'`; quieter log; behavior unchanged from today |
| 3 | unit: first sample throws `isQuotaExhaustedError` | loop short-circuits (samples 2,3 not called); `blurStatus='skipped_error'` |
| 4 | `cd frontend && npm run build` | exits 0 |
| 4 | component/manual: COMPLETED job with `untranslatedSegmentCount>0` | warning line rendered ("N câu chưa dịch được") |
| 4 | component/manual: COMPLETED job with `blurStatus='skipped_error'` | distinct warning rendered; `skipped_no_subtitle`/`applied`/`null` render NO warning |

Mocking pattern: follow existing `video-pipeline.worker.spec.ts` / `burn-in.service.spec.ts` (uncommitted) — check them for the Prisma + service mock setup before writing new specs.

---

## Timeline

| Phase | Effort | Notes |
|-------|--------|-------|
| Phase 1 | S | Foundation; must land first (migration + shared types) |
| Phase 2 | M | Highest logical priority (B1); depends on Phase 1; owns translate site of worker.ts |
| Phase 3 | M | Depends on Phase 1; **must follow Phase 2** (shared worker.ts) |
| Phase 4 | S | Depends on Phase 1; may parallelize with 2/3 for coding, validate after |
| **Total** | **~M–L** | Critical path: 1 → 2 → 3. Single-agent sequence: 1 → 2 → 3 → 4 |

---

## Rollback Plan (per phase)

| Phase | Rollback |
|-------|----------|
| 1 | Revert `schema.prisma` + `rate-limit.util.ts` + delete new files; drop the migration (columns are additive → `ALTER TABLE ... DROP COLUMN` is safe if no rows depend on them). Restores prior retry util |
| 2 | Revert `groq-translate.service.ts`, `translation.service.ts`, `subtitle.service.ts`, and the translate-site edit in `video-pipeline.worker.ts` — restores pad-with-source (re-exposes B1) |
| 3 | Revert `subtitle-region.service.ts` + the blur-site edit in `video-pipeline.worker.ts` — restores bare try/catch skip (re-exposes B2) |
| 4 | Revert the two frontend files — backend still records the fields; only the banner disappears |

Phase 2 and 3 both touch `video-pipeline.worker.ts`, so a Phase-2 rollback after Phase 3 landed must preserve Phase 3's blur-site edit (revert by hunk, not whole-file).

---

## Next Step

`/t1k:cook .claude/plans/260702-translation-completeness-blur-reliability/plan.md`
