import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../../prisma.service';
import { TranslationService } from '../translation.service';
import { CreditService } from '../../credit/credit.service';
import {
  STORAGE_PROVIDER,
  type IStorageProvider,
} from '../../storage/storage.interface';
import { VIDEO_PIPELINE_QUEUE } from '../../queue/queue.module';
import { extractAudio } from './audio-extractor';
import { transcribeAudio } from './stt.service';
import { translateSegments, buildSrt, parseStoredSegments } from './subtitle.service';
import { burnInSubtitles, blurSubtitleArea } from './burn-in.service';
import { detectSubtitleRegion } from './subtitle-region.service';
import {
  isValidOutputMode,
  outputModeIncludesBurn,
  outputModeProducesVideo,
} from './output-mode';

interface VideoPipelineJobData {
  jobId: string;
}

@Injectable()
@Processor(VIDEO_PIPELINE_QUEUE, { concurrency: 2 })
export class VideoPipelineWorker extends WorkerHost {
  private readonly logger = new Logger(VideoPipelineWorker.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly translationService: TranslationService,
    @Inject(STORAGE_PROVIDER) private readonly storage: IStorageProvider,
    private readonly creditService: CreditService,
  ) {
    super();
  }

  async process(job: Job<VideoPipelineJobData>): Promise<void> {
    if (job.name === 'process-video-burn') {
      return this.runBurnPhase(job.data.jobId);
    }
    return this.runTranslatePhase(job.data.jobId);
  }

  /**
   * Phase A: prep -> extractAudio -> STT -> translate -> persist
   * translatedSegments -> AWAITING_REVIEW. No burn, no credit deduction.
   */
  private async runTranslatePhase(jobId: string): Promise<void> {
    const videoJob = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });
    if (!videoJob) {
      this.logger.warn(`VideoJob ${jobId} not found, skipping`);
      return;
    }
    // R1: a duplicate enqueue of a job that already finished translating (or
    // was cancelled) must not re-translate / re-persist segments.
    if (
      videoJob.status === 'COMPLETED' ||
      videoJob.status === 'CANCELLED' ||
      videoJob.status === 'AWAITING_REVIEW'
    ) {
      this.logger.log(
        `VideoJob ${jobId} already ${videoJob.status}, skipping duplicate enqueue`,
      );
      return;
    }
    if (!videoJob.inputStorageKey) {
      throw new Error('Video job has no uploaded input file');
    }

    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `videojob-${jobId}-`),
    );
    try {
      await this.updateJob(jobId, {
        status: 'PROCESSING',
        progress: 5,
        stepDescription: 'Đang chuẩn bị xử lý...',
      });

      const inputBuffer = await this.storage.read(videoJob.inputStorageKey);
      const inputPath = path.join(
        tmpDir,
        'input' + (path.extname(videoJob.fileName) || '.mp4'),
      );
      await fs.writeFile(inputPath, inputBuffer);

      await this.assertNotCancelled(jobId);
      await this.updateJob(jobId, {
        progress: 15,
        stepDescription: 'Đang trích xuất âm thanh...',
      });
      const audioPath = path.join(tmpDir, 'audio.mp3');
      await extractAudio(inputPath, audioPath);

      await this.assertNotCancelled(jobId);
      await this.updateJob(jobId, {
        progress: 40,
        stepDescription: 'Đang nhận dạng giọng nói...',
      });
      const audioBuffer = await fs.readFile(audioPath);
      const transcript = await transcribeAudio(null, audioBuffer, audioPath);
      await this.prisma.videoJob.update({
        where: { id: jobId },
        // Prisma's Json input type requires an index signature; Transcript is a
        // plain-data interface, so round-trip it through JSON to satisfy the type.
        data: {
          transcript: JSON.parse(
            JSON.stringify(transcript),
          ) as Prisma.InputJsonValue,
        },
      });

      await this.assertNotCancelled(jobId);
      await this.updateJob(jobId, {
        progress: 70,
        stepDescription: 'Đang dịch phụ đề bằng Gemini...',
      });
      const { segments: translatedSegments, untranslatedCount } =
        await translateSegments(
          this.translationService,
          videoJob.userId,
          transcript.segments,
          transcript.language,
          videoJob.targetLang,
          async (done, total) => {
            const segProgress = 70 + Math.round((done / total) * 10);
            await this.updateJob(jobId, {
              progress: segProgress,
              stepDescription: `Đang dịch phụ đề... (${done}/${total})`,
            });
          },
        );

      if (untranslatedCount > 0) {
        this.logger.warn(
          `VideoJob ${jobId}: ${untranslatedCount} segments could not be translated (left as source)`,
        );
      }
      await this.prisma.videoJob.update({
        where: { id: jobId },
        data: {
          translatedSegments: JSON.parse(
            JSON.stringify(translatedSegments),
          ) as Prisma.InputJsonValue,
          // Written unconditionally (not just when > 0) so a BullMQ retry
          // that produces a clean result resets a stale count from a prior
          // failed attempt.
          untranslatedSegmentCount: untranslatedCount,
        },
      });
      await this.updateJob(jobId, {
        status: 'AWAITING_REVIEW',
        progress: 85,
        stepDescription: 'Đã dịch xong — chờ bạn kiểm tra & xác nhận phụ đề.',
      });

      this.logger.log(`VideoJob ${jobId} translated, awaiting review`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(
          `Failed to clean up temp dir ${tmpDir}`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  /**
   * Phase B: rebuild SRT from the (possibly edited) stored segments ->
   * optional blur -> burn-in -> save video -> COMPLETED. The 10-credit
   * charge already happened at job creation (createVideoJob reserves it).
   */
  private async runBurnPhase(jobId: string): Promise<void> {
    const videoJob = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
    });
    if (!videoJob) {
      this.logger.warn(`VideoJob ${jobId} not found, skipping`);
      return;
    }
    if (videoJob.status === 'COMPLETED') {
      this.logger.log(
        `VideoJob ${jobId} already COMPLETED, skipping duplicate enqueue`,
      );
      return;
    }
    if (videoJob.status === 'CANCELLED') {
      this.logger.log(`VideoJob ${jobId} is CANCELLED, skipping burn phase`);
      return;
    }
    if (!videoJob.translatedSegments) {
      throw new Error(
        `VideoJob ${jobId} has no translatedSegments to resume from (not yet reviewed)`,
      );
    }
    if (!videoJob.inputStorageKey) {
      throw new Error('Video job has no uploaded input file');
    }

    // Confirm endpoint already flips the status to PROCESSING; keep this
    // idempotent in case the burn worker retries. Check cancellation BEFORE
    // the overwrite so a job cancelled mid-burn is never resurrected to
    // PROCESSING (and never charged).
    await this.assertNotCancelled(jobId);
    await this.updateJob(jobId, {
      status: 'PROCESSING',
      progress: 86,
      stepDescription: 'Đang chuẩn bị chèn phụ đề...',
    });

    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `videojob-${jobId}-burn-`),
    );
    try {
      const stored = parseStoredSegments(videoJob.translatedSegments);
      const srtContent = buildSrt(stored);
      const srtKey = `outputs/${jobId}/subtitles.srt`;
      await this.storage.save(Buffer.from(srtContent, 'utf-8'), srtKey);

      const inputBuffer = await this.storage.read(videoJob.inputStorageKey);
      const inputPath = path.join(
        tmpDir,
        'input' + (path.extname(videoJob.fileName) || '.mp4'),
      );
      await fs.writeFile(inputPath, inputBuffer);

      // outputMode is a plain String column (no DB-level enum), so a
      // manually-edited row or pre-validation legacy row could in theory
      // hold a value outside OUTPUT_MODES — fail the job explicitly rather
      // than let an invalid mode silently fall through every includes-check.
      if (!isValidOutputMode(videoJob.outputMode)) {
        throw new Error(
          `Invalid outputMode in VideoJob: "${videoJob.outputMode}"`,
        );
      }
      const outputMode = videoJob.outputMode;
      let outputVideoKey: string | null = null;

      let videoStreamSourcePath = inputPath;
      if (outputModeIncludesBurn(outputMode)) {
        let burnSource = inputPath;
        let pendingBlurStatus: string | undefined;
        if (videoJob.removeSourceSubs) {
          await this.updateJob(jobId, {
            progress: 88,
            stepDescription: 'Đang dò vị trí phụ đề gốc...',
          });
          const { region, failedDueToError } = await detectSubtitleRegion(
            this.translationService.getAi(),
            inputPath,
            tmpDir,
          );
          if (region) {
            await this.updateJob(jobId, {
              progress: 90,
              stepDescription: 'Đang làm mờ phụ đề gốc...',
            });
            const blurredPath = path.join(tmpDir, 'blurred.mp4');
            await blurSubtitleArea(inputPath, blurredPath, region);
            burnSource = blurredPath;
            pendingBlurStatus = 'applied';
          } else if (failedDueToError) {
            pendingBlurStatus = 'skipped_error';
            this.logger.warn(
              `VideoJob ${jobId}: subtitle-region detection FAILED (API), blur skipped — original subtitles NOT removed despite request`,
            );
          } else {
            pendingBlurStatus = 'skipped_no_subtitle';
            this.logger.log(
              `VideoJob ${jobId}: no burned-in subtitle detected, skipping blur step`,
            );
          }
        }
        // Cancellation check BEFORE persisting the degraded-state write, same
        // guard used for the PROCESSING overwrite below (C1 pattern) — a job
        // cancelled mid-detection must not have blurStatus written onto it.
        await this.assertNotCancelled(jobId);
        if (pendingBlurStatus) {
          await this.prisma.videoJob.update({
            where: { id: jobId },
            data: { blurStatus: pendingBlurStatus },
          });
        }
        await this.updateJob(jobId, {
          progress: 92,
          stepDescription: 'Đang chèn cứng phụ đề vào video...',
        });
        const srtPath = path.join(tmpDir, 'subtitles.srt');
        await fs.writeFile(srtPath, srtContent, 'utf-8');
        const burnedVideoPath = path.join(tmpDir, 'burned.mp4');
        await burnInSubtitles(burnSource, srtPath, burnedVideoPath);
        videoStreamSourcePath = burnedVideoPath;
      }

      if (outputModeProducesVideo(outputMode)) {
        const outputVideoBuffer = await fs.readFile(videoStreamSourcePath);
        outputVideoKey = `outputs/${jobId}/video.mp4`;
        await this.storage.save(outputVideoBuffer, outputVideoKey);
      }

      const completionMessage = 'Hoàn tất! Phụ đề đã sẵn sàng tải xuống.';

      // Atomic guard against double-processing (concurrent worker retry,
      // duplicate enqueue): the 10-credit charge already happened at job
      // creation (createVideoJob reserves it), so this only flips status.
      const result = await this.prisma.videoJob.updateMany({
        where: { id: jobId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        data: {
          status: 'COMPLETED',
          progress: 100,
          stepDescription: completionMessage,
          subtitlesUrl: srtKey,
          outputVideoUrl: outputVideoKey,
          outputAudioUrl: null,
          errorMessage: null,
        },
      });
      if (result.count === 0) {
        this.logger.warn(
          `VideoJob ${jobId} was already completed by a concurrent run; skipping duplicate update`,
        );
      }

      this.logger.log(`VideoJob ${jobId} completed`);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true }).catch((err) => {
        this.logger.warn(
          `Failed to clean up temp dir ${tmpDir}`,
          err instanceof Error ? err.message : err,
        );
      });
    }
  }

  @OnWorkerEvent('failed')
  async onFailed(
    job: Job<VideoPipelineJobData> | undefined,
    error: Error,
  ): Promise<void> {
    if (!job) return;
    const attemptsMax = job.opts?.attempts ?? 1;
    if (job.attemptsMade < attemptsMax) {
      this.logger.warn(
        `VideoJob ${job.data.jobId} attempt ${job.attemptsMade}/${attemptsMax} failed, will retry: ${error.message}`,
      );
      return;
    }
    this.logger.error(
      `VideoJob ${job.data.jobId} failed permanently after ${attemptsMax} attempts`,
      error.stack ?? error.message,
    );
    if (error.message === 'JOB_CANCELLED') return;
    const friendlyMessage = this.buildFriendlyErrorMessage(error);
    let result: { count: number } = { count: 0 };
    try {
      result = await this.prisma.videoJob.updateMany({
        where: { id: job.data.jobId, status: { notIn: ['COMPLETED', 'CANCELLED'] } },
        data: { status: 'FAILED', errorMessage: friendlyMessage },
      });
    } catch (err) {
      this.logger.error('Failed to persist FAILED status', err);
      return;
    }
    // Exactly-once: only refund when this call actually flipped the status
    // to FAILED (a concurrent cancel/complete would make count === 0).
    if (result.count > 0) {
      const failedJob = await this.prisma.videoJob.findUnique({
        where: { id: job.data.jobId },
        select: { userId: true },
      });
      if (failedJob) {
        await this.creditService.refundCredit(failedJob.userId, 10);
      }
    }
  }

  private async assertNotCancelled(jobId: string): Promise<void> {
    const job = await this.prisma.videoJob.findUnique({
      where: { id: jobId },
      select: { status: true },
    });
    if (job?.status === 'CANCELLED') {
      throw new Error('JOB_CANCELLED');
    }
  }

  private buildFriendlyErrorMessage(error: Error): string {
    const msg = error.message;
    // Never surface absolute filesystem paths to the end user.
    if (/daily quota exhausted|billing details|check your plan|exceeded your current quota/i.test(msg)) {
      return 'Đã hết quota Gemini API hôm nay. Vui lòng thử lại vào ngày mai hoặc nâng cấp gói API.';
    }
    if (/rate limit|quota|429|RESOURCE_EXHAUSTED/i.test(msg)) {
      return 'Lỗi giới hạn lượt gọi API (rate limit). Vui lòng thử lại sau vài phút.';
    }
    if (/audio file too large/i.test(msg)) {
      return 'Video quá dài — file âm thanh vượt giới hạn 14 MB của Gemini API. Vui lòng thử video ngắn hơn.';
    }
    if (/GEMINI_API_KEY/i.test(msg)) {
      return 'Lỗi cấu hình: GEMINI_API_KEY chưa được thiết lập trong backend. Vui lòng liên hệ quản trị viên.';
    }
    if (/speech.to.text failed|stt/i.test(msg)) {
      const cause = msg.replace(/^.*speech.to.text failed:\s*/i, '').slice(0, 120);
      return `Lỗi nhận dạng giọng nói (STT): ${cause}`;
    }
    if (/gemini.*định dạng không hợp lệ|unparseable/i.test(msg)) {
      return 'Gemini trả về kết quả không hợp lệ. Vui lòng thử lại sau vài giây.';
    }
    return 'Xử lý video thất bại. Vui lòng thử lại hoặc liên hệ hỗ trợ.';
  }

  private async updateJob(
    jobId: string,
    data: { status?: string; progress: number; stepDescription: string },
  ): Promise<void> {
    await this.prisma.videoJob.update({ where: { id: jobId }, data });
  }
}
