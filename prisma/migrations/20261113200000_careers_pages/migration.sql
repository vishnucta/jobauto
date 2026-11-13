-- AlterEnum
ALTER TYPE "PostingSource" ADD VALUE 'CAREERS';

-- CreateTable
CREATE TABLE "Employer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "careersUrl" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "places" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" TIMESTAMP(3),
    "lastMatched" INTEGER NOT NULL DEFAULT 0,
    "lastNew" INTEGER NOT NULL DEFAULT 0,
    "problem" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Employer_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Employer_name_idx" ON "Employer"("name");
