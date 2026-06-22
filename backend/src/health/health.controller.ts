import { Controller, Get, Logger, OnModuleInit } from '@nestjs/common';
import { exec } from 'child_process';
import { promisify } from 'util';
import { Redis } from 'ioredis';
import { PrismaService } from '../prisma.service';

const execAsync = promisify(exec);

export interface HealthStatus {
  gemini: boolean;
  ffmpeg: boolean;
  db: boolean;
  smtp: boolean;
  redis: boolean;
}

@Controller('health')
export class HealthController implements OnModuleInit {
  private readonly logger = new Logger(HealthController.name);

  // Cached at boot via onModuleInit() so we never shell out to `ffmpeg -version`
  // (or open a new Redis connection) on every /health request.
  private ffmpegAvailable = false;
  private redisAvailable = false;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    this.ffmpegAvailable = await this.checkFfmpeg();
    this.logger.log(
      `ffmpeg availability check at boot: ${this.ffmpegAvailable}`,
    );
    this.redisAvailable = await this.checkRedisAtBoot();
    this.logger.log(`Redis availability check at boot: ${this.redisAvailable}`);
  }

  private async checkFfmpeg(): Promise<boolean> {
    try {
      await execAsync('ffmpeg -version');
      return true;
    } catch (err) {
      this.logger.warn(
        'ffmpeg binary not found on PATH. Video processing (Phase 2/4) will fail until ffmpeg is installed.',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private async checkDb(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      this.logger.error(
        'Database health check failed.',
        err instanceof Error ? err.message : err,
      );
      return false;
    }
  }

  private checkSmtp(): boolean {
    return Boolean(
      process.env.SMTP_HOST &&
      process.env.SMTP_PORT &&
      process.env.SMTP_USER &&
      process.env.SMTP_PASS,
    );
  }

  private checkGemini(): boolean {
    return Boolean(process.env.GEMINI_API_KEY);
  }

  private async checkRedisAtBoot(): Promise<boolean> {
    const client = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      lazyConnect: true,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
    });
    try {
      await client.connect();
      await client.ping();
      return true;
    } catch (err) {
      this.logger.warn(
        'Redis is not reachable. The BullMQ video pipeline (Phase 2/4) will fail until Redis is running.',
        err instanceof Error ? err.message : err,
      );
      return false;
    } finally {
      client.disconnect();
    }
  }

  @Get()
  async check(): Promise<HealthStatus> {
    return {
      gemini: this.checkGemini(),
      ffmpeg: this.ffmpegAvailable,
      db: await this.checkDb(),
      smtp: this.checkSmtp(),
      redis: this.redisAvailable,
    };
  }
}
