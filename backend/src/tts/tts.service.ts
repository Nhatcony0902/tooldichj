import { Inject, Injectable, Logger } from '@nestjs/common';
import { MsEdgeTTS, OUTPUT_FORMAT, ProsodyOptions } from 'msedge-tts';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../prisma.service';
import { CreditService } from '../credit/credit.service';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';
import {
  STORAGE_PROVIDER,
  type IStorageProvider,
} from '../storage/storage.interface';
import { VOICE_CATALOG, isValidVoiceId } from './voices.config';
import { prosodySignature } from './prosody.util';

export interface SynthesizeResult {
  audioBuffer: Buffer;
  cached: boolean;
}

// Expose the catalog so the controller can serve it without importing voices.config directly.
export { VOICE_CATALOG };

const SAMPLE_PHRASE = 'Xin chào! Đây là giọng đọc thử nghiệm.';

@Injectable()
export class TtsService {
  private readonly logger = new Logger(TtsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
  ) {}

  async synthesize(
    userId: string,
    text: string,
    voiceId: string,
    chargeCredit = true,
    prosody?: ProsodyOptions,
  ): Promise<SynthesizeResult> {
    if (!text || !text.trim()) {
      throw new Error('Text is required');
    }
    if (!isValidVoiceId(voiceId)) {
      throw new Error(`Unknown voiceId "${voiceId}"`);
    }

    if (chargeCredit) {
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { credits: true },
      });
      if (!user) throw new Error('User not found');
      if (user.credits <= 0) {
        throw new InsufficientCreditsError(
          'Tài khoản đã hết Credits. Vui lòng nạp thêm để tiếp tục!',
        );
      }
    }

    const result = await this.synthesizeOrServeFromCache(text, voiceId, prosody);
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

  private hashText(text: string): string {
    // Simple djb2 hash — good enough for cache keys (same algo as GeminiClientService).
    let h = 5381;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) + h) ^ text.charCodeAt(i);
      h = h >>> 0;
    }
    return h.toString(16);
  }

  private async synthesizeOrServeFromCache(
    text: string,
    voiceId: string,
    prosody?: ProsodyOptions,
  ): Promise<SynthesizeResult> {
    // Folding the prosody signature into the hashed input means a
    // prosody-adjusted synthesis never collides with the plain-text cache
    // entry for the same words — prosodySignature(undefined) === '', so
    // callers that never pass prosody (getSample, manual synthesize) hash
    // identically to before this feature existed.
    const textHash = this.hashText(text + prosodySignature(prosody));

    const cached = await this.prisma.ttsCache.findUnique({
      where: { textHash_voiceId: { textHash, voiceId } },
    });
    if (cached?.audioStorageKey) {
      this.logger.log(`TTS cache hit (hash: ${textHash}, voice: ${voiceId})`);
      const audioBuffer = await this.storage.read(cached.audioStorageKey);
      return { audioBuffer, cached: true };
    }

    // Claim the slot to prevent concurrent callers from double-synthesizing.
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
      const audioBuffer = await this.callEdgeTts(text, voiceId, prosody);
      const audioStorageKey = `tts/edge-${textHash}-${voiceId}.mp3`;
      await this.storage.save(audioBuffer, audioStorageKey);
      await this.prisma.ttsCache.update({
        where: { textHash_voiceId: { textHash, voiceId } },
        data: { audioStorageKey },
      });
      return { audioBuffer, cached: false };
    } catch (err) {
      await this.releaseClaim(textHash, voiceId);
      throw err;
    }
  }

  private async callEdgeTts(
    text: string,
    voiceId: string,
    prosody?: ProsodyOptions,
  ): Promise<Buffer> {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceId, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const chunks: Buffer[] = [];
    await new Promise<void>((resolve, reject) => {
      const { audioStream } = tts.toStream(text, prosody);
      audioStream.on('data', (chunk: Buffer) => chunks.push(chunk));
      audioStream.on('end', resolve);
      audioStream.on('error', (err: Error) => reject(err));
    });
    const result = Buffer.concat(chunks);
    if (result.length === 0) {
      // msedge-tts WebSocket can drop silently (no error event) and resolve
      // with 0 bytes. Throw so withRetry can retry and callers don't write an
      // invalid MP3 that crashes ffprobe downstream.
      throw new Error('Edge TTS returned no audio data');
    }
    this.logger.log(
      `Edge TTS synthesized ${result.length} bytes for voice "${voiceId}"`,
    );
    return result;
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
        throw new Error(
          'Concurrent TTS generation did not complete; please try again',
        );
      }
      if (row.audioStorageKey) {
        const audioBuffer = await this.storage.read(row.audioStorageKey);
        return { audioBuffer, cached: true };
      }
    }
    throw new Error('Timed out waiting for a concurrent TTS request to finish');
  }

  /** Fallback: return a short silent MP3 when Edge TTS is unavailable. */
  async makeSilence(durationSec: number): Promise<Buffer> {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tts-silence-'));
    try {
      const { default: ffmpeg } = await import('fluent-ffmpeg');
      const sampleRate = 24000;
      const sampleCount = Math.round(durationSec * sampleRate);
      const rawPath = path.join(tmpDir, 'silent.pcm');
      const mp3Path = path.join(tmpDir, 'silent.mp3');
      await fs.writeFile(rawPath, Buffer.alloc(sampleCount * 2));
      await new Promise<void>((resolve, reject) => {
        ffmpeg(rawPath)
          .inputFormat('s16le')
          .inputOptions(['-ar', `${sampleRate}`, '-ac', '1'])
          .audioCodec('libmp3lame')
          .on('end', () => resolve())
          .on('error', (err: Error) => reject(err))
          .save(mp3Path);
      });
      return await fs.readFile(mp3Path);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
