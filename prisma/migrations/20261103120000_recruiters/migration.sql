-- CreateEnum
CREATE TYPE "RecruiterStatus" AS ENUM ('NOT_CONTACTED', 'CONTACTED', 'REPLIED', 'NOT_INTERESTED');

-- CreateTable
CREATE TABLE "Recruiter" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "speciality" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'you',
    "status" "RecruiterStatus" NOT NULL DEFAULT 'NOT_CONTACTED',
    "contactedAt" TIMESTAMP(3),
    "followUpAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Recruiter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecruiterEvent" (
    "id" TEXT NOT NULL,
    "recruiterId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecruiterEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Recruiter_status_idx" ON "Recruiter"("status");

-- CreateIndex
CREATE INDEX "RecruiterEvent_recruiterId_at_idx" ON "RecruiterEvent"("recruiterId", "at");

-- AddForeignKey
ALTER TABLE "RecruiterEvent" ADD CONSTRAINT "RecruiterEvent_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "Recruiter"("id") ON DELETE CASCADE ON UPDATE CASCADE;

