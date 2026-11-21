-- The jobauto fork before Dossier 1.15's migrations. A search here asked
-- several sources at once (20261102150000_search_sources dropped its one
-- "source" and "next" for "sources", "cursors" and "problems"), which 1.15's
-- migrations don't know: they change "source" to text, drop the
-- PostingSource type and make "source" optional. So this puts back what they
-- expect: "source" as the first of "sources" and "next" as that source's next
-- page, and makes "sources" a list of text so the type can go.
-- 20261126000000_jobauto_after_portals then carries "sources", "cursors" and
-- "problems" into 1.15's "portals" and drops them.

ALTER TABLE "PostingSearch" ADD COLUMN "source" "PostingSource",
ADD COLUMN "next" TEXT;

UPDATE "PostingSearch"
SET "source" = "sources"[1],
    "next" = "cursors" ->> ("sources"[1]::text)
WHERE cardinality("sources") > 0;

ALTER TABLE "PostingSearch" ALTER COLUMN "sources" DROP DEFAULT;
ALTER TABLE "PostingSearch" ALTER COLUMN "sources" SET DATA TYPE TEXT[] USING "sources"::text[];
ALTER TABLE "PostingSearch" ALTER COLUMN "sources" SET DEFAULT ARRAY[]::TEXT[];
