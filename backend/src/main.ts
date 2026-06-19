import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors(); // Cho phép Next.js gọi API từ port 3000
  await app.listen(process.env.PORT ?? 3001);
}
void bootstrap();
