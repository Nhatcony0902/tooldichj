-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "untranslatedSegmentCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "VideoJob" ADD COLUMN     "blurStatus" TEXT;
