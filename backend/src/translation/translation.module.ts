import { Module } from '@nestjs/common';
import { TranslationService } from './translation.service';
import { TranslationController } from './translation.controller';
import { PrismaService } from '../prisma.service';
import { QueueService } from './queue.service';

@Module({
  controllers: [TranslationController],
  providers: [TranslationService, PrismaService, QueueService],
  exports: [TranslationService],
})
export class TranslationModule {}
