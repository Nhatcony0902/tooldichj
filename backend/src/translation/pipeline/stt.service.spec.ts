import {
  filterHallucinatedSegments,
  TranscriptSegment,
  HallucinationCheckSegment,
} from './stt.service';

describe('filterHallucinatedSegments', () => {
  it('drops the repeated "Thank you" filler observed on VideoJob 01dda00b (real Groq transcript)', () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 2, text: '.' },
      { start: 30, end: 59.98, text: "I'm going to go to the next day." },
      { start: 60, end: 77.568, text: 'I going to go to the next one Music' },
      { start: 105.568, end: 135.548, text: 'Thank you.' },
      { start: 135.568, end: 158.136, text: 'Thank you Thank you Music' },
      { start: 186.136, end: 216.116, text: 'Thank you.' },
      { start: 216.136, end: 266.684, text: 'Thank you Thank you' },
      { start: 266.70398, end: 296.684, text: 'Thank you.' },
      { start: 296.70398, end: 326.684, text: 'Thank you.' },
    ];

    const result = filterHallucinatedSegments(segments);

    expect(result.map((s) => s.text)).toEqual([
      '.',
      "I'm going to go to the next day.",
      'I going to go to the next one Music',
    ]);
  });

  it('keeps a short phrase that only appears once or twice (not a repeat pattern)', () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 2, text: 'Thank you.' },
      { start: 2, end: 4, text: 'Thank you.' },
      { start: 4, end: 6, text: "Let's get started with today's tutorial." },
    ];

    const result = filterHallucinatedSegments(segments);

    expect(result).toHaveLength(3);
  });

  it('keeps longer genuine sentences even if they repeat', () => {
    const segments: TranscriptSegment[] = [
      { start: 0, end: 2, text: 'Please subscribe to the channel for more videos.' },
      { start: 2, end: 4, text: 'Please subscribe to the channel for more videos.' },
      { start: 4, end: 6, text: 'Please subscribe to the channel for more videos.' },
    ];

    const result = filterHallucinatedSegments(segments);

    expect(result).toHaveLength(3);
  });

  it('keeps a short phrase repeated exactly 3x when Whisper itself is confident it is real speech (low no_speech_prob)', () => {
    const segments: HallucinationCheckSegment[] = [
      { start: 0, end: 2, text: 'Okay.', noSpeechProb: 0.05 },
      { start: 10, end: 12, text: 'Okay.', noSpeechProb: 0.08 },
      { start: 20, end: 22, text: 'Okay.', noSpeechProb: 0.03 },
    ];

    const result = filterHallucinatedSegments(segments);

    expect(result).toHaveLength(3);
  });

  it('drops a short repeated phrase when Whisper also flags high no_speech_prob on every occurrence', () => {
    const segments: HallucinationCheckSegment[] = [
      { start: 0, end: 2, text: 'Thank you.', noSpeechProb: 0.91 },
      { start: 10, end: 12, text: 'Thank you.', noSpeechProb: 0.88 },
      { start: 20, end: 22, text: 'Thank you.', noSpeechProb: 0.95 },
    ];

    const result = filterHallucinatedSegments(segments);

    expect(result).toHaveLength(0);
  });
});
