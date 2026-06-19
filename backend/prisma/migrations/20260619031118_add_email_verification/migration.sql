-- AlterTable
ALTER TABLE "User" ADD COLUMN     "emailVerified" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "emailVerifyLastSentAt" TIMESTAMP(3),
ADD COLUMN     "emailVerifyOtp" TEXT,
ADD COLUMN     "emailVerifyOtpExpiresAt" TIMESTAMP(3);
