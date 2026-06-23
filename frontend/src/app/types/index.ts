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
  status: "PENDING" | "PROCESSING" | "COMPLETED" | "FAILED";
  progress: number;
  stepDescription: string;
  targetLang: string;
  outputMode?: string;
  subtitlesUrl?: string;
  outputVideoUrl?: string | null;
  outputAudioUrl?: string | null;
  errorMessage?: string;
  createdAt: string;
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
