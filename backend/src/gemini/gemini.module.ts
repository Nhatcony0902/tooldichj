import { Module } from '@nestjs/common';
import { GeminiClientService } from './gemini-client.service';

@Module({
  providers: [GeminiClientService],
  exports: [GeminiClientService],
})
export class GeminiModule {}
