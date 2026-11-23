-- The jobauto fork, on SQLite: every place a portal listed to apply at, kept
-- with the posting ("applyOptions", a JSON list of { name, url }), so its
-- link can be the employer's own (src/lib/apply/link-owner.ts) and the others
-- shown. A column that starts empty: rows already there keep their link and
-- get none.

-- AlterTable
ALTER TABLE "Posting" ADD COLUMN "applyOptions" JSONB;
