// Thrown by a translate producer (Groq/Gemini) when its response is
// shorter than requested or contains empty items — signals `withRetry`
// to retry the whole batch before any caller falls back to source text.
export class IncompleteTranslationError extends Error {
  constructor(
    readonly partial: string[], // best-effort array; empty string marks an untranslated slot
    readonly expected: number,
  ) {
    super(
      `Incomplete translation: expected ${expected}, usable ${partial.filter((t) => t.trim()).length}`,
    );
    this.name = 'IncompleteTranslationError';
  }
}

export function isIncompleteTranslationError(
  e: unknown,
): e is IncompleteTranslationError {
  return e instanceof IncompleteTranslationError;
}
