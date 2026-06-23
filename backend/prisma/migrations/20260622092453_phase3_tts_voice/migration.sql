-- AlterTable
ALTER TABLE "User" ADD COLUMN "preferredVoiceId" TEXT;

-- AlterTable
DROP INDEX "TtsCache_textHash_voice_lang_key";
ALTER TABLE "TtsCache" DROP COLUMN "voice";
ALTER TABLE "TtsCache" DROP COLUMN "lang";
ALTER TABLE "TtsCache" DROP COLUMN "audioKey";
ALTER TABLE "TtsCache" ADD COLUMN "voiceId" TEXT NOT NULL;
ALTER TABLE "TtsCache" ADD COLUMN "audioStorageKey" TEXT NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX "TtsCache_textHash_voiceId_key" ON "TtsCache"("textHash", "voiceId");
