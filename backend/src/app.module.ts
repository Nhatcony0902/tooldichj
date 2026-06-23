import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { TranslationModule } from './translation/translation.module';
import { AuthModule } from './auth/auth.module';
import { HealthModule } from './health/health.module';
import { TtsModule } from './tts/tts.module';
import { BillingModule } from './billing/billing.module';

@Module({
  imports: [
    TranslationModule,
    AuthModule,
    HealthModule,
    TtsModule,
    BillingModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
