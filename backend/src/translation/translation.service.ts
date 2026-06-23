import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreditService } from '../credit/credit.service';
import { GeminiClientService } from '../gemini/gemini-client.service';
import { GoogleGenAI } from '@google/genai';

interface CreateVideoJobParams {
  fileName: string;
  inputStorageKey: string;
  targetLang: string;
  outputMode: string;
  dubVoiceId?: string | null;
}

const CHUNK_SIZE = 6000;

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);

  constructor(
    private prisma: PrismaService,
    private readonly creditService: CreditService,
    private readonly geminiClient: GeminiClientService,
  ) {}

  getHash(text: string): string {
    return this.geminiClient.getHash(text);
  }

  getAi(): GoogleGenAI | null {
    return this.geminiClient.getAi();
  }

  async translate(
    userId: string,
    text: string,
    sourceLang: string,
    targetLang: string,
    chargeCredit = true,
  ): Promise<string> {
    if (!text || text.trim() === '') {
      return '';
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    if (!user) {
      throw new Error('User not found');
    }
    if (user.credits <= 0) {
      throw new Error(
        'Tài khoản đã hết Credits. Vui lòng nạp thêm để tiếp tục dịch thuật!',
      );
    }

    const textHash = this.getHash(text);
    const sLang = sourceLang.toLowerCase().trim();
    const tLang = targetLang.toLowerCase().trim();

    let cachedTranslation = '';
    try {
      const cached = await this.prisma.translationCache.findUnique({
        where: {
          textHash_sourceLang_targetLang: {
            textHash,
            sourceLang: sLang,
            targetLang: tLang,
          },
        },
      });

      if (cached) {
        this.logger.log(`Cache hit for hash: ${textHash}`);
        cachedTranslation = cached.translatedText;
      }
    } catch (err) {
      this.logger.error('Failed to query database cache:', err);
    }

    if (cachedTranslation) {
      if (chargeCredit) {
        await this.creditService.deductCredit(userId, 1);
      }
      return cachedTranslation;
    }

    // Cache miss on the whole text: split into paragraph/sentence-aware
    // chunks (a "chunk" of 1 is the common case for short text) and
    // translate each sequentially, reusing the exact single-chunk
    // cache-lookup -> Gemini-call -> cache-write path per chunk.
    const chunks = this.splitIntoChunks(text);
    const translatedChunks: string[] = [];

    for (const chunk of chunks) {
      translatedChunks.push(
        await this.translateChunk(chunk, sourceLang, targetLang, sLang, tLang),
      );
    }

    const translatedText = translatedChunks.join('\n\n');

    if (translatedText && chargeCredit) {
      await this.creditService.deductCredit(userId, chunks.length);
    }

    return translatedText;
  }

  private async translateChunk(
    text: string,
    sourceLang: string,
    targetLang: string,
    sLang: string,
    tLang: string,
  ): Promise<string> {
    const textHash = this.getHash(text);

    try {
      const cached = await this.prisma.translationCache.findUnique({
        where: {
          textHash_sourceLang_targetLang: {
            textHash,
            sourceLang: sLang,
            targetLang: tLang,
          },
        },
      });

      if (cached) {
        this.logger.log(`Cache hit for hash: ${textHash}`);
        return cached.translatedText;
      }
    } catch (err) {
      this.logger.error('Failed to query database cache:', err);
    }

    let translatedText = '';

    const ai = this.geminiClient.getAi();
    if (ai) {
      try {
        const prompt = `Translate the following text from "${sourceLang}" to "${targetLang}".
Return ONLY the exact translated text. Do not add any introductory phrases, explanations, notes, or extra markdown formatting.
Maintain the original format and line breaks.

Text to translate:
${text}`;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: prompt,
        });

        translatedText = response.text?.trim() || '';
        this.logger.log(`Translated via Gemini API (Hash: ${textHash})`);
      } catch (err) {
        this.logger.error('Gemini API error, falling back to mock:', err);
        translatedText = this.mockTranslate(text, targetLang);
      }
    } else {
      translatedText = this.mockTranslate(text, targetLang);
    }

    if (translatedText) {
      try {
        await this.prisma.translationCache.create({
          data: {
            textHash,
            sourceText: text,
            translatedText,
            sourceLang: sLang,
            targetLang: tLang,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`Failed to write to cache: ${message}`);
      }
    }

    return translatedText;
  }

  private mockTranslate(text: string, targetLang: string): string {
    return `[Mock Dịch sang ${targetLang}]: ${text}`;
  }

  private splitIntoChunks(text: string): string[] {
    if (text.length <= CHUNK_SIZE) return [text];

    // 1. Split on paragraph boundaries first (never break mid-sentence as a first resort).
    const paragraphs = text.split(/\n{2,}/);
    const chunks: string[] = [];
    let current = '';

    for (const para of paragraphs) {
      const candidate = current ? `${current}\n\n${para}` : para;
      if (candidate.length <= CHUNK_SIZE) {
        current = candidate;
        continue;
      }
      if (current) chunks.push(current);
      // 2. A single paragraph longer than CHUNK_SIZE: fall back to sentence-boundary splitting.
      if (para.length > CHUNK_SIZE) {
        chunks.push(...this.splitParagraphBySentence(para));
        current = '';
      } else {
        current = para;
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  private splitParagraphBySentence(paragraph: string): string[] {
    const sentences = paragraph.split(/(?<=[.!?])\s+/);
    const chunks: string[] = [];
    let current = '';
    for (const sentence of sentences) {
      const candidate = current ? `${current} ${sentence}` : sentence;
      if (candidate.length <= CHUNK_SIZE) {
        current = candidate;
      } else {
        if (current) chunks.push(current);
        current = sentence; // a single sentence longer than CHUNK_SIZE is sent as-is (rare edge case)
      }
    }
    if (current) chunks.push(current);
    return chunks;
  }

  async createVideoJob(userId: string, params: CreateVideoJobParams) {
    const { fileName, inputStorageKey, targetLang, outputMode, dubVoiceId } =
      params;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    if (!user) {
      throw new Error('User not found');
    }
    if (user.credits < 10) {
      throw new Error(
        'Tài khoản cần có ít nhất 10 credits để thực hiện dịch video!',
      );
    }

    const job = await this.prisma.videoJob.create({
      data: {
        fileName,
        inputStorageKey,
        targetLang,
        outputMode,
        dubVoiceId: dubVoiceId || null,
        status: 'PENDING',
        progress: 0,
        stepDescription: 'Đang xếp hàng chờ xử lý...',
        userId,
      },
    });

    return job;
  }

  async getVideoJobs(userId: string) {
    return this.prisma.videoJob.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getVideoJobById(jobId: string) {
    return this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });
  }
}
