import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { CreditService } from '../credit/credit.service';
import { GeminiClientService } from '../gemini/gemini-client.service';
import { GoogleGenAI } from '@google/genai';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';
import { isRateLimitError } from './pipeline/rate-limit.util';
import { stripMarkdownFence } from './pipeline/json-parse.util';

interface CreateVideoJobParams {
  fileName: string;
  inputStorageKey: string;
  targetLang: string;
  outputMode: string;
  removeSourceSubs?: boolean;
}

const CHUNK_SIZE = 6000;

// ISO 639-1 codes matching the frontend source-language dropdown's existing
// options. Any auto-detect response outside this set is treated as an
// unreliable detection rather than risking a garbled silent mistranslation.
const SUPPORTED_LANG_CODES = ['en', 'vi', 'zh', 'ja'];

interface DetectAndTranslateResult {
  detectedLang: string;
  translatedText: string;
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
  ): Promise<{ translatedText: string; detectedLang: string | null }> {
    if (!text || text.trim() === '') {
      return { translatedText: '', detectedLang: null };
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    if (!user) {
      throw new Error('User not found');
    }
    if (user.credits <= 0) {
      throw new InsufficientCreditsError(
        'Tài khoản đã hết Credits. Vui lòng nạp thêm để tiếp tục dịch thuật!',
      );
    }

    const textHash = this.getHash(text);
    const sLang = sourceLang.toLowerCase().trim();
    const tLang = targetLang.toLowerCase().trim();
    const isAutoDetect = sLang === 'auto';

    // When sourceLang is 'auto', the whole-text cache lookup is skipped
    // entirely: a cache hit keyed on the literal string "auto" carries no
    // real detected language, and detection must run reliably whenever the
    // caller asked for it. Going through the per-chunk path instead always
    // resolves a real detectedLang (detected once on chunk 1, see below).
    if (!isAutoDetect) {
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
        await this.recordHistory(
          userId,
          text,
          cachedTranslation,
          sourceLang,
          targetLang,
        );
        return { translatedText: cachedTranslation, detectedLang: null };
      }
    }

    // Cache miss on the whole text: split into paragraph/sentence-aware
    // chunks (a "chunk" of 1 is the common case for short text) and
    // translate each sequentially, reusing the exact single-chunk
    // cache-lookup -> Gemini-call -> cache-write path per chunk.
    const chunks = this.splitIntoChunks(text);
    const translatedChunks: string[] = [];
    let resolvedDetectedLang: string | null = null;

    for (const chunk of chunks) {
      // Detect-once-reuse-for-rest: only the FIRST chunk runs the combined
      // detect+translate prompt when sourceLang is 'auto'. Once resolved,
      // subsequent chunks use the normal (non-auto) prompt with the
      // resolved language substituted in place of the literal "auto".
      if (isAutoDetect && resolvedDetectedLang === null) {
        const { detectedLang, translatedText } =
          await this.detectAndTranslateChunk(chunk, targetLang, tLang);
        resolvedDetectedLang = detectedLang;
        translatedChunks.push(translatedText);
        continue;
      }

      const effectiveSourceLang = isAutoDetect
        ? (resolvedDetectedLang as string)
        : sourceLang;
      const effectiveSLang = isAutoDetect
        ? (resolvedDetectedLang as string)
        : sLang;

      translatedChunks.push(
        await this.translateChunk(
          chunk,
          effectiveSourceLang,
          targetLang,
          effectiveSLang,
          tLang,
        ),
      );
    }

    const translatedText = translatedChunks.join('\n\n');

    if (translatedText && chargeCredit) {
      await this.creditService.deductCredit(userId, chunks.length);
    }

    if (translatedText) {
      const resolvedSourceLang = resolvedDetectedLang ?? sourceLang;
      await this.recordHistory(
        userId,
        text,
        translatedText,
        resolvedSourceLang,
        targetLang,
      );
    }

    return { translatedText, detectedLang: resolvedDetectedLang };
  }

  private async recordHistory(
    userId: string,
    sourceText: string,
    translatedText: string,
    sourceLang: string,
    targetLang: string,
  ): Promise<void> {
    try {
      await this.prisma.translationHistory.create({
        data: { userId, sourceText, translatedText, sourceLang, targetLang },
      });
      const count = await this.prisma.translationHistory.count({
        where: { userId },
      });
      if (count > 50) {
        const stale = await this.prisma.translationHistory.findMany({
          where: { userId },
          orderBy: { createdAt: 'asc' },
          take: count - 50,
          select: { id: true },
        });
        await this.prisma.translationHistory.deleteMany({
          where: { id: { in: stale.map((s) => s.id) } },
        });
      }
    } catch (err) {
      // History is a convenience feature, not core to translation — never let
      // a history-write failure surface as a translate-request failure.
      this.logger.warn('Failed to record translation history:', err);
    }
  }

  async getHistory(userId: string) {
    return this.prisma.translationHistory.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });
  }

  async clearHistory(userId: string): Promise<void> {
    await this.prisma.translationHistory.deleteMany({ where: { userId } });
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
          model: 'gemini-2.0-flash',
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

  private async detectAndTranslateChunk(
    text: string,
    targetLang: string,
    tLang: string,
  ): Promise<DetectAndTranslateResult> {
    const ai = this.geminiClient.getAi();

    if (!ai) {
      // No Gemini client configured: there is no real way to detect a
      // language without a model call, so mock-translate and surface the
      // honest "unknown" signal rather than guessing a fake detectedLang.
      throw new Error(
        'Could not reliably detect the source language; please select it manually',
      );
    }

    const prompt = `Detect the language of the following text (ISO 639-1 code, e.g. "en", "vi", "ja") and translate it to "${targetLang}".
Return ONLY a JSON object, no markdown fences, in this exact shape:
{"detectedLang":"<iso-code>","translatedText":"<the translated text>"}
Do not add any introductory phrases, explanations, notes, or extra markdown formatting in the translatedText value. Maintain the original format and line breaks within translatedText.

Text to translate:
${text}`;

    let parsed: DetectAndTranslateResult;
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: prompt,
      });
      const raw = response.text?.trim() || '';
      parsed = JSON.parse(stripMarkdownFence(raw)) as DetectAndTranslateResult;
      this.logger.log(`Detected language via Gemini: ${parsed.detectedLang}`);
    } catch (err) {
      this.logger.error(
        'Gemini detect+translate call failed or returned unparseable JSON:',
        err,
      );
      throw new Error(
        'Could not reliably detect the source language; please select it manually',
      );
    }

    const detectedLang = parsed.detectedLang?.toLowerCase().trim();
    if (!detectedLang || !SUPPORTED_LANG_CODES.includes(detectedLang)) {
      throw new Error(
        'Could not reliably detect the source language; please select it manually',
      );
    }

    const translatedText = parsed.translatedText?.trim() || '';

    if (translatedText) {
      const textHash = this.getHash(text);
      try {
        await this.prisma.translationCache.create({
          data: {
            textHash,
            sourceText: text,
            translatedText,
            sourceLang: detectedLang,
            targetLang: tLang,
          },
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Unknown error';
        this.logger.warn(`Failed to write to cache: ${message}`);
      }
    }

    return { detectedLang, translatedText };
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
    const { fileName, inputStorageKey, targetLang, outputMode, removeSourceSubs } =
      params;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { credits: true },
    });
    if (!user) {
      throw new Error('User not found');
    }
    if (user.credits < 10) {
      throw new InsufficientCreditsError(
        'Tài khoản cần có ít nhất 10 credits để thực hiện dịch video!',
      );
    }

    const job = await this.prisma.videoJob.create({
      data: {
        fileName,
        inputStorageKey,
        targetLang,
        outputMode,
        removeSourceSubs: removeSourceSubs ?? false,
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

  async cancelVideoJob(userId: string, jobId: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job không tồn tại');
    if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
    if (job.status !== 'PENDING' && job.status !== 'PROCESSING') {
      throw new BadRequestException('Chỉ huỷ được job đang chờ hoặc đang xử lý');
    }
    const result = await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ['PENDING', 'PROCESSING'] } },
      data: { status: 'CANCELLED', stepDescription: 'Đã huỷ bởi người dùng.', errorMessage: null },
    });
    if (result.count === 0) {
      throw new BadRequestException('Job đã hoàn tất hoặc đã thay đổi trạng thái, không thể huỷ');
    }
    return this.prisma.videoJob.findUnique({ where: { id: jobId } });
  }

  async deleteVideoJob(userId: string, jobId: string): Promise<string[]> {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job không tồn tại');
    if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
    if (job.status === 'PROCESSING') {
      throw new BadRequestException('Không thể xoá job đang xử lý. Hãy huỷ trước.');
    }
    await this.prisma.videoJob.delete({ where: { id: jobId } });
    return [job.inputStorageKey, job.subtitlesUrl, job.outputVideoUrl, job.outputAudioUrl].filter(
      (k): k is string => !!k,
    );
  }

  async translateBatch(
    texts: string[],
    sourceLang: string,
    targetLang: string,
  ): Promise<string[]> {
    if (texts.length === 0) return [];
    const ai = this.geminiClient.getAi();
    if (!ai) {
      throw new Error(
        'GEMINI_API_KEY chưa được cấu hình. Hãy thêm key vào file .env và khởi động lại backend.',
      );
    }
    const prompt = `Translate the following subtitle segments from "${sourceLang}" to "${targetLang}".
Return ONLY a JSON array of translated strings, in the same order, with no extra keys or wrapper.
Keep each translation concise and natural for subtitles (at most 12 words).

Input JSON array:
${JSON.stringify(texts)}`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: prompt,
    });
    const raw = response.text?.trim() || '';
    const cleaned = raw
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();
    const arrayMatch = cleaned.match(/\[[\s\S]*\]/);
    if (arrayMatch) {
      try {
        const parsed = JSON.parse(arrayMatch[0]) as unknown;
        if (
          Array.isArray(parsed) &&
          parsed.length === texts.length &&
          parsed.every((v) => typeof v === 'string')
        ) {
          this.logger.log(`Batch-translated ${texts.length} segments in 1 API call`);
          return parsed as string[];
        }
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
          this.logger.warn(
            `Gemini returned ${(parsed as string[]).length} translations for ${texts.length} segments — padding/trimming`,
          );
          return texts.map((_, i) => (parsed as string[])[i] ?? texts[i]);
        }
      } catch {
        // fall through to throw
      }
    }
    this.logger.error(`Gemini batch response unparseable. Raw: ${raw.slice(0, 300)}`);
    throw new Error(`Gemini trả về định dạng không hợp lệ. Raw: ${raw.slice(0, 200)}`);
  }
}
