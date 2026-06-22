import { Module } from '@nestjs/common';
import { TtsController } from './tts.controller';
import { TtsService } from './tts.service';
import { PrismaService } from '../prisma.service';
import { StorageModule } from '../storage/storage.module';
import { CreditModule } from '../credit/credit.module';
import { TranslationModule } from '../translation/translation.module';

@Module({
  imports: [StorageModule, CreditModule, TranslationModule],
  controllers: [TtsController],
  providers: [TtsService, PrismaService],
})
export class TtsModule {}
