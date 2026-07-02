import { Injectable, Logger, NotFoundException, ForbiddenException, BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreditService } from '../credit/credit.service';
import { GeminiClientService } from '../gemini/gemini-client.service';
import { GoogleGenAI } from '@google/genai';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';
import { isRateLimitError } from './pipeline/rate-limit.util';
import { IncompleteTranslationError } from './pipeline/incomplete-translation.error';
import { stripMarkdownFence } from './pipeline/json-parse.util';
import { parseStoredSegments, applySegmentEdits } from './pipeline/subtitle.service';
import { SegmentEditDto } from './dto/update-segments.dto';

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
    const VIDEO_JOB_COST = 10;

    return this.prisma.$transaction(async (tx) => {
      // Reserve credits and create the job row atomically in the same
      // transaction: an atomic conditional decrement prevents concurrent
      // job creations from over-committing the same balance.
      const result = await tx.user.updateMany({
        where: { id: userId, credits: { gte: VIDEO_JOB_COST } },
        data: { credits: { decrement: VIDEO_JOB_COST } },
      });
      if (result.count === 0) {
        throw new InsufficientCreditsError(
          'Tài khoản cần có ít nhất 10 credits để thực hiện dịch video!',
        );
      }
      return tx.videoJob.create({
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
    });
  }

  // Guarded PENDING -> FAILED transition used when enqueueing the initial
  // video-processing job fails after the job row + credit reservation were
  // already committed. Exactly-once refund: only reached when updateMany
  // actually flipped the status.
  async failOrphanedVideoJob(jobId: string): Promise<void> {
    const result = await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: 'PENDING' },
      data: {
        status: 'FAILED',
        errorMessage: 'Không thể xếp hàng xử lý. Vui lòng thử lại.',
      },
    });
    if (result.count > 0) {
      const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
      if (job) {
        await this.creditService.refundCredit(job.userId, 10);
      }
    }
  }

  // Guarded PROCESSING -> AWAITING_REVIEW rollback used when enqueueing the
  // burn phase fails after confirmVideoJob already advanced the job. No
  // credit refund here: confirm doesn't charge, Phase 1 already charged at
  // creation. A concurrent duplicate confirm attempt safely no-ops (count === 0).
  async rollbackToAwaitingReview(jobId: string): Promise<void> {
    await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: 'PROCESSING' },
      data: { status: 'AWAITING_REVIEW' },
    });
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
    if (!['PENDING', 'PROCESSING', 'AWAITING_REVIEW'].includes(job.status)) {
      throw new BadRequestException('Chỉ huỷ được job đang chờ, đang xử lý hoặc đang chờ duyệt');
    }
    const result = await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: { in: ['PENDING', 'PROCESSING', 'AWAITING_REVIEW'] } },
      data: { status: 'CANCELLED', stepDescription: 'Đã huỷ bởi người dùng.', errorMessage: null },
    });
    if (result.count === 0) {
      throw new BadRequestException('Job đã hoàn tất hoặc đã thay đổi trạng thái, không thể huỷ');
    }
    // Exactly-once: only reached when updateMany actually flipped the status.
    await this.creditService.refundCredit(userId, 10);
    return this.prisma.videoJob.findUnique({ where: { id: jobId } });
  }

  async getReviewSegments(userId: string, jobId: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job không tồn tại');
    if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
    if (job.status !== 'AWAITING_REVIEW') {
      throw new BadRequestException('Job chưa ở trạng thái chờ duyệt');
    }
    const segments = parseStoredSegments(job.translatedSegments).map((s, index) => ({
      index, start: s.start, end: s.end, text: s.text, translatedText: s.translatedText,
    }));
    return segments;
  }

  async saveReviewSegments(userId: string, jobId: string, edits: SegmentEditDto[]) {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job không tồn tại');
    if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
    if (job.status !== 'AWAITING_REVIEW') {
      throw new BadRequestException('Job chưa ở trạng thái chờ duyệt');
    }
    let merged;
    try {
      const stored = parseStoredSegments(job.translatedSegments);
      merged = applySegmentEdits(stored, edits);   // throws on malformed edits (R3)
    } catch {
      throw new BadRequestException('Danh sách phụ đề không hợp lệ');
    }
    await this.prisma.videoJob.update({
      where: { id: jobId },
      data: {
        translatedSegments: JSON.parse(JSON.stringify(merged)) as Prisma.InputJsonValue,
        // The user just reviewed and confirmed every segment's text — the
        // pre-review "N segments left untranslated" count is no longer a
        // reliable signal (edits may have fixed them) and would otherwise
        // show a stale warning on the completed video (B1 follow-up).
        untranslatedSegmentCount: 0,
      },
    });
  }

  // Atomic transition; returns the job so the controller can enqueue the burn phase.
  async confirmVideoJob(userId: string, jobId: string) {
    const job = await this.prisma.videoJob.findUnique({ where: { id: jobId } });
    if (!job) throw new NotFoundException('Job không tồn tại');
    if (job.userId !== userId) throw new ForbiddenException('Không có quyền truy cập');
    const result = await this.prisma.videoJob.updateMany({
      where: { id: jobId, status: 'AWAITING_REVIEW' },
      data: { status: 'PROCESSING', progress: 88, stepDescription: 'Đang hoàn tất video...' },
    });
    if (result.count === 0) {
      throw new BadRequestException('Job đã được xác nhận hoặc đã thay đổi trạng thái');
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
        if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
          const arr = parsed as string[];
          // An item only counts as "incomplete" when its SOURCE text had
          // actual content — a genuinely empty/whitespace source segment
          // legitimately translates to an empty string.
          const complete =
            arr.length === texts.length &&
            arr.every((t, i) => t.trim().length > 0 || !texts[i].trim());
          if (complete) {
            this.logger.log(`Batch-translated ${texts.length} segments in 1 API call`);
            return arr;
          }
          this.logger.warn(
            `Gemini translate incomplete: expected ${texts.length}, got ${arr.length} usable items. Will retry.`,
          );
          const partial = texts.map((_, i) => (arr[i]?.trim() ? arr[i] : ''));
          throw new IncompleteTranslationError(partial, texts.length);
        }
      } catch (err) {
        // Re-throw an incomplete-translation signal so the caller can retry
        // the whole batch; only a genuine JSON.parse failure falls through
        // to the generic "unparseable" error below.
        if (err instanceof IncompleteTranslationError) throw err;
      }
    }
    this.logger.error(`Gemini batch response unparseable. Raw: ${raw.slice(0, 300)}`);
    throw new Error(`Gemini trả về định dạng không hợp lệ. Raw: ${raw.slice(0, 200)}`);
  }
}
