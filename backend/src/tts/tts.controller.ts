import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Param,
  Patch,
  Post,
  Request,
  Res,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { PrismaService } from '../prisma.service';
import { TtsService } from './tts.service';
import { VOICE_CATALOG, isValidVoiceId } from './voices.config';
import { SpeakDto } from './dto/speak.dto';
import { SetPreferredVoiceDto } from './dto/set-preferred-voice.dto';
import { InsufficientCreditsError } from '../credit/insufficient-credits.error';

interface RequestWithUser {
  user: {
    id: string;
    email: string;
    credits: number;
  };
}

@Controller('tts')
@UseGuards(JwtAuthGuard)
export class TtsController {
  constructor(
    private readonly ttsService: TtsService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('voices')
  getVoices() {
    return {
      success: true,
      voices: VOICE_CATALOG.map((voice) => ({
        ...voice,
        sampleUrl: `/tts/sample/${voice.id}`,
      })),
    };
  }

  @Throttle({ default: { limit: 20, ttl: 60000 } })
  @Post('speak')
  async speak(
    @Body() dto: SpeakDto,
    @Request() req: RequestWithUser,
    @Res() res: Response,
  ) {
    if (!dto.text) {
      throw new BadRequestException('Text is required');
    }
    if (!dto.voiceId || !isValidVoiceId(dto.voiceId)) {
      throw new BadRequestException('A valid voiceId is required');
    }

    try {
      const { audioBuffer } = await this.ttsService.synthesize(
        req.user.id,
        dto.text,
        dto.voiceId,
      );
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(audioBuffer);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Text-to-speech failed';
      res.status(400).json({
        success: false,
        error: message,
        code: error instanceof InsufficientCreditsError ? 'INSUFFICIENT_CREDITS' : undefined,
      });
    }
  }

  @Get('sample/:voiceId')
  async getSample(@Param('voiceId') voiceId: string, @Res() res: Response) {
    if (!isValidVoiceId(voiceId)) {
      throw new BadRequestException(`Unknown voiceId "${voiceId}"`);
    }
    try {
      const { audioBuffer } = await this.ttsService.getSample(voiceId);
      res.setHeader('Content-Type', 'audio/mpeg');
      res.send(audioBuffer);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : 'Failed to load sample';
      res.status(400).json({ success: false, error: message });
    }
  }

  @Patch('preferred-voice')
  async setPreferredVoice(
    @Body() dto: SetPreferredVoiceDto,
    @Request() req: RequestWithUser,
  ) {
    if (!dto.voiceId || !isValidVoiceId(dto.voiceId)) {
      throw new BadRequestException('A valid voiceId is required');
    }
    await this.prisma.user.update({
      where: { id: req.user.id },
      data: { preferredVoiceId: dto.voiceId },
    });
    return { success: true, preferredVoiceId: dto.voiceId };
  }
}
