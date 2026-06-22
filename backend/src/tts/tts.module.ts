import { Module } from '@nestjs/common';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { PrismaService } from '../prisma.service';
import { StorageModule } from '../storage/storage.module';
import { CreditModule } from '../credit/credit.module';
import { GeminiModule } from '../gemini/gemini.module';

@Module({
  imports: [StorageModule, CreditModule, GeminiModule],
  controllers: [TtsController],
  providers: [TtsService, PrismaService],
  exports: [TtsService],
})
export class TtsModule {}
