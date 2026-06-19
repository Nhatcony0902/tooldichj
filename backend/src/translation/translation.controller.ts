import {
  Controller,
  Post,
  Get,
  Body,
  BadRequestException,
  UseGuards,
  Request,
} from '@nestjs/common';
import { TranslationService } from './translation.service';
import { TranslateDto } from './dto/translate.dto';
import { CreateVideoJobDto } from './dto/create-video-job.dto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';

interface RequestWithUser {
  user: {
    id: string;
    email: string;
    credits: number;
  };
}

@Controller('translation')
export class TranslationController {
  constructor(private readonly translationService: TranslationService) {}

  @UseGuards(JwtAuthGuard)
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
    if (!sourceLang || !targetLang) {
      throw new BadRequestException(
        'Source language and target language are required',
      );
    }

    try {
      const translatedText = await this.translationService.translate(
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
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'An error occurred during translation';
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Post('video-job')
  async createVideoJob(
    @Body() createVideoJobDto: CreateVideoJobDto,
    @Request() req: RequestWithUser,
  ) {
    const userId = req.user.id;
    if (!createVideoJobDto.fileName) {
      throw new BadRequestException('fileName is required');
    }
    try {
      const job = await this.translationService.createVideoJob(
        userId,
        createVideoJobDto,
      );
      return {
        success: true,
        job,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : 'Failed to create video job';
      return {
        success: false,
        error: errorMessage,
      };
    }
  }

  @UseGuards(JwtAuthGuard)
  @Get('video-jobs')
  async getVideoJobs(@Request() req: RequestWithUser) {
    const userId = req.user.id;
    try {
      const jobs = await this.translationService.getVideoJobs(userId);
      return {
        success: true,
        jobs,
      };
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error
          ? error.message
          : 'Failed to retrieve video jobs';
      return {
        success: false,
        error: errorMessage,
      };
    }
  }
}
