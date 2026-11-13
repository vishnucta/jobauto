-- CreateTable
CREATE TABLE "Employer" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "careersUrl" TEXT NOT NULL,
    "ats" TEXT NOT NULL,
    "keywords" TEXT NOT NULL DEFAULT '',
    "places" TEXT NOT NULL DEFAULT '',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "notes" TEXT NOT NULL DEFAULT '',
    "lastCheckedAt" DATETIME,
    "lastMatched" INTEGER NOT NULL DEFAULT 0,
    "lastNew" INTEGER NOT NULL DEFAULT 0,
    "problem" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "Employer_name_idx" ON "Employer"("name");
