export class CreateVideoJobDto {
  targetLang: string;
  outputMode?: string;
  dubVoiceId?: string;
  removeSourceSubs?: string; // multipart form sends strings "true"/"false"
}
