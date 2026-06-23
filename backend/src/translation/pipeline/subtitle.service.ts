import { TranslationService } from '../translation.service';
import { TranscriptSegment } from './stt.service';

export interface TranslatedSegment extends TranscriptSegment {
  translatedText: string;
}

export async function translateSegments(
  translationService: TranslationService,
  userId: string,
  segments: TranscriptSegment[],
  sourceLang: string,
  targetLang: string,
): Promise<TranslatedSegment[]> {
  const translated: TranslatedSegment[] = [];
  for (const segment of segments) {
    // chargeCredit=false: the video job already charges a flat 10 credits on
    // COMPLETED; per-segment calls only reuse the translate() cache, never bill.
    // translate() now returns { translatedText, detectedLang } (Phase 3
    // auto-detect). sourceLang here comes from STT (transcript.language),
    // which uses "unknown" — never the literal "auto" — for its
    // can't-detect case specifically so it never trips translate()'s
    // strict auto-detect branch; detectedLang is discarded as a result.
    const { translatedText } = await translationService.translate(
      userId,
      segment.text,
      sourceLang,
      targetLang,
      false,
    );
    translated.push({
      ...segment,
      translatedText: translatedText || segment.text,
    });
  }
  return translated;
}

export function buildSrt(segments: TranslatedSegment[]): string {
  return segments
    .map(
      (segment, index) =>
        `${index + 1}\n${toSrtTimestamp(segment.start)} --> ${toSrtTimestamp(segment.end)}\n${segment.translatedText}\n`,
    )
    .join('\n');
}

function toSrtTimestamp(seconds: number): string {
  const totalMs = Math.max(0, Math.round(seconds * 1000));
  const ms = totalMs % 1000;
  const totalSec = Math.floor(totalMs / 1000);
  const s = totalSec % 60;
  const totalMin = Math.floor(totalSec / 60);
  const m = totalMin % 60;
  const h = Math.floor(totalMin / 60);
  const pad = (n: number, len = 2) => n.toString().padStart(len, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}
