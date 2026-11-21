-- The jobauto fork after Dossier 1.15's migrations, on SQLite: puts back
-- what 20261114000000_jobauto_before_portals kept aside. A search's sources
-- go into 1.15's "portals" (searchPortalSchema in
-- src/lib/job-search/search.ts), in their order: each source that answered
-- as done, with how many postings it found and its next page, then each
-- that didn't (and wasn't stood in for) as failed, with why. CLIENT (an AI
-- client's finds) and CAREERS (careers pages) are portals like the others,
-- and "addedBy" stays. The postings themselves move into the library in
-- code at start (movePastSearches), as 1.15 does for its own past searches.
-- A search's "portals" that 20261115100000_positions_library left empty
-- text (its DEFAULT [] reads as an empty name in SQLite) becomes "[]", and
-- the rebuilt table's JSON defaults are quoted by hand, so they read too.
-- The call prep pack goes back on its application.

-- AlterTable
ALTER TABLE "Application" ADD COLUMN "prep" JSONB;
ALTER TABLE "Application" ADD COLUMN "prepWith" TEXT;

UPDATE "Application"
SET "prep" = (SELECT "prep" FROM "jobauto_CallPrep" WHERE "jobauto_CallPrep"."id" = "Application"."id"),
    "prepWith" = (SELECT "prepWith" FROM "jobauto_CallPrep" WHERE "jobauto_CallPrep"."id" = "Application"."id")
WHERE "id" IN (SELECT "id" FROM "jobauto_CallPrep");

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
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
INSERT INTO "new_PostingSearch" ("agentSearchId", "agentSearchName", "createdAt", "found", "id", "next", "portals", "postings", "query", "source", "updatedAt", "addedBy")
SELECT s."agentSearchId", s."agentSearchName", s."createdAt", s."found", s."id", s."next",
    CASE
        WHEN json_valid(s."portals") AND json_array_length(s."portals") > 0 THEN s."portals"
        WHEN json_array_length(k."sources") > 0 OR json_array_length(k."problems") > 0 THEN (
            SELECT json_group_array(json(p."portal"))
            FROM (
                SELECT json_object(
                           'id', u."value",
                           'status', 'done',
                           'found', (SELECT count(*) FROM json_each(s."postings") AS e WHERE json_extract(e."value", '$.source') = u."value"),
                           'next', json_extract(k."cursors", '$."' || u."value" || '"'),
                           'message', NULL
                       ) AS "portal",
                       u."key" AS "at"
                FROM json_each(k."sources") AS u
                UNION ALL
                SELECT json_object(
                           'id', json_extract(q."value", '$.source'),
                           'status', 'failed',
                           'found', 0,
                           'next', NULL,
                           'message', json_extract(q."value", '$.message'),
                           'problem', json_extract(q."value", '$.problem')
                       ),
                       1000 + q."key"
                FROM json_each(k."problems") AS q
                WHERE json_extract(q."value", '$.source') NOT IN (SELECT "value" FROM json_each(k."sources"))
                ORDER BY 2
            ) AS p
        )
        ELSE '[]'
    END,
    s."postings", s."query", s."source", s."updatedAt", COALESCE(k."addedBy", '')
FROM "PostingSearch" AS s
LEFT JOIN "jobauto_SearchSources" AS k ON k."id" = s."id";
DROP TABLE "PostingSearch";
ALTER TABLE "new_PostingSearch" RENAME TO "PostingSearch";
CREATE INDEX "PostingSearch_createdAt_idx" ON "PostingSearch"("createdAt");
CREATE INDEX "PostingSearch_agentSearchId_idx" ON "PostingSearch"("agentSearchId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- DropTable
DROP TABLE "jobauto_CallPrep";
DROP TABLE "jobauto_SearchSources";
