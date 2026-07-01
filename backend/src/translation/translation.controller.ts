import {
  Controller,
  Post,
  Get,
  Delete,
  Body,
  Param,
  BadRequestException,
  ForbiddenException,
  NotFoundException,
  UseGuards,
  UseInterceptors,
  UploadedFile,
  Request,
  Res,
  Inject,
  Logger,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import * as path from 'path';
import { TranslationService } from './translation.service';
import { QueueService } from './queue.service';
import { TranslateDto } from './dto/translate.dto';
import { CreateVideoJobDto } from './dto/create-video-job.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import {
  STORAGE_PROVIDER,
  type IStorageProvider,
} from '../storage/storage.interface';
import { OUTPUT_MODES, isValidOutputMode } from './pipeline/output-mode';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';

interface RequestWithUser {
  user: {
    id: string;
    email: string;
    credits: number;
  };
}

const MAX_FILE_SIZE =
  parseInt(process.env.MAX_UPLOAD_MB || '100', 10) * 1024 * 1024;

const OUTPUT_KINDS = ['srt', 'video', 'audio'] as const;
type OutputKind = (typeof OUTPUT_KINDS)[number];

const MAX_TEXT_LENGTH = 20000;

@Controller('translation')
export class TranslationController {
  private readonly logger = new Logger(TranslationController.name);

  constructor(
    private readonly translationService: TranslationService,
    private readonly queueService: QueueService,
    @Inject(STORAGE_PROVIDER)
    private readonly storage: IStorageProvider,
  ) {}

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('translate')
  async translate(
    @Body() translateDto: TranslateDto,
    @Request() req: RequestWithUser,
  ) {
    const { text, sourceLang, targetLang } = translateDto;
    const userId = req.user.id;

    if (!text) {
      throw new BadRequestException('Text is required');
    }
    if (text.length > MAX_TEXT_LENGTH) {
      throw new BadRequestException(
        `Text exceeds the maximum length of ${MAX_TEXT_LENGTH.toLocaleString()} characters (got ${text.length})`,
      );
    }
    if (!sourceLang || !targetLang) {
      throw new BadRequestException(
        'Source language and target language are required',
      );
    }

    try {
      const { translatedText, detectedLang } =
        await this.translationService.translate(
          userId,
          text,
          sourceLang,
          targetLang,
        );
      return {
        success: true,
        text,
        translatedText,
        sourceLang,
        targetLang,
        detectedLang,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An error occurred during translation';
      return {
        success: false,
        error: errorMessage,
        code: error instanceof InsufficientCreditsError ? 'INSUFFICIENT_CREDITS' : undefined,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @Post('video-job')
  @UseInterceptors(
    FileInterceptor('video', {
      limits: { fileSize: MAX_FILE_SIZE },
      fileFilter: (_req, file, cb) => {
        if (!file.mimetype.startsWith('video/')) {
          cb(new BadRequestException('Only video files are accepted'), false);
          return;
        }
        cb(null, true);
      },
    }),
  )
  async createVideoJob(
    @UploadedFile() file: Express.Multer.File | undefined,
    @Body() dto: CreateVideoJobDto,
    @Request() req: RequestWithUser,
  ) {
    const userId = req.user.id;

    if (!file) {
      throw new BadRequestException('A video file is required');
    }
    if (!dto.targetLang) {
      throw new BadRequestException('targetLang is required');
    }
    const outputMode = dto.outputMode || 'burn';
    if (!isValidOutputMode(outputMode)) {
      throw new BadRequestException(
        `Invalid outputMode "${outputMode}". Must be one of: ${OUTPUT_MODES.join(', ')}`,
      );
    }
    try {
      // basename() strips any directory components a crafted originalname
      // could carry (e.g. "../../etc/passwd"), so the storage key can never
      // resolve outside the upload directory.
      const safeName = path.basename(file.originalname);
      const storageKey = `uploads/${Date.now()}-${safeName}`;
      await this.storage.save(file.buffer, storageKey);

      const removeSourceSubs = dto.removeSourceSubs === 'true';
      const job = await this.translationService.createVideoJob(userId, {
        fileName: file.originalname,
        inputStorageKey: storageKey,
        targetLang: dto.targetLang,
        outputMode,
        removeSourceSubs,
      });
      await this.queueService.enqueueVideoJob(job.id);
      return { success: true, job };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create video job';
      return {
        success: false,
        error: errorMessage,
        code: error instanceof InsufficientCreditsError ? 'INSUFFICIENT_CREDITS' : undefined,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('history')
  async getHistory(@Request() req: RequestWithUser) {
    const history = await this.translationService.getHistory(req.user.id);
    return { success: true, history };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('history')
  async clearHistory(@Request() req: RequestWithUser) {
    await this.translationService.clearHistory(req.user.id);
    return { success: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('video-jobs/:id/cancel')
  async cancelVideoJob(
    @Param('id') id: string,
    @Request() req: RequestWithUser,
  ) {
    const job = await this.translationService.cancelVideoJob(req.user.id, id);
    return { success: true, job };
  }

  @UseGuards(JwtAuthGuard)
  @Delete('video-jobs/:id')
  async deleteVideoJob(
    @Param('id') id: string,
    @Request() req: RequestWithUser,
  ) {
    const storageKeys = await this.translationService.deleteVideoJob(req.user.id, id);
    for (const key of storageKeys) {
      await this.storage.delete(key).catch((err: unknown) => {
        this.logger.warn(`Failed to delete storage key "${key}": ${err instanceof Error ? err.message : err}`);
      });
    }
    return { success: true };
  }

  // Frontend polls this every 3s while a job is active — never throttle it.
  @SkipThrottle()
  @UseGuards(JwtAuthGuard)
  @Get('video-jobs')
  async getVideoJobs(@Request() req: RequestWithUser) {
    const userId = req.user.id;
    try {
      const jobs = await this.translationService.getVideoJobs(userId);
      return { success: true, jobs };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to retrieve video jobs';
      return { success: false, error: errorMessage };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('output/:jobId/:kind')
  async getOutput(
    @Param('jobId') jobId: string,
    @Param('kind') kind: string,
    @Request() req: RequestWithUser,
    @Res() res: Response,
  ) {
    if (!OUTPUT_KINDS.includes(kind as OutputKind)) {
      throw new BadRequestException(
        `Invalid kind "${kind}". Must be one of: ${OUTPUT_KINDS.join(', ')}`,
      );
    }

    const job = await this.translationService.getVideoJobById(jobId);
    if (!job) {
      throw new NotFoundException('Job not found');
    }
    if (job.userId !== req.user.id) {
      throw new ForbiddenException('Access denied');
    }

    let storageKey: string | null = null;
    let contentType: string;
    let fileName: string;

    switch (kind as OutputKind) {
      case 'srt':
        storageKey = job.subtitlesUrl;
        contentType = 'application/x-subrip';
        fileName = `${job.fileName}.srt`;
        break;
      case 'video':
        storageKey = job.outputVideoUrl;
        contentType = 'video/mp4';
        fileName = `translated_${job.fileName}`;
        break;
      case 'audio':
        storageKey = job.outputAudioUrl;
        contentType = 'audio/mpeg';
        fileName = `audio_${job.fileName}.mp3`;
        break;
    }

    if (!storageKey || !(await this.storage.exists(storageKey))) {
      throw new NotFoundException('Output not yet available');
    }

    const stream = await this.storage.stream(storageKey);
    res.setHeader('Content-Type', contentType);
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${encodeURIComponent(fileName)}"`,
    );
    stream.pipe(res);
  }
}
