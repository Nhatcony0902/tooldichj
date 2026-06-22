import { Inject, Injectable, Logger } from '@nestjs/common';
import { OnWorkerEvent, Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Prisma } from '@prisma/client';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { PrismaService } from '../../prisma.service';
import { TranslationService } from '../translation.service';
import {
  STORAGE_PROVIDER,
  type IStorageProvider,
} from '../../storage/storage.interface';
import { VIDEO_PIPELINE_QUEUE } from '../../queue/queue.module';
import { extractAudio } from './audio-extractor';
import { transcribeAudio } from './stt.service';
import { translateSegments, buildSrt } from './subtitle.service';
import { burnInSubtitles } from './burn-in.service';

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
  ) {
    super();
  }

  async process(job: Job<VideoPipelineJobData>): Promise<void> {
    const { jobId } = job.data;
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

      await this.updateJob(jobId, {
        progress: 15,
        stepDescription: 'Đang trích xuất âm thanh...',
      });
      const audioPath = path.join(tmpDir, 'audio.mp3');
      await extractAudio(inputPath, audioPath);

      await this.updateJob(jobId, {
        progress: 40,
        stepDescription: 'Đang nhận dạng giọng nói...',
      });
      const audioBuffer = await fs.readFile(audioPath);
      const transcript = await transcribeAudio(
        this.translationService.getAi(),
        audioBuffer,
        audioPath,
      );
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

      await this.updateJob(jobId, {
        progress: 70,
        stepDescription: 'Đang dịch phụ đề bằng Gemini...',
      });
      const translatedSegments = await translateSegments(
        this.translationService,
        videoJob.userId,
        transcript.segments,
        transcript.language,
        videoJob.targetLang,
      );
      const srtContent = buildSrt(translatedSegments);
      const srtKey = `outputs/${jobId}/subtitles.srt`;
      await this.storage.save(Buffer.from(srtContent, 'utf-8'), srtKey);

      let outputVideoKey: string | null = null;
      if (videoJob.outputMode !== 'srt') {
        await this.updateJob(jobId, {
          progress: 90,
          stepDescription: 'Đang chèn cứng phụ đề vào video...',
        });
        const srtPath = path.join(tmpDir, 'subtitles.srt');
        await fs.writeFile(srtPath, srtContent, 'utf-8');
        const outputVideoPath = path.join(tmpDir, 'output.mp4');
        await burnInSubtitles(inputPath, srtPath, outputVideoPath);
        const outputVideoBuffer = await fs.readFile(outputVideoPath);
        outputVideoKey = `outputs/${jobId}/video.mp4`;
        await this.storage.save(outputVideoBuffer, outputVideoKey);
      }

      await this.prisma.$transaction(async (tx) => {
        // Atomic guard against double-processing (concurrent worker retry,
        // duplicate enqueue): only the update that actually flips status
        // away from COMPLETED deducts credits. A second concurrent run
        // matches 0 rows and skips the charge entirely.
        const result = await tx.videoJob.updateMany({
          where: { id: jobId, status: { not: 'COMPLETED' } },
          data: {
            status: 'COMPLETED',
            progress: 100,
            stepDescription: 'Hoàn tất! Phụ đề đã sẵn sàng tải xuống.',
            subtitlesUrl: srtKey,
            outputVideoUrl: outputVideoKey,
            errorMessage: null,
          },
        });
        if (result.count === 0) {
          this.logger.warn(
            `VideoJob ${jobId} was already completed by a concurrent run; skipping duplicate credit deduction`,
          );
          return;
        }
        await tx.user.update({
          where: { id: videoJob.userId },
          data: { credits: { decrement: 10 } },
        });
      });

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
      `VideoJob ${job.data.jobId} failed permanently after ${attemptsMax} attempts: ${error.message}`,
    );
    await this.prisma.videoJob
      .update({
        where: { id: job.data.jobId },
        data: {
          status: 'FAILED',
          // The raw error (logged above) can contain absolute filesystem
          // paths; never surface that to the end user via the API response.
          errorMessage:
            'Xử lý video thất bại. Vui lòng thử lại hoặc liên hệ hỗ trợ.',
        },
      })
      .catch((err: unknown) =>
        this.logger.error('Failed to persist FAILED status', err),
      );
  }

  private async updateJob(
    jobId: string,
    data: { status?: string; progress: number; stepDescription: string },
  ): Promise<void> {
    await this.prisma.videoJob.update({ where: { id: jobId }, data });
  }
}
