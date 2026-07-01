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

const VOICE_IDS = new Set(VOICE_CATALOG.map((v) => v.id));

export function isValidVoiceId(voiceId: string): boolean {
  return VOICE_IDS.has(voiceId);
}

export const DEFAULT_VOICE_ID = 'vi-VN-HoaiMyNeural';
