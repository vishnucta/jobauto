-- A search may ask several sources at once: which ones answered, each one's
-- next page, and what went wrong with any that didn't.
ALTER TABLE "PostingSearch" ADD COLUMN "sources" "PostingSource"[] NOT NULL DEFAULT ARRAY[]::"PostingSource"[];
ALTER TABLE "PostingSearch" ADD COLUMN "cursors" JSONB NOT NULL DEFAULT '{}';
ALTER TABLE "PostingSearch" ADD COLUMN "problems" JSONB NOT NULL DEFAULT '[]';
UPDATE "PostingSearch"
SET "sources" = ARRAY["source"],
    "cursors" = CASE WHEN "next" IS NULL THEN '{}'::jsonb ELSE jsonb_build_object("source"::text, "next") END;
ALTER TABLE "PostingSearch" DROP COLUMN "source";
ALTER TABLE "PostingSearch" DROP COLUMN "next";
