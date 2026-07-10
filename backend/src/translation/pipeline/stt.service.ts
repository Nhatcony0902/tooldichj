import { Logger } from '@nestjs/common';
import * as fs from 'fs/promises';
import { withRetry } from './rate-limit.util';

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface Transcript {
  language: string;
  segments: TranscriptSegment[];
}

const logger = new Logger('SttService');

const GROQ_STT_MODEL = 'whisper-large-v3-turbo';
// Groq file size limit is 25 MB; leave 1 MB safety margin.
const MAX_AUDIO_BYTES = 24 * 1024 * 1024;

// Whisper's documented failure mode on music-only/silent stretches: instead
// of emitting nothing, it hallucinates a short filler phrase (classically
// "Thank you.") and repeats it across the transcript (not necessarily back
// to back). A single such phrase is indistinguishable from real speech, but
// the SAME short phrase recurring several times in one transcript is the
// hallucination signature. To avoid dropping genuine short repeated speech
// (e.g. a narrator saying "Okay." three times), text repetition alone only
// flags a *candidate*; a segment is actually dropped only when Whisper's own
// no_speech_prob also says it doubted there was speech there (OpenAI/Groq's
// verbose_json exposes this per segment; their own decoder uses 0.6 as the
// no-speech cutoff, mirrored here). If no_speech_prob isn't present in the
// response, repetition alone is used as a fallback signal.
const HALLUCINATION_MIN_REPEATS = 3;
const HALLUCINATION_MAX_WORDS = 4;
const NO_SPEECH_PROB_THRESHOLD = 0.6;

interface GroqSegment {
  start: number;
  end: number;
  text: string;
  no_speech_prob?: number;
}

interface GroqVerboseResponse {
  language: string;
  text: string;
  segments: GroqSegment[];
}

export async function transcribeAudio(
  _ai: unknown,
  audioBuffer: Buffer,
  audioPath: string,
): Promise<Transcript> {
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    logger.warn('GROQ_API_KEY not set — returning mock transcript');
    return mockTranscript();
  }

  if (audioBuffer.length > MAX_AUDIO_BYTES) {
    const sizeMb = (audioBuffer.length / 1024 / 1024).toFixed(1);
    throw new Error(
      `Audio file too large for STT (${sizeMb} MB > 24 MB). Try a shorter video.`,
    );
  }

  const transcript = await withRetry(() => callGroqWhisper(apiKey, audioPath));
  return { ...transcript, segments: filterHallucinatedSegments(transcript.segments) };
}

// Lowercase, strip punctuation, drop the "music" marker Whisper sometimes
// bleeds into hallucinated text, and reduce to a sorted unique-word set so
// "Thank you Thank you Music" and "Thank you." collapse to the same
// canonical form regardless of how many times Whisper repeated the filler
// or in what order. (Trade-off: this is word-order-insensitive, so two
// distinct short sentences sharing the same words in a different order would
// also collapse together — accepted given the <=4-word cap keeps the blast
// radius small and the no_speech_prob gate below is the real discriminator.)
function canonicalizeForHallucinationCheck(text: string): string {
  const words = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w) => w !== 'music');
  return Array.from(new Set(words)).sort().join(' ');
}

export interface HallucinationCheckSegment extends TranscriptSegment {
  noSpeechProb?: number;
}

export function filterHallucinatedSegments<
  T extends HallucinationCheckSegment,
>(segments: T[]): T[] {
  const canonicalForms = segments.map((s) =>
    canonicalizeForHallucinationCheck(s.text),
  );
  const canonicalCounts = new Map<string, number>();
  for (const form of canonicalForms) {
    if (!form || form.split(' ').length > HALLUCINATION_MAX_WORDS) continue;
    canonicalCounts.set(form, (canonicalCounts.get(form) ?? 0) + 1);
  }
  return segments.filter((segment, i) => {
    const form = canonicalForms[i];
    const count = form ? (canonicalCounts.get(form) ?? 0) : 0;
    const isRepeatedFiller =
      !!form &&
      form.split(' ').length <= HALLUCINATION_MAX_WORDS &&
      count >= HALLUCINATION_MIN_REPEATS;
    if (!isRepeatedFiller) return true;
    // Repetition alone is only a candidate signal — require Whisper's own
    // no-speech confidence too, unless that field isn't available (then fall
    // back to repetition-only, the pre-existing behavior).
    const noSpeechConfirmed =
      segment.noSpeechProb === undefined ||
      segment.noSpeechProb >= NO_SPEECH_PROB_THRESHOLD;
    if (!noSpeechConfirmed) return true;
    logger.warn(
      `Dropping likely Whisper hallucination [${segment.start}-${segment.end}]: "${segment.text}" (repeated ${count}x as "${form}"${segment.noSpeechProb !== undefined ? `, no_speech_prob=${segment.noSpeechProb}` : ''})`,
    );
    return false;
  });
}

async function callGroqWhisper(
  apiKey: string,
  audioPath: string,
): Promise<{ language: string; segments: HallucinationCheckSegment[] }> {
  const fileBuffer = await fs.readFile(audioPath);

  const formData = new FormData();
  formData.append(
    'file',
    new Blob([fileBuffer], { type: 'audio/mpeg' }),
    'audio.mp3',
  );
  formData.append('model', GROQ_STT_MODEL);
  formData.append('response_format', 'verbose_json');
  formData.append('timestamp_granularities[]', 'segment');

  const response = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: formData,
    },
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Groq STT ${response.status}: ${errorText}`);
  }

  const data = (await response.json()) as GroqVerboseResponse;

  if (!data.segments || data.segments.length === 0) {
    return {
      language: data.language || 'unknown',
      segments: [{ start: 0, end: 0, text: data.text || '' }],
    };
  }

  return {
    language: data.language || 'unknown',
    segments: data.segments.map((s) => ({
      start: s.start,
      end: s.end,
      text: s.text.trim(),
      noSpeechProb: s.no_speech_prob,
    })),
  };
}

function mockTranscript(): Promise<Transcript> {
  return Promise.resolve({
    language: 'en',
    segments: [
      {
        start: 0,
        end: 5,
        text: '[Mock transcript — GROQ_API_KEY not configured]',
      },
    ],
  });
}
