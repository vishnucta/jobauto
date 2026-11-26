-- Public issue 167: SQLite reads a bare `DEFAULT []` as an empty name and
-- stores '' (an empty string), not the JSON '[]'. Three migrations from 1.15
-- had it, so every search made before 1.15 got '' in `portals`, which isn't
-- JSON, and reading those searches failed. These tables get quoted
-- defaults, and the empty strings become empty lists.
-- jobauto fork: "addedBy" (an AI client's or careers pages' search) is
-- carried through the rebuilt PostingSearch.
-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_PortalCatalog" (
    "id" INTEGER NOT NULL PRIMARY KEY DEFAULT 1,
    "portals" JSONB NOT NULL DEFAULT '[]',
    "withdrawn" JSONB NOT NULL DEFAULT '[]',
    "commit" TEXT,
    "etag" TEXT,
    "readAt" DATETIME,
    "nextReadAt" DATETIME
);
INSERT INTO "new_PortalCatalog" ("commit", "etag", "id", "nextReadAt", "portals", "readAt", "withdrawn") SELECT "commit", "etag", "id", "nextReadAt", CASE WHEN "portals" = '' THEN '[]' ELSE "portals" END, "readAt", CASE WHEN "withdrawn" = '' THEN '[]' ELSE "withdrawn" END FROM "PortalCatalog";
DROP TABLE "PortalCatalog";
ALTER TABLE "new_PortalCatalog" RENAME TO "PortalCatalog";
CREATE TABLE "new_PostingSearch" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "source" TEXT,
    "query" JSONB NOT NULL,
    "postings" JSONB NOT NULL DEFAULT '[]',
    "portals" JSONB NOT NULL DEFAULT '[]',
    "found" INTEGER NOT NULL DEFAULT 0,
    "next" TEXT,
    "addedBy" TEXT NOT NULL DEFAULT '',
    "agentSearchId" TEXT,
    "agentSearchName" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PostingSearch_agentSearchId_fkey" FOREIGN KEY ("agentSearchId") REFERENCES "AgentSearch" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_PostingSearch" ("agentSearchId", "agentSearchName", "createdAt", "found", "id", "next", "portals", "postings", "query", "source", "updatedAt", "addedBy") SELECT "agentSearchId", "agentSearchName", "createdAt", "found", "id", "next", CASE WHEN "portals" = '' THEN '[]' ELSE "portals" END, CASE WHEN "postings" = '' THEN '[]' ELSE "postings" END, "query", "source", "updatedAt", "addedBy" FROM "PostingSearch";
DROP TABLE "PostingSearch";
ALTER TABLE "new_PostingSearch" RENAME TO "PostingSearch";
CREATE INDEX "PostingSearch_createdAt_idx" ON "PostingSearch"("createdAt");
CREATE INDEX "PostingSearch_agentSearchId_idx" ON "PostingSearch"("agentSearchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
