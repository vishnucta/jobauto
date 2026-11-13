-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Recruiter" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "kind" TEXT NOT NULL DEFAULT 'AGENCY',
    "name" TEXT NOT NULL,
    "contactName" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "website" TEXT NOT NULL DEFAULT '',
    "speciality" TEXT NOT NULL DEFAULT '',
    "relation" TEXT NOT NULL DEFAULT '',
    "notes" TEXT NOT NULL DEFAULT '',
    "source" TEXT NOT NULL DEFAULT 'you',
    "status" TEXT NOT NULL DEFAULT 'NOT_CONTACTED',
    "contactedAt" DATETIME,
    "followUpAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_Recruiter" ("contactName", "contactedAt", "createdAt", "email", "followUpAt", "id", "name", "notes", "source", "speciality", "status", "updatedAt", "website") SELECT "contactName", "contactedAt", "createdAt", "email", "followUpAt", "id", "name", "notes", "source", "speciality", "status", "updatedAt", "website" FROM "Recruiter";
DROP TABLE "Recruiter";
ALTER TABLE "new_Recruiter" RENAME TO "Recruiter";
CREATE INDEX "Recruiter_status_idx" ON "Recruiter"("status");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
