import "server-only";

import { z } from "zod";

import { alertIfOn, matchLines } from "@/lib/alerts";
import { dayOf } from "@/lib/calendar-view";
import { EMPTY_QUERY, postingKey, searchRunHref, type FoundPosting } from "@/lib/job-search/search";
import { defineJob, findUnfinishedJobs, startJob, type JobContext } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { addClientSearch } from "@/lib/posting-searches";
import { prisma } from "@/lib/prisma";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { boardFor } from "./boards";
import { careersCheckResultSchema, type CareersCheckResult } from "./check-result";
import { listOf, matchesEmployer } from "./match";
import { CareersError, readBoard } from "./read";

// Checking the careers pages the user follows (jobauto fork): once a day,
// and on Check now. Each page's jobs that match its words and places, and
// that Dossier doesn't have yet, go into Find jobs together as one search
// from the CAREERS source, and to the phone as one alert.

export { careersCheckResultSchema, type CareersCheckResult };

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** Checks the given employers, or every one that's on, one page after another. */
export async function checkCareersPages({ ids }: { ids?: string[] }, context: Pick<JobContext, "step" | "signal">, now = new Date()): Promise<CareersCheckResult> {
  const employers = await prisma.employer.findMany({ where: ids ? { id: { in: ids } } : { enabled: true }, orderBy: { name: "asc" } });
  const found: FoundPosting[] = [];
  const owner = new Map<string, string>();
  const matched = new Map<string, number>();
  const problems: string[] = [];
  let checked = 0;
  for (const employer of employers) {
    if (context.signal.aborted) break;
    checked += 1;
    await context.step(employers.length === 1 ? `Reading ${employer.name}'s careers page` : `Reading ${employer.name}'s careers page (${employers.indexOf(employer) + 1} of ${employers.length})`);
    const board = boardFor(employer.careersUrl);
    try {
      if (!board) throw new CareersError("That isn't a web address.");
      const jobs = (await readBoard(board, employer.name, listOf(employer.keywords))).filter((posting) => posting.title && matchesEmployer(posting, employer));
      matched.set(employer.id, jobs.length);
      for (const posting of jobs) {
        if (owner.has(postingKey(posting))) continue;
        owner.set(postingKey(posting), employer.id);
        found.push(posting);
      }
      await prisma.employer.update({ where: { id: employer.id }, data: { lastCheckedAt: now, lastMatched: jobs.length, lastNew: 0, problem: null } });
    } catch (error) {
      const problem = error instanceof CareersError ? error.message : "Its careers page couldn't be read.";
      if (!(error instanceof CareersError)) logServerError("careers page", error);
      problems.push(`${employer.name}: ${problem}`);
      await prisma.employer.update({ where: { id: employer.id }, data: { lastCheckedAt: now, problem } });
    }
  }

  // Jobs Dossier has already, from this source or any other, stay out (knownJobs).
  const names = [...new Set(found.map((posting) => employers.find((employer) => employer.id === owner.get(postingKey(posting)))!.name))];
  const { id, added } = found.length
    ? await addClientSearch({ source: "CAREERS", addedBy: names.join(", ").slice(0, 200), query: { ...EMPTY_QUERY, keywords: "New jobs on careers pages" }, postings: found })
    : { id: null, added: [] };
  const newBy = new Map<string, number>();
  for (const posting of added) newBy.set(owner.get(postingKey(posting))!, (newBy.get(owner.get(postingKey(posting))!) ?? 0) + 1);
  for (const [employerId, count] of newBy) await prisma.employer.update({ where: { id: employerId }, data: { lastNew: count } });

  if (added.length > 0) {
    await alertIfOn({ title: `${plural(added.length, "new job", "new jobs")} on careers pages you follow`, message: matchLines(added), open: id ? searchRunHref(id) : "/careers" });
  }
  const message =
    employers.length === 0
      ? "There are no careers pages to check. Add an employer first."
      : `${added.length > 0 ? `${plural(added.length, "new job", "new jobs")} added to Find jobs` : "No new jobs"} from ${plural(employers.length, "careers page", "careers pages")}.${problems.length ? ` ${plural(problems.length, "page", "pages")} couldn't be read.` : ""}`;
  return { checked, added: added.length, searchId: id, problems, message };
}

/** Keyed so Check now and the daily check find one that's queued or running. */
export const CAREERS_JOB_KEY = "careers-check";

export const careersCheckJob = defineJob({
  type: "careers-check",
  input: z.object({ ids: z.array(z.string()).optional() }),
  result: careersCheckResultSchema,
  run: async (input, context) => {
    const result = await checkCareersPages(input, context);
    if (!input.ids) await saveSettings({ careersCheckedOn: dayOf(new Date(), await lastKnownTimeZone()) });
    return result;
  },
});

/** Check now: one employer, or all that are on; a check already queued or running is reused. */
export async function startCareersCheck(ids?: string[]): Promise<{ jobId: string; reused: boolean }> {
  const [unfinished] = await findUnfinishedJobs(CAREERS_JOB_KEY);
  if (unfinished) return { jobId: unfinished.id, reused: true };
  return { jobId: await startJob(careersCheckJob, ids ? { ids } : {}, { key: CAREERS_JOB_KEY }), reused: false };
}

// ─── The daily check ────────────────────────────────────────────────────────
// A timer in this process, like the job agent's: every 30 minutes it starts
// the day's check once it's past 06:00 in the user's time zone.

const EVERY_MS = 30 * 60 * 1000;
const FROM_HOUR = 6;

/** Whether the day's check should start now: past the hour, and none ran today. */
export function careersCheckDue(now: Date, timeZone: string, checkedOn: string | null): boolean {
  const hour = Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now));
  return hour >= FROM_HOUR && checkedOn !== dayOf(now, timeZone);
}

export async function startDueCareersCheck(now = new Date()): Promise<string | null> {
  const { careersCheckedOn } = await loadSettings();
  if (!careersCheckDue(now, await lastKnownTimeZone(), careersCheckedOn)) return null;
  if ((await prisma.employer.count({ where: { enabled: true } })) === 0) return null;
  if ((await findUnfinishedJobs(CAREERS_JOB_KEY)).length > 0) return null;
  return startJob(careersCheckJob, {}, { key: CAREERS_JOB_KEY });
}

const globalForCareers = globalThis as unknown as { careersTimer?: ReturnType<typeof setInterval> };

/** Starts the timer, once per process (dev reloads keep the one they have). */
export function startCareersSchedule(): void {
  if (globalForCareers.careersTimer) return;
  const check = () => void startDueCareersCheck().catch((error: unknown) => logServerError("careers pages schedule", error));
  globalForCareers.careersTimer = setInterval(check, EVERY_MS);
  globalForCareers.careersTimer.unref?.();
  check();
}
