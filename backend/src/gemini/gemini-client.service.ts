import { Injectable, Logger } from '@nestjs/common';
import { GoogleGenAI } from '@google/genai';
import * as crypto from 'crypto';

@Injectable()
export class GeminiClientService {
  private readonly logger = new Logger(GeminiClientService.name);
  private readonly ai: GoogleGenAI | null;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (apiKey) {
      this.ai = new GoogleGenAI({ apiKey });
      this.logger.log('Gemini API initialized successfully.');
    } else {
      this.ai = null;
      this.logger.warn('GEMINI_API_KEY is not defined. Using mock fallback.');
    }
  }

  getAi(): GoogleGenAI | null {
    return this.ai;
  }

  getHash(text: string): string {
    return crypto.createHash('sha256').update(text).digest('hex');
  }
}
