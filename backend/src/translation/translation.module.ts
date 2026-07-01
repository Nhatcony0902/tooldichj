import { Module } from '@nestjs/common';
import { TranslationService } from './translation.service';
import { TranslationController } from './translation.controller';
import { PrismaService } from '../prisma.service';
import { QueueService } from './queue.service';
import { StorageModule } from '../storage/storage.module';
import { QueueModule } from '../queue/queue.module';
import { CreditModule } from '../credit/credit.module';
import { GeminiModule } from '../gemini/gemini.module';
import { VideoPipelineWorker } from './pipeline/video-pipeline.worker';

@Module({
  imports: [StorageModule, QueueModule, CreditModule, GeminiModule],
  controllers: [TranslationController],
  providers: [
    TranslationService,
    PrismaService,
    QueueService,
    VideoPipelineWorker,
  ],
  exports: [TranslationService],
})
export class TranslationModule {}
