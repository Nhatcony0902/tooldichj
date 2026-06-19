import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { GoogleGenAI } from '@google/genai';
import * as crypto from 'crypto';
import { CreateVideoJobDto } from './dto/create-video-job.dto';

@Injectable()
export class TranslationService {
  private readonly logger = new Logger(TranslationService.name);
  private ai: GoogleGenAI | null = null;

  constructor(private prisma: PrismaService) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
      this.logger.log('Gemini API initialized successfully.');
    } else {
      this.logger.warn(
        'GEMINI_API_KEY is not defined. Using Mock Translator fallback.',
      );
    }
  }

  // Tạo hash SHA256 cho văn bản để lập chỉ mục tìm kiếm cache
  private getHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }

  async translate(
    userId: string,
    text: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<string> {
    if (!text || text.trim() === '') {
      return '';
    }

    // 0. Kiểm tra credits của người dùng
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

    // 1. Kiểm tra cache trong DB
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

    // Nếu có cache, trả về luôn và trừ credit
    if (cachedTranslation) {
      await this.deductCredit(userId, 1);
      return cachedTranslation;
    }

    // 2. Dịch thuật (Gemini hoặc Fallback)
    let translatedText = '';

    if (this.ai) {
      try {
        const prompt = `Translate the following text from "${sourceLang}" to "${targetLang}". 
Return ONLY the exact translated text. Do not add any introductory phrases, explanations, notes, or extra markdown formatting. 
Maintain the original format and line breaks.

Text to translate:
${text}`;

        const response = await this.ai.models.generateContent({
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

    // 3. Lưu vào cache và trừ credit
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

      await this.deductCredit(userId, 1);
    }

    return translatedText;
  }

  private async deductCredit(userId: string, amount: number) {
    try {
      await this.prisma.user.update({
        where: { id: userId },
        data: { credits: { decrement: amount } },
      });
      this.logger.log(`Deducted ${amount} credit(s) from user: ${userId}`);
    } catch (err) {
      this.logger.error(`Failed to deduct credits for user ${userId}:`, err);
    }
  }

  private mockTranslate(text: string, targetLang: string): string {
    return `[Mock Dịch sang ${targetLang}]: ${text}`;
  }

  async createVideoJob(userId: string, dto: CreateVideoJobDto) {
    const { fileName, targetLang } = dto;

    // Kiểm tra credits của người dùng (dịch video cần ít nhất 10 credits)
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

    // Tạo job mới trong hàng đợi PENDING
    const job = await this.prisma.videoJob.create({
      data: {
        fileName,
        targetLang,
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
}
