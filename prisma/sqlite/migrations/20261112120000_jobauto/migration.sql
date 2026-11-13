-- The bewerbung fork (jobauto) on SQLite, on top of Dossier 1.13.0: the
-- apply assistant's attempts, Recruiters, and searches of several sources.
-- The fork's AI providers (GROQ, DEEPSEEK) and job sources (SERPAPI, JOOBLE,
-- CLIENT) need nothing here: SQLite keeps enums as text.
-- PostingSearch is rebuilt for its list of sources, which SQLite keeps as a
-- JSON array; its one source and next page are carried over into "sources"
-- and "cursors", as the PostgreSQL migration 20261102150000_search_sources
-- does. It has nothing added by hand (COLLATE NOCASE and the trigger are on
-- Skill, Language and Theme). Prisma writes a JSON default without quotes,
-- which SQLite can't read, so they're quoted here by hand.

-- CreateTable
CREATE TABLE "ApplyAttempt" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "applicationId" TEXT NOT NULL,
    "url" TEXT NOT NULL DEFAULT '',
    "ats" TEXT NOT NULL DEFAULT 'unknown',
    "status" TEXT NOT NULL DEFAULT 'OPENING',
    "autoSubmit" BOOLEAN NOT NULL DEFAULT false,
    "filled" JSONB,
    "unfilled" JSONB,
    "captcha" BOOLEAN NOT NULL DEFAULT false,
    "note" TEXT NOT NULL DEFAULT '',
    "screenshot" BOOLEAN NOT NULL DEFAULT false,
    "confirmation" BOOLEAN NOT NULL DEFAULT false,
    "startedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ApplyAttempt_applicationId_fkey" FOREIGN KEY ("applicationId") REFERENCES "Application" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Recruiter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "speciality" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'you',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONTACTED',
    "contactedAt" DATETIME,
    "followUpAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "RecruiterEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "recruiterId" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "at" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecruiterEvent_recruiterId_fkey" FOREIGN KEY ("recruiterId") REFERENCES "Recruiter" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "RecruiterBlock" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PostingSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sources" JSONB NOT NULL DEFAULT '[]',
    "query" JSONB NOT NULL,
    "postings" JSONB NOT NULL,
    "found" INTEGER NOT NULL DEFAULT 0,
    "cursors" JSONB NOT NULL DEFAULT '{}',
    "problems" JSONB NOT NULL DEFAULT '[]',
    "addedBy" TEXT NOT NULL DEFAULT '',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_PostingSearch" ("id", "sources", "query", "postings", "found", "cursors", "createdAt", "updatedAt")
SELECT
  "id",
  json_array("source"),
  "query",
  "postings",
  "found",
  CASE WHEN "next" IS NULL THEN '{}' ELSE json_object("source", "next") END,
  "createdAt",
  "updatedAt"
FROM "PostingSearch";
DROP TABLE "PostingSearch";
ALTER TABLE "new_PostingSearch" RENAME TO "PostingSearch";
CREATE INDEX "PostingSearch_createdAt_idx" ON "PostingSearch"("createdAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "ApplyAttempt_applicationId_startedAt_idx" ON "ApplyAttempt"("applicationId", "startedAt");

-- CreateIndex
CREATE INDEX "Recruiter_status_idx" ON "Recruiter"("status");

-- CreateIndex
CREATE INDEX "RecruiterEvent_recruiterId_at_idx" ON "RecruiterEvent"("recruiterId", "at");
