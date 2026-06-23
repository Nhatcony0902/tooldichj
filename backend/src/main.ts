import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';

const logger = new Logger('Bootstrap');

function logStartupChecks() {
  if (!process.env.GEMINI_API_KEY) {
    logger.warn(
      '================================================================',
    );
    logger.warn(
      '  GEMINI_API_KEY is NOT set. The translation service will run in',
    );
    logger.warn(
      '  MOCK mode (no real Gemini calls). Set GEMINI_API_KEY in .env to',
    );
    logger.warn('  enable real translations. See GET /health for status.');
    logger.warn(
      '================================================================',
    );
  }
}

async function bootstrap() {
  logStartupChecks();
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // Cho phép Next.js gọi API từ port 3000
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
