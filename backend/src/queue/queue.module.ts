import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

export const VIDEO_PIPELINE_QUEUE = 'video-pipeline';

@Module({
  imports: [
    BullModule.forRoot({
      connection: {
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
      },
    }),
    BullModule.registerQueue({ name: VIDEO_PIPELINE_QUEUE }),
  ],
  exports: [BullModule],
})
export class QueueModule {}
