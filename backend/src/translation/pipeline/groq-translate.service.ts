import { Logger } from '@nestjs/common';

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_TRANSLATE_MODEL = 'llama-3.3-70b-versatile';

const logger = new Logger('groq-translate');

export async function translateBatchViaGroq(
  texts: string[],
  sourceLang: string,
  targetLang: string,
): Promise<string[]> {
  if (texts.length === 0) return [];

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    throw new Error('GROQ_API_KEY is not set');
  }

  const userPrompt = `Translate the following subtitle texts from ${sourceLang} to ${targetLang}.
Keep each translation concise (≤12 words per item). Return ONLY valid JSON with this exact shape:
{"translations": ["<translation_1>", "<translation_2>", ...]}
Same number of items as input, same order.

Input texts (JSON array):
${JSON.stringify(texts)}`;

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: GROQ_TRANSLATE_MODEL,
      temperature: 0.2,
      // json_object mode forces an object wrapper — NOT a bare array.
      // Prompt must request {"translations":[...]} so we can extract the field.
      response_format: { type: 'json_object' },
      messages: [
        {
          role: 'system',
          content: 'You are a subtitle translator. Return ONLY valid JSON.',
        },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Groq translate ${response.status}: ${body}`);
  }

  const data = (await response.json()) as {
    choices: { message: { content: string } }[];
  };

  const raw = data.choices[0]?.message?.content;
  if (!raw) {
    throw new Error('Groq translate: empty response content');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(
      `Groq translate: unparseable JSON: ${raw.slice(0, 200)}`,
    );
  }

  const translations = (parsed as Record<string, unknown>).translations;
  if (
    !Array.isArray(translations) ||
    !translations.every((v) => typeof v === 'string')
  ) {
    throw new Error(
      `Groq translate: invalid translations field: ${raw.slice(0, 200)}`,
    );
  }

  if (translations.length === texts.length) {
    return translations as string[];
  }

  // Length mismatch: pad/trim to preserve subtitle alignment.
  // Mirrors the same safety logic used by the Gemini fallback.
  logger.warn(
    `Groq translate length mismatch: expected ${texts.length}, got ${translations.length}. Padding/trimming.`,
  );
  return texts.map((orig, i) => (translations as string[])[i] ?? orig);
}
