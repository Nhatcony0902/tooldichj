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

      if (chargeCredit) {
        await this.creditService.deductCredit(userId, 1);
      }
    }

    return translatedText;
  }

  private mockTranslate(text: string, targetLang: string): string {
    return `[Mock Dịch sang ${targetLang}]: ${text}`;
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
