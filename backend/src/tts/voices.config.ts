export interface VoiceCatalogEntry {
  id: string;       // Edge TTS voice name (e.g. vi-VN-HoaiMyNeural)
  displayName: string;
  style: string;
  lang: string;
}

export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: 'vi-VN-HoaiMyNeural',  displayName: 'Hoài My (Nữ)', style: 'Thân thiện', lang: 'vi' },
  { id: 'vi-VN-NamMinhNeural', displayName: 'Nam Minh (Nam)', style: 'Tự nhiên', lang: 'vi' },
];

// Fixed voice used for video dubbing (product decision: no per-video voice
// picker, so no dubVoiceId column — see plans/260707-1435-dubbing-soft-sync-reintroduce).
export const DEFAULT_VOICE_ID = 'vi-VN-HoaiMyNeural';

const VOICE_IDS = new Set(VOICE_CATALOG.map((v) => v.id));

export function isValidVoiceId(voiceId: string): boolean {
  return VOICE_IDS.has(voiceId);
}
