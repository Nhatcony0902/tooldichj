export interface SegmentEditDto {
  index: number;
  translatedText: string;
}

export interface UpdateSegmentsDto {
  segments: SegmentEditDto[];
}
