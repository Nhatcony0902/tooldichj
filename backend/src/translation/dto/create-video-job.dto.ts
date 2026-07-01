export class CreateVideoJobDto {
  targetLang: string;
  outputMode?: string;
  removeSourceSubs?: string; // multipart form sends strings "true"/"false"
}
