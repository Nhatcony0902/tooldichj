import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TranslationModule } from './translation/translation.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { TtsModule } from './tts/tts.module';

@Module({
  imports: [TranslationModule, AuthModule, HealthModule, TtsModule],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
