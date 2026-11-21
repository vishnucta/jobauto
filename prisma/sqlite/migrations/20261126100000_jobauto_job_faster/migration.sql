-- The jobauto fork, on SQLite: "Application" with the work sample and
-- experiment columns ("workSample", "workSampleWith", "experiment", "arm"),
-- however the database came here. Rebuilt the way Prisma rebuilds a table,
-- so it ends up the same in every case:
-- - a new database, or one from before job-faster: 20261120110000_experiments
--   and 20261120120000_work_sample added them after 1.15's rebuild of the
--   table, so "Application" has them (empty, or as written since);
-- - a database that ran those two before 1.15's migrations:
--   20261117140000_application_profile's rebuild dropped them, and they are
--   in the copy 20261117135000_jobauto_job_faster_aside kept.
-- So the four are named below without a table: SQLite takes each from
-- whichever of the two has it, and one always does, never both (a copy
-- with them is from a database whose "Application" lost them). Every other
-- column comes from "Application" as it is now.

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Application" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "profileId" TEXT,
    "origin" TEXT NOT NULL DEFAULT 'MANUAL',
    "agentScore" INTEGER,
    "resumeFit" JSONB,
    "awaitingReview" BOOLEAN NOT NULL DEFAULT false,
    "title" TEXT NOT NULL DEFAULT '',
    "company" TEXT NOT NULL DEFAULT '',
    "role" TEXT NOT NULL DEFAULT '',
    "location" TEXT NOT NULL DEFAULT '',
    "mode" TEXT NOT NULL DEFAULT '',
    "salary" TEXT NOT NULL DEFAULT '',
    "deadline" DATETIME,
    "postingUrl" TEXT NOT NULL DEFAULT '',
    "postingText" TEXT NOT NULL DEFAULT '',
    "extracted" JSONB,
    "extractedWith" TEXT,
    "match" JSONB,
    "matchedWith" TEXT,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "boardSort" INTEGER,
    "furthestStage" TEXT,
    "sentAt" DATETIME,
    "sentVia" TEXT,
    "nextInterviewAt" DATETIME,
    "tone" TEXT NOT NULL DEFAULT 'WARM',
    "language" TEXT NOT NULL DEFAULT '',
    "followThemeLayout" BOOLEAN NOT NULL DEFAULT false,
    "showPhoto" BOOLEAN,
    "sections" JSONB,
    "frozen" JSONB,
    "archivedAt" DATETIME,
    "emailThreadId" TEXT,
    "interviewEventId" TEXT,
    "interviewCalendarId" TEXT,
    "messageDraft" JSONB,
    "contactedAt" DATETIME,
    "prep" JSONB,
    "prepWith" TEXT,
    "workSample" JSONB,
    "workSampleWith" TEXT,
    "experiment" TEXT,
    "arm" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Application_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "Profile" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Application" ("agentScore", "archivedAt", "arm", "awaitingReview", "boardSort", "company", "contactedAt", "createdAt", "deadline", "emailThreadId", "experiment", "extracted", "extractedWith", "followThemeLayout", "frozen", "furthestStage", "id", "interviewCalendarId", "interviewEventId", "language", "location", "match", "matchedWith", "messageDraft", "mode", "nextInterviewAt", "origin", "postingText", "postingUrl", "prep", "prepWith", "profileId", "resumeFit", "role", "salary", "sections", "sentAt", "sentVia", "showPhoto", "status", "title", "tone", "updatedAt", "workSample", "workSampleWith")
SELECT a."agentScore", a."archivedAt", "arm", a."awaitingReview", a."boardSort", a."company", a."contactedAt", a."createdAt", a."deadline", a."emailThreadId", "experiment", a."extracted", a."extractedWith", a."followThemeLayout", a."frozen", a."furthestStage", a."id", a."interviewCalendarId", a."interviewEventId", a."language", a."location", a."match", a."matchedWith", a."messageDraft", a."mode", a."nextInterviewAt", a."origin", a."postingText", a."postingUrl", a."prep", a."prepWith", a."profileId", a."resumeFit", a."role", a."salary", a."sections", a."sentAt", a."sentVia", a."showPhoto", a."status", a."title", a."tone", a."updatedAt", "workSample", "workSampleWith"
FROM "Application" AS a
LEFT JOIN "jobauto_ApplicationAside" AS k ON k."id" = a."id";
DROP TABLE "Application";
ALTER TABLE "new_Application" RENAME TO "Application";
CREATE INDEX "Application_status_idx" ON "Application"("status");
CREATE INDEX "Application_updatedAt_idx" ON "Application"("updatedAt");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DropTable
DROP TABLE "jobauto_ApplicationAside";
