export interface TranslationHistory {
  id: string; // real backend UUID (TranslationHistory.id), not a client-generated random string
  sourceText: string;
  translatedText: string;
  sourceLang: string;
  targetLang: string;
  timestamp: string;
}

export interface VideoJob {
  id: string;
  fileName: string;
  status: "PENDING" | "PROCESSING" | "AWAITING_REVIEW" | "COMPLETED" | "FAILED" | "CANCELLED";
  progress: number;
  stepDescription: string;
  targetLang: string;
  outputMode?: string;
  subtitlesUrl?: string;
  outputVideoUrl?: string | null;
  outputAudioUrl?: string | null;
  errorMessage?: string;
  untranslatedSegmentCount?: number; // segments left as source after retries (B1)
  blurStatus?: "applied" | "skipped_no_subtitle" | "skipped_error" | null; // original-subtitle blur outcome (B2)
  dubStatus?: "applied" | "skipped_no_speech" | null; // dub outcome: skipped when all segments were dropped as Whisper hallucinations
  createdAt: string;
}

export interface SubtitleSegment {
  index: number;
  start: number;
  end: number;
  text: string; // original (read-only)
  translatedText: string; // editable
}

export interface User {
  id: string;
  email: string;
  name: string;
  phone?: string | null;
  avatarUrl?: string | null;
  role?: string;
  credits: number;
  mfaEnabled?: boolean;
  preferredVoiceId?: string | null;
}

export interface Voice {
  id: string;
  displayName: string;
  style: string;
  sampleUrl: string;
}

export interface CreditTopupRequest {
  id: string;
  amount: number;
  credits: number;
  orderCode: string;
  status: "PENDING" | "CONFIRMED" | "REJECTED";
  createdAt: string;
  user?: { id: string; email: string; name: string };
}
