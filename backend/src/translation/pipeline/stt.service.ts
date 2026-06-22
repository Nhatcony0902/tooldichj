import { Logger } from '@nestjs/common';
import type { GoogleGenAI } from '@google/genai';
import { getAudioDuration } from './audio-extractor';

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

export async function transcribeAudio(
  ai: GoogleGenAI | null,
  audioBuffer: Buffer,
  audioPath: string,
): Promise<Transcript> {
  if (!ai) {
    return mockTranscript();
  }

  const base64Audio = audioBuffer.toString('base64');

  try {
    const raw = await callGemini(
      ai,
      base64Audio,
      `Transcribe this audio. Detect the spoken language (ISO 639-1 code, e.g. "en", "vi", "ja").
Return ONLY a JSON object, no markdown fences, in this exact shape:
{"language":"<iso-code>","segments":[{"start":<seconds-number>,"end":<seconds-number>,"text":"<transcribed text>"}]}
Split into segments of roughly 3-8 seconds aligned to natural speech pauses.`,
    );

    const parsed = JSON.parse(stripMarkdownFence(raw)) as Transcript;
    if (!Array.isArray(parsed.segments) || parsed.segments.length === 0) {
      throw new Error('Empty segments in STT response');
    }
    return parsed;
  } catch (err) {
    logger.error(
      'Gemini STT failed or returned unparseable JSON, falling back to whole-audio heuristic transcript',
      err instanceof Error ? err.message : err,
    );
    return fallbackWholeAudioTranscript(ai, base64Audio, audioPath);
  }
}

async function callGemini(
  ai: GoogleGenAI,
  base64Audio: string,
  prompt: string,
): Promise<string> {
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'audio/mp3', data: base64Audio } },
          { text: prompt },
        ],
      },
    ],
  });
  return response.text?.trim() || '';
}

function stripMarkdownFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1] : text;
}

async function fallbackWholeAudioTranscript(
  ai: GoogleGenAI,
  base64Audio: string,
  audioPath: string,
): Promise<Transcript> {
  const duration = await getAudioDuration(audioPath).catch(() => 0);
  try {
    const text = await callGemini(
      ai,
      base64Audio,
      'Transcribe this audio verbatim. Reply with ONLY the transcript text, no JSON, no notes.',
    );
    return {
      // Source language is unknown in this fallback path (no per-segment
      // detection); "auto" is an honest signal, not a real ISO code.
      language: 'auto',
      segments: [{ start: 0, end: duration || 1, text }],
    };
  } catch (err) {
    logger.error(
      'Fallback whole-audio STT also failed',
      err instanceof Error ? err.message : err,
    );
    throw new Error(
      'Speech-to-text failed: ' +
        (err instanceof Error ? err.message : 'unknown error'),
    );
  }
}

function mockTranscript(): Promise<Transcript> {
  return Promise.resolve({
    language: 'en',
    segments: [
      {
        start: 0,
        end: 5,
        text: '[Mock transcript - GEMINI_API_KEY not configured]',
      },
    ],
  });
}
