import { Module } from '@nestjs/common';
import { TranslationService } from './translation.service';
import { TranslationController } from './translation.controller';
import { PrismaService } from '../prisma.service';
import { QueueService } from './queue.service';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [TranslationController],
  providers: [TranslationService, PrismaService, QueueService],
  exports: [TranslationService],
})
export class TranslationModule {}
