-- AlterTable
ALTER TABLE "User" ADD COLUMN     "passwordResetOtp" TEXT,
ADD COLUMN     "passwordResetOtpExpiresAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "VideoJob" ADD COLUMN     "inputStorageKey" TEXT,
ADD COLUMN     "outputAudioUrl" TEXT,
ADD COLUMN     "outputMode" TEXT NOT NULL DEFAULT 'burn';

-- CreateTable
CREATE TABLE "TtsCache" (
    "id" SERIAL NOT NULL,
    "textHash" TEXT NOT NULL,
    "voice" TEXT NOT NULL,
    "lang" TEXT NOT NULL,
    "audioKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TtsCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditTopupRequest" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "amount" INTEGER NOT NULL,
    "orderCode" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "note" TEXT,
    "confirmedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CreditTopupRequest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TtsCache_textHash_idx" ON "TtsCache"("textHash");

-- CreateIndex
CREATE UNIQUE INDEX "TtsCache_textHash_voice_lang_key" ON "TtsCache"("textHash", "voice", "lang");

-- CreateIndex
CREATE UNIQUE INDEX "CreditTopupRequest_orderCode_key" ON "CreditTopupRequest"("orderCode");

-- AddForeignKey
ALTER TABLE "CreditTopupRequest" ADD CONSTRAINT "CreditTopupRequest_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
