-- The jobauto fork before Dossier 1.15's migrations, on SQLite. 1.15
-- rebuilds two tables the fork added columns to, copying only the columns
-- it knows, so what the fork keeps there waits in tables of its own until
-- 20261126000000_jobauto_after_portals puts it back:
-- - PostingSearch (20261115100000_positions_library): a search here asked
--   several sources at once ("sources", "cursors", "problems", and
--   "addedBy" for an AI client's), and 1.15 copies its one "source" and
--   "next", which 20261112120000_jobauto had dropped. So those come back
--   too: the first of "sources", and that source's next page.
-- - Application (20261117140000_application_profile): the call prep pack
--   ("prep", "prepWith").

CREATE TABLE "jobauto_SearchSources" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sources" JSONB NOT NULL,
    "cursors" JSONB NOT NULL,
    "problems" JSONB NOT NULL,
    "addedBy" TEXT NOT NULL
);
INSERT INTO "jobauto_SearchSources" ("id", "sources", "cursors", "problems", "addedBy")
SELECT "id", "sources", "cursors", "problems", "addedBy" FROM "PostingSearch";

ALTER TABLE "PostingSearch" ADD COLUMN "source" TEXT;
ALTER TABLE "PostingSearch" ADD COLUMN "next" TEXT;
UPDATE "PostingSearch"
SET "source" = json_extract("sources", '$[0]'),
    "next" = json_extract("cursors", '$."' || json_extract("sources", '$[0]') || '"')
WHERE json_array_length("sources") > 0;

CREATE TABLE "jobauto_CallPrep" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "prep" JSONB,
    "prepWith" TEXT
);
INSERT INTO "jobauto_CallPrep" ("id", "prep", "prepWith")
SELECT "id", "prep", "prepWith" FROM "Application" WHERE "prep" IS NOT NULL OR "prepWith" IS NOT NULL;
