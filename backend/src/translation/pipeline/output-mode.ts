// Contract shared with the frontend's video-tab "output format" <select> —
// the option values in VideoTranslationSection.tsx MUST match these exact
// strings (per rules/contract-first-integration.md).
export const OUTPUT_MODES = ['srt', 'burn', 'dub', 'burn+dub'] as const;
export type OutputMode = (typeof OUTPUT_MODES)[number];

export function isValidOutputMode(value: string): value is OutputMode {
  return (OUTPUT_MODES as readonly string[]).includes(value);
}

export function outputModeIncludesBurn(mode: OutputMode): boolean {
  return mode === 'burn' || mode === 'burn+dub';
}

export function outputModeIncludesDub(mode: OutputMode): boolean {
  return mode === 'dub' || mode === 'burn+dub';
}

export function outputModeProducesVideo(mode: OutputMode): boolean {
  return mode !== 'srt';
}
