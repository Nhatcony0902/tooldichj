import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { VIDEO_PIPELINE_QUEUE } from '../queue/queue.module';

@Injectable()
export class QueueService {
  private readonly logger = new Logger(QueueService.name);

  constructor(
    @InjectQueue(VIDEO_PIPELINE_QUEUE) private readonly queue: Queue,
  ) {}

  async enqueueVideoJob(jobId: string): Promise<void> {
    await this.queue.add(
      'process-video',
      { jobId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log(`Enqueued video job ${jobId} onto ${VIDEO_PIPELINE_QUEUE}`);
  }

  async enqueueVideoBurnJob(jobId: string): Promise<void> {
    await this.queue.add(
      'process-video-burn',
      { jobId },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
    this.logger.log(`Enqueued burn phase for video job ${jobId}`);
  }
}
