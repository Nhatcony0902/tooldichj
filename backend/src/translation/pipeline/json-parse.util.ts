// Gemini responses sometimes wrap JSON in a ```json ... ``` markdown fence
// despite instructions not to. Strip the fence before JSON.parse. Shared by
// translation.service.ts (detect+translate) and subtitle-region.service.ts.
export function stripMarkdownFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1] : text;
}
