import { Inject, Injectable, Logger } from '@nestjs/common';
import ffmpeg from 'fluent-ffmpeg';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { GeminiClientService } from '../gemini/gemini-client.service';
import { CreditService } from '../credit/credit.service';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';
import {
  STORAGE_PROVIDER,
  type IStorageProvider,
} from '../storage/storage.interface';
import { TTS_MODEL, isValidVoiceId } from './voices.config';

export interface SynthesizeResult {
  audioBuffer: Buffer;
  cached: boolean;
}

interface TtsAudio {
  buffer: Buffer;
  isMock: boolean;
}

const SAMPLE_PHRASE = 'Hello! This is a preview of my voice.';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly geminiClient: GeminiClientService,
    private readonly creditService: CreditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  async synthesize(
    userId: string,
    text: string,
    voiceId: string,
    chargeCredit = true,
  ): Promise<SynthesizeResult> {
    if (!text || !text.trim()) {
      throw new Error('Text is required');
    }
    if (!isValidVoiceId(voiceId)) {
      throw new Error(`Unknown voiceId "${voiceId}"`);
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    if (!user) {
      throw new Error('User not found');
    }
    if (chargeCredit && user.credits <= 0) {
      throw new InsufficientCreditsError(
        'Tài khoản đã hết Credits. Vui lòng nạp thêm để tiếp tục!',
      );
    }

    const result = await this.synthesizeOrServeFromCache(text, voiceId);
    if (chargeCredit) {
      await this.creditService.deductCredit(userId, 1);
    }
    return result;
  }

  async getSample(voiceId: string): Promise<SynthesizeResult> {
    if (!isValidVoiceId(voiceId)) {
      throw new Error(`Unknown voiceId "${voiceId}"`);
    }
    return this.synthesizeOrServeFromCache(SAMPLE_PHRASE, voiceId);
  }

  private async synthesizeOrServeFromCache(
    text: string,
    voiceId: string,
  ): Promise<SynthesizeResult> {
    const textHash = this.geminiClient.getHash(text);

    const cached = await this.prisma.ttsCache.findUnique({
      where: { textHash_voiceId: { textHash, voiceId } },
    });
    if (cached && cached.audioStorageKey) {
      this.logger.log(`TTS cache hit (text+voice hash: ${textHash})`);
      const audioBuffer = await this.storage.read(cached.audioStorageKey);
      return { audioBuffer, cached: true };
    }

    // Claim the (textHash, voiceId) slot via the unique constraint itself —
    // only one concurrent caller can insert this empty-key placeholder row.
    // The loser falls through to waitForPendingEntry instead of also calling
    // Gemini, so two simultaneous requests for the same uncached text+voice
    // never double-bill the Gemini API (each still pays its own 1 credit at
    // the call site, same as two sequential calls would — that's intentional,
    // not a bug).
    let claimed = false;
    try {
      await this.prisma.ttsCache.create({
        data: { textHash, voiceId, audioStorageKey: '' },
      });
      claimed = true;
    } catch {
      claimed = false;
    }

    if (!claimed) {
      return this.waitForPendingEntry(textHash, voiceId);
    }

    try {
      const { buffer, isMock } = await this.callGeminiTts(text, voiceId);

      if (isMock) {
        // Never persist a mock placeholder as if it were real audio — once a
        // working GEMINI_API_KEY is in place, this exact (text, voiceId)
        // pair must still hit the live API rather than serve a stale,
        // unplayable cache entry forever. Release the claim so it doesn't
        // permanently block real generation for this pair.
        this.logger.warn(
          `Skipping TtsCache persistence for mock audio (text+voice hash: ${textHash})`,
        );
        await this.releaseClaim(textHash, voiceId);
        return { audioBuffer: buffer, cached: false };
      }

      const audioStorageKey = `tts/${textHash}-${voiceId}.mp3`;
      await this.storage.save(buffer, audioStorageKey);
      await this.prisma.ttsCache.update({
        where: { textHash_voiceId: { textHash, voiceId } },
        data: { audioStorageKey },
      });
      return { audioBuffer: buffer, cached: false };
    } catch (err) {
      await this.releaseClaim(textHash, voiceId);
      throw err;
    }
  }

  private async releaseClaim(textHash: string, voiceId: string): Promise<void> {
    await this.prisma.ttsCache
      .delete({ where: { textHash_voiceId: { textHash, voiceId } } })
      .catch(() => undefined);
  }

  private async waitForPendingEntry(
    textHash: string,
    voiceId: string,
  ): Promise<SynthesizeResult> {
    const maxAttempts = 20;
    const pollIntervalMs = 500;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
      const row = await this.prisma.ttsCache.findUnique({
        where: { textHash_voiceId: { textHash, voiceId } },
      });
      if (!row) {
        // The winning request failed or fell back to mock and released its
        // claim — nothing to wait for anymore.
        throw new Error(
          'Concurrent text-to-speech generation did not complete; please try again',
        );
      }
      if (row.audioStorageKey) {
        const audioBuffer = await this.storage.read(row.audioStorageKey);
        return { audioBuffer, cached: true };
      }
    }
    throw new Error(
      'Timed out waiting for a concurrent text-to-speech request to finish',
    );
  }

  private async callGeminiTts(
    text: string,
    voiceId: string,
  ): Promise<TtsAudio> {
    const ai = this.geminiClient.getAi();
    if (!ai) {
      this.logger.warn(
        'GEMINI_API_KEY is not defined. Using mock TTS fallback.',
      );
      return { buffer: await this.mockAudio(), isMock: true };
    }
    try {
      const response = await ai.models.generateContent({
        model: TTS_MODEL,
        contents: [{ parts: [{ text }] }],
        config: {
          responseModalities: ['AUDIO'],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: voiceId } },
          },
        },
      });
      const base64Audio =
        response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
      if (!base64Audio) {
        throw new Error('Gemini TTS returned no audio data');
      }
      // Gemini returns raw PCM (24kHz, mono, 16-bit) with no container/header.
      const pcmBuffer = Buffer.from(base64Audio, 'base64');
      const mp3Buffer = await this.transcodeToMp3(pcmBuffer);
      return { buffer: mp3Buffer, isMock: false };
    } catch (err) {
      this.logger.error(
        'Gemini TTS call failed, falling back to mock audio',
        err instanceof Error ? err.message : err,
      );
      return { buffer: await this.mockAudio(), isMock: true };
    }
  }

  private async transcodeToMp3(pcmBuffer: Buffer): Promise<Buffer> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-'));
    try {
      const rawPath = path.join(tmpDir, 'raw.pcm');
      const mp3Path = path.join(tmpDir, 'out.mp3');
      await fs.writeFile(rawPath, pcmBuffer);
      await new Promise<void>((resolve, reject) => {
        ffmpeg(rawPath)
          .inputFormat('s16le')
          .inputOptions(['-ar', '24000', '-ac', '1'])
          .audioCodec('libmp3lame')
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .save(mp3Path);
      });
      return await fs.readFile(mp3Path);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(
          `Failed to clean up temp dir ${tmpDir}`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  private async mockAudio(): Promise<Buffer> {
    // A real, valid (silent) MP3 — wired end-to-end without a GEMINI_API_KEY
    // the same way TranslationService's mock fallback stands in for a real
    // translation, but unlike plain placeholder text, this actually plays
    // in an <audio> element instead of erroring on malformed media.
    const silentPcm = Buffer.alloc(Math.floor(24000 * 0.3) * 2);
    return this.transcodeToMp3(silentPcm);
  }
}
