-- CreateEnum
CREATE TYPE "ApplyAttemptStatus" AS ENUM ('OPENING', 'WAITING', 'SUBMITTED', 'ABANDONED', 'FAILED');

-- CreateTable
CREATE TABLE "ApplyAttempt" (
    "id" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "ats" TEXT NOT NULL DEFAULT 'unknown',
    "status" "ApplyAttemptStatus" NOT NULL DEFAULT 'OPENING',
    "autoSubmit" BOOLEAN NOT NULL DEFAULT false,
    "filled" JSONB,
    "unfilled" JSONB,
    "captcha" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "screenshot" BOOLEAN NOT NULL DEFAULT false,
    "confirmation" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ApplyAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ApplyAttempt_applicationId_startedAt_idx" ON "ApplyAttempt"("applicationId", "startedAt");

-- AddForeignKey
ALTER TABLE "ApplyAttempt" ADD CONSTRAINT "ApplyAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application"("id") ON DELETE CASCADE ON UPDATE CASCADE;
