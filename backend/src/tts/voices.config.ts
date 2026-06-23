// Pinned per the Phase 3 spike (plans/260622-1035-tts-video-pipeline-billing/phase-3-tts-voice.md):
// Gemini's TTS docs (https://ai.google.dev/gemini-api/docs/speech-generation) do not tag voices
// with gender/accent — only a short style descriptor — so the catalog reflects what's actually
// published rather than the plan's original (gender/accent) field guess.
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';

export interface VoiceCatalogEntry {
  id: string;
  displayName: string;
  style: string;
}

export const VOICE_CATALOG: VoiceCatalogEntry[] = [
  { id: 'Zephyr', displayName: 'Zephyr', style: 'Bright' },
  { id: 'Puck', displayName: 'Puck', style: 'Upbeat' },
  { id: 'Charon', displayName: 'Charon', style: 'Informative' },
  { id: 'Kore', displayName: 'Kore', style: 'Firm' },
  { id: 'Fenrir', displayName: 'Fenrir', style: 'Excitable' },
  { id: 'Leda', displayName: 'Leda', style: 'Youthful' },
  { id: 'Orus', displayName: 'Orus', style: 'Firm' },
  { id: 'Aoede', displayName: 'Aoede', style: 'Breezy' },
  { id: 'Callirrhoe', displayName: 'Callirrhoe', style: 'Easy-going' },
  { id: 'Autonoe', displayName: 'Autonoe', style: 'Bright' },
  { id: 'Enceladus', displayName: 'Enceladus', style: 'Breathy' },
  { id: 'Iapetus', displayName: 'Iapetus', style: 'Clear' },
  { id: 'Umbriel', displayName: 'Umbriel', style: 'Easy-going' },
  { id: 'Algieba', displayName: 'Algieba', style: 'Smooth' },
  { id: 'Despina', displayName: 'Despina', style: 'Smooth' },
  { id: 'Erinome', displayName: 'Erinome', style: 'Clear' },
  { id: 'Algenib', displayName: 'Algenib', style: 'Gravelly' },
  { id: 'Rasalgethi', displayName: 'Rasalgethi', style: 'Informative' },
  { id: 'Laomedeia', displayName: 'Laomedeia', style: 'Upbeat' },
  { id: 'Achernar', displayName: 'Achernar', style: 'Soft' },
  { id: 'Alnilam', displayName: 'Alnilam', style: 'Firm' },
  { id: 'Schedar', displayName: 'Schedar', style: 'Even' },
  { id: 'Gacrux', displayName: 'Gacrux', style: 'Mature' },
  { id: 'Pulcherrima', displayName: 'Pulcherrima', style: 'Forward' },
  { id: 'Achird', displayName: 'Achird', style: 'Friendly' },
  { id: 'Zubenelgenubi', displayName: 'Zubenelgenubi', style: 'Casual' },
  { id: 'Vindemiatrix', displayName: 'Vindemiatrix', style: 'Gentle' },
  { id: 'Sadachbia', displayName: 'Sadachbia', style: 'Lively' },
  { id: 'Sadaltager', displayName: 'Sadaltager', style: 'Knowledgeable' },
  { id: 'Sulafat', displayName: 'Sulafat', style: 'Warm' },
];

const VOICE_IDS = new Set(VOICE_CATALOG.map((v) => v.id));

export function isValidVoiceId(voiceId: string): boolean {
  return VOICE_IDS.has(voiceId);
}

export const DEFAULT_VOICE_ID = 'Kore';
