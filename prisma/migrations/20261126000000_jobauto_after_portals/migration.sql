-- The jobauto fork after Dossier 1.15's migrations: a search's sources go
-- into 1.15's "portals" (searchPortalSchema in src/lib/job-search/search.ts),
-- in their order: each source that answered as done, with how many postings
-- it found and its next page, then each that didn't (and wasn't stood in
-- for) as failed, with why. CLIENT (an AI client's finds) and CAREERS
-- (careers pages) are portals like the others, and "addedBy" stays. The
-- postings themselves move into the library in code at start
-- (movePastSearches), as 1.15 does for its own past searches.

UPDATE "PostingSearch" AS s
SET "portals" = (
    SELECT COALESCE(jsonb_agg(p."portal" ORDER BY p."at"), '[]'::jsonb)
    FROM (
        SELECT jsonb_build_object(
                   'id', u."source",
                   'status', 'done',
                   'found', (
                       SELECT count(*)
                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s."postings") = 'array' THEN s."postings" ELSE '[]'::jsonb END) AS e("posting")
                       WHERE e."posting" ->> 'source' = u."source"
                   ),
                   'next', s."cursors" ->> u."source",
                   'message', NULL
               ) AS "portal",
               u."at" AS "at"
        FROM unnest(s."sources") WITH ORDINALITY AS u("source", "at")
        UNION ALL
        SELECT jsonb_build_object(
                   'id', q."problem" ->> 'source',
                   'status', 'failed',
                   'found', 0,
                   'next', NULL,
                   'message', q."problem" ->> 'message',
                   'problem', q."problem" ->> 'problem'
               ),
               1000 + q."at"
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(s."problems") = 'array' THEN s."problems" ELSE '[]'::jsonb END) WITH ORDINALITY AS q("problem", "at")
        WHERE NOT ((q."problem" ->> 'source') = ANY (s."sources"))
    ) AS p
)
WHERE jsonb_array_length(s."portals") = 0
  AND (cardinality(s."sources") > 0 OR jsonb_array_length(s."problems") > 0);

-- AlterTable
ALTER TABLE "PostingSearch" DROP COLUMN "cursors",
DROP COLUMN "problems",
DROP COLUMN "sources";
