import { ProsodyOptions } from 'msedge-tts';

// Bounds enforced on every derived value — see plan
// .claude/plans/260710-1037-dubbing-prosody-emotion-matching/plan.md
// "load-bearing design constraint": a negative rate lengthens the TTS clip,
// which dubbing.service.ts's soft-sync atempo compressor then speeds back up
// to fit the subtitle slot — fighting the very "calm" intent a negative rate
// was meant to convey. Emotion for calm/trailing-off lines is carried by
// pitch only; rate is only ever used in the neutral-to-faster direction.
const RATE_MIN_PCT = 0;
const RATE_MAX_PCT = 15;
const PITCH_MIN_PCT = -10;
const PITCH_MAX_PCT = 10;
const VOLUME_MIN_PCT = -10;
const VOLUME_MAX_PCT = 10;

const URGENT_RATE_PCT = 12;
const URGENT_PITCH_PCT = 8;
const URGENT_VOLUME_PCT = 8;
const QUESTION_PITCH_PCT = 6;
const CALM_PITCH_PCT = -6;
// A short sentence ending in "." is just an ordinary statement, not a
// deliberately trailing-off calm delivery — only treat it as "calm" once
// it's long enough that a flat, slightly lower pitch reads as intentional.
const CALM_MIN_WORDS = 8;

// Vietnamese imperative/urgent cue words, matched as a WHOLE leading word
// (not a substring prefix) — "đi" must not match inside "Điện thoại". Each
// entry is compiled into a regex requiring the cue be followed by a space,
// punctuation, or end of string.
const IMPERATIVE_CUES = ['nhanh', 'mau', 'đi', 'dừng', 'cẩn thận'];
const IMPERATIVE_CUE_PATTERNS = IMPERATIVE_CUES.map(
  (cue) => new RegExp(`^${cue}(?=[\\s.,!?…]|$)`, 'i'),
);
// An all-caps run of 3+ letters (Vietnamese diacritics included) reads as
// shouted/urgent emphasis regardless of punctuation. No \b anchor — \b is
// ASCII-only in JS regex and would miss a run starting with a Vietnamese-only
// uppercase glyph (e.g. "ĐƯỜNG"); 3+ consecutive uppercase-class letters is
// signal enough on its own.
const ALL_CAPS_RUN = /[A-ZÀ-Ỹ]{3,}/;

function clampPct(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function pct(value: number, min: number, max: number): string {
  const clamped = clampPct(value, min, max);
  return `${clamped >= 0 ? '+' : ''}${clamped}%`;
}

function isUrgent(text: string): boolean {
  if (text.endsWith('!')) return true;
  if (ALL_CAPS_RUN.test(text)) return true;
  return IMPERATIVE_CUE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Derive a small, bounded prosody adjustment from cheap local text signals
 * (punctuation, imperative cues, length, ALL-CAPS) so urgent/exclamatory
 * lines read differently from neutral ones. Returns `undefined` for neutral
 * text — plain synthesis, identical to pre-prosody behavior (and preserves
 * the existing cache entry for that exact text; see `prosodySignature`).
 */
export function deriveProsody(text: string): ProsodyOptions | undefined {
  const trimmed = text.trim();
  if (!trimmed) return undefined;

  if (isUrgent(trimmed)) {
    return {
      rate: pct(URGENT_RATE_PCT, RATE_MIN_PCT, RATE_MAX_PCT),
      pitch: pct(URGENT_PITCH_PCT, PITCH_MIN_PCT, PITCH_MAX_PCT),
      volume: pct(URGENT_VOLUME_PCT, VOLUME_MIN_PCT, VOLUME_MAX_PCT),
    };
  }

  if (trimmed.endsWith('?')) {
    return { pitch: pct(QUESTION_PITCH_PCT, PITCH_MIN_PCT, PITCH_MAX_PCT) };
  }

  const isTrailingOff = trimmed.endsWith('…') || trimmed.endsWith('.');
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  if (isTrailingOff && wordCount > CALM_MIN_WORDS) {
    return { pitch: pct(CALM_PITCH_PCT, PITCH_MIN_PCT, PITCH_MAX_PCT) };
  }

  return undefined;
}

/**
 * Compact string form of a ProsodyOptions, folded into the TTS cache-key
 * hash input so a prosody-adjusted synthesis never collides with (or
 * overwrites) the plain-text cache entry for the same words.
 * `prosodySignature(undefined) === ''` — the plain-text path (`getSample`,
 * manual `synthesize` calls with no prosody) hashes identically to before
 * this feature existed, so those cache rows are untouched.
 */
export function prosodySignature(opts: ProsodyOptions | undefined): string {
  if (!opts) return '';
  return `|r=${opts.rate ?? ''}|p=${opts.pitch ?? ''}|v=${opts.volume ?? ''}`;
}
