import { Logger } from '@nestjs/common';
import { TranslationService } from '../translation.service';
import { TranscriptSegment } from './stt.service';
import { withRetry } from './rate-limit.util';
import { translateBatchViaGroq } from './groq-translate.service';

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

export async function translateSegments(
  translationService: TranslationService,
  _userId: string,
  segments: TranscriptSegment[],
  sourceLang: string,
  targetLang: string,
  onProgress?: (done: number, total: number) => void,
): Promise<TranslatedSegment[]> {
  const texts = segments.map((s) => s.text);
  let translatedTexts: string[];
  try {
    // Groq LLaMA (6,000 RPM / 14,400 RPD) handles video quota better than
    // Gemini (15 RPM / 1,500 RPD). Falls back to Gemini if Groq is unavailable.
    translatedTexts = await withRetry<string[]>(() =>
      translateBatchViaGroq(texts, sourceLang, targetLang),
    );
  } catch (groqErr) {
    logger.warn(
      `Groq subtitle translation failed, falling back to Gemini: ${groqErr instanceof Error ? groqErr.message : String(groqErr)}`,
    );
    translatedTexts = await withRetry<string[]>(() =>
      translationService.translateBatch(texts, sourceLang, targetLang),
    );
  }
  onProgress?.(segments.length, segments.length);
  return segments.map((segment, i) => ({
    ...segment,
    translatedText: translatedTexts[i] || segment.text,
  }));
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
