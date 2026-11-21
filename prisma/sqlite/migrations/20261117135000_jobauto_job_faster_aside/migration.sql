-- The jobauto fork, on SQLite. The work sample and experiment columns
-- ("workSample", "workSampleWith", "experiment", "arm") came on the
-- job-faster branch as 20261120110000_experiments and
-- 20261120120000_work_sample, written before Dossier 1.15's migrations. A
-- database that ran them before 1.15's has the columns already when
-- 20261117140000_application_profile rebuilds "Application", copying only
-- the columns 1.15 knows, and since they count as applied they don't run
-- again. So every application waits here as it is, with whatever columns
-- it has, until 20261126100000_jobauto_job_faster puts the four back. A
-- database that never ran them keeps a copy without them, which changes
-- nothing.

CREATE TABLE "jobauto_ApplicationAside" AS SELECT * FROM "Application";
