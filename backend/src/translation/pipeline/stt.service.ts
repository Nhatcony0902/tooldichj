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

interface GroqSegment {
  start: number;
  end: number;
  text: string;
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

  return withRetry(() => callGroqWhisper(apiKey, audioPath));
}

async function callGroqWhisper(
  apiKey: string,
  audioPath: string,
): Promise<Transcript> {
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
