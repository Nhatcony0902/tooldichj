import { Logger } from '@nestjs/common';
import { TranslationService } from '../translation.service';
import { TranscriptSegment } from './stt.service';
import { withRetry } from './rate-limit.util';
import { translateBatchViaGroq } from './groq-translate.service';
import { isIncompleteTranslationError } from './incomplete-translation.error';

const logger = new Logger('subtitle.service');

export interface TranslatedSegment extends TranscriptSegment {
  translatedText: string;
}

const MAX_LINE_CHARS = 42;
// A translated subtitle segment should display at most ~12 words at a time.
// When Gemini STT returns a single large segment (fallback or short audio that
// Gemini groups as one chunk), splitting it here keeps subtitles readable
// instead of cramming a full transcript into two lines.
const MAX_WORDS_PER_SUBTITLE = 12;

function splitLongSegment(segment: TranslatedSegment): TranslatedSegment[] {
  const words = segment.translatedText.split(/\s+/).filter(Boolean);
  if (words.length <= MAX_WORDS_PER_SUBTITLE) return [segment];

  const duration = segment.end - segment.start;
  const chunks: string[] = [];
  for (let i = 0; i < words.length; i += MAX_WORDS_PER_SUBTITLE) {
    chunks.push(words.slice(i, i + MAX_WORDS_PER_SUBTITLE).join(' '));
  }
  const segDuration = duration / chunks.length;
  return chunks.map((text, idx) => ({
    ...segment,
    start: segment.start + idx * segDuration,
    end: segment.start + (idx + 1) * segDuration,
    translatedText: text,
  }));
}

function wrapToTwoLines(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text;
  const words = text.split(/\s+/);
  const lines: string[] = ['', ''];
  let li = 0;
  for (const w of words) {
    const candidate = lines[li] ? `${lines[li]} ${w}` : w;
    if (candidate.length > MAX_LINE_CHARS && li === 0) {
      li = 1;
      lines[1] = w;
    } else {
      lines[li] = candidate;
    }
  }
  return lines.filter(Boolean).join('\n');
}

export interface TranslateSegmentsResult {
  segments: TranslatedSegment[];
  untranslatedCount: number;
}

export async function translateSegments(
  translationService: TranslationService,
  _userId: string,
  segments: TranscriptSegment[],
  sourceLang: string,
  targetLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<TranslateSegmentsResult> {
  const texts = segments.map((s) => s.text);
  let usable: string[];
  try {
    // Groq LLaMA (6,000 RPM / 14,400 RPD) handles video quota better than
    // Gemini (15 RPM / 1,500 RPD). Falls back to Gemini if Groq is unavailable.
    // An incomplete result (short/empty items) retries the whole batch
    // before falling back — see rate-limit.util.ts `retryable`.
    usable = await withRetry<string[]>(
      () => translateBatchViaGroq(texts, sourceLang, targetLang),
      { retryable: isIncompleteTranslationError },
    );
  } catch (groqErr) {
    logger.warn(
      `Groq subtitle translation failed, falling back to Gemini: ${groqErr instanceof Error ? groqErr.message : String(groqErr)}`,
    );
    try {
      usable = await withRetry<string[]>(
        () => translationService.translateBatch(texts, sourceLang, targetLang),
        { retryable: isIncompleteTranslationError },
      );
    } catch (geminiErr) {
      // A genuine error (bad key, unparseable JSON, non-429 failure) must
      // fail the job visibly — only an incomplete-after-retries result
      // degrades-and-completes.
      if (!isIncompleteTranslationError(geminiErr)) throw geminiErr;
      usable = geminiErr.partial;
    }
  }
  onProgress?.(segments.length, segments.length);

  let untranslatedCount = 0;
  const out = segments.map((segment, i) => {
    const t = usable[i]?.trim();
    if (t) return { ...segment, translatedText: usable[i] };
    untranslatedCount += 1;
    return { ...segment, translatedText: segment.text }; // recorded fallback, not silent
  });
  if (untranslatedCount > 0) {
    logger.warn(
      `translateSegments: ${untranslatedCount}/${segments.length} segments left as source after retries exhausted`,
    );
  }
  return { segments: out, untranslatedCount };
}

// Parse/validate a stored translatedSegments JSON blob back into typed segments.
export function parseStoredSegments(value: unknown): TranslatedSegment[] {
  if (!Array.isArray(value)) {
    throw new Error('translatedSegments is not an array');
  }
  return value.map((s, i) => {
    const seg = s as Partial<TranslatedSegment>;
    if (
      typeof seg.start !== 'number' ||
      typeof seg.end !== 'number' ||
      typeof seg.text !== 'string' ||
      typeof seg.translatedText !== 'string'
    ) {
      throw new Error(`Stored segment ${i} has an invalid shape`);
    }
    return { start: seg.start, end: seg.end, text: seg.text, translatedText: seg.translatedText };
  });
}

// Validate a user-supplied edit set against the stored segments (MVP: translatedText only).
// Returns the merged segment array (stored timing/original text preserved; only translatedText overwritten).
export function applySegmentEdits(
  stored: TranslatedSegment[],
  edits: { index: number; translatedText: string }[],
): TranslatedSegment[] {
  if (!Array.isArray(edits) || edits.length !== stored.length) {
    throw new Error('Edit set length does not match stored segments');
  }
  const merged = stored.map((s) => ({ ...s }));
  const seen = new Set<number>();
  for (const e of edits) {
    if (
      typeof e.index !== 'number' ||
      e.index < 0 ||
      e.index >= merged.length ||
      seen.has(e.index) ||
      typeof e.translatedText !== 'string' ||
      e.translatedText.trim().length === 0
    ) {
      throw new Error(`Invalid edit for segment index ${e?.index}`);
    }
    seen.add(e.index);
    merged[e.index].translatedText = e.translatedText;
  }
  return merged;
}

export function buildSrt(segments: TranslatedSegment[]): string {
  const expanded = segments.flatMap((s) => splitLongSegment(s));
  return expanded
    .map(
      (segment, index) =>
        `${index + 1}\n${toSrtTimestamp(segment.start)} --> ${toSrtTimestamp(segment.end)}\n${wrapToTwoLines(segment.translatedText)}\n`,
    )
    .join('\n');
}

function toSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
