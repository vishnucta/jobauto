import "server-only";

import { z } from "zod";

import { AGENT_JOB_KEY } from "@/lib/agent/jobs";
import { AiError } from "@/lib/ai/errors";
import { dayOf } from "@/lib/calendar-view";
import { fieldProfiles, herGerman } from "@/lib/field-data";
import { FIELD_NEW_DAYS, fieldMatch } from "@/lib/field-match";
import { germanFit, textForGerman } from "@/lib/german-need";
import type { FoundPosting } from "@/lib/job-search/search";
import { defineJob, findUnfinishedJobs, startJob, type JobContext } from "@/lib/jobs/runner";
import { withStates } from "@/lib/library";
import { logServerError } from "@/lib/log";
import { saveScore } from "@/lib/posting-scores";
import { foundFromPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { levelsProblem } from "@/lib/profiles";
import { loadPostingScorer, loadScoringProfile, scoringProblem } from "@/lib/scoring";
import { loadSettings, saveSettings } from "@/lib/settings-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

// Scoring the new postings in her field on their own (jobauto fork, "Niche
// first"): a few a day, so the postings that matter most to her don't wait
// for a click to say how well they fit. Only postings Positions already
// keeps are read; no job portal is asked for anything. A posting is scored
// with the scoring model Settings → Scoring chose, against her first profile
// in the field, exactly as Score in Positions scores it, and its score is
// kept where Positions and the job agent read it, so neither scores it again.
//
// It costs nothing while scoring is off: no scoring model set up, or the
// profile's levels not chosen. It never scores a posting that has a score,
// one that needs far more German than she has (as the job agent leaves
// those out), one she dismissed, archived or applied to, or more than the
// day's number (Settings → Scoring, 0 switches it off). The job agent's own
// limit (agentMaxScores a run) is separate and comes on top; while an agent
// run is queued or going, this waits, so the two never score side by side.

/** Keyed so the timer finds a scoring that's queued or running. */
export const FIELD_SCORING_JOB_KEY = "field-scoring";

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** How many were scored on `day` so far. */
const scoredOn = (kept: { day: string; count: number } | null, day: string) => (kept?.day === day ? kept.count : 0);

/**
 * What a scoring now would score, without spending anything: the profile, the
 * day, and the postings, newest found first; null when there is nothing to
 * do, or scoring has to wait.
 */
export async function fieldScoringPlan(now = new Date()): Promise<{ profileId: string; day: string; postings: FoundPosting[] } | null> {
  const settings = await loadSettings();
  if (settings.fieldScoresPerDay <= 0) return null;
  const day = dayOf(now, await lastKnownTimeZone());
  const left = settings.fieldScoresPerDay - scoredOn(settings.fieldScored, day);
  if (left <= 0) return null;
  // Scoring is off without a scoring model, or while the profile's levels aren't chosen (E24-3): nothing is spent then.
  if ((await scoringProblem()) !== null) return null;
  const [profile] = await fieldProfiles();
  if (!profile || (await levelsProblem(profile.id))) return null;
  // The job agent scores what its own searches found: it goes first, and its scores are reused here.
  if ((await findUnfinishedJobs(AGENT_JOB_KEY)).length > 0) return null;

  const rows = await prisma.posting.findMany({
    where: { mergedIntoId: null, removedAt: null, archivedAt: null, dismissedAt: null, applicationId: null, createdAt: { gte: new Date(now.getTime() - FIELD_NEW_DAYS * 86_400_000) } },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
  });
  const marked = rows.map(foundFromPosting).filter((posting) => fieldMatch(posting) !== null);
  if (marked.length === 0) return null;
  const german = await herGerman();
  const postings = (await withStates(marked))
    // Scored already, against this profile: never twice. Applied to through the same link: no longer open.
    .filter((posting) => posting.state.applicationId === null && !posting.state.scores.some((fit) => fit.profileId === profile.id))
    // Far more German than she has: not scored, as the job agent leaves those out.
    .filter((posting) => germanFit(textForGerman(posting), german).verdict !== "out")
    .slice(0, left)
    .map(({ state, ...posting }) => {
      void state;
      return posting;
    });
  return postings.length > 0 ? { profileId: profile.id, day, postings } : null;
}

export const fieldScoringResultSchema = z.object({ scored: z.number().int().min(0), message: z.string() });
export type FieldScoringResult = z.output<typeof fieldScoringResultSchema>;

/** Scores the day's new postings in her field, one after another, counting each as it's kept. */
export async function scoreFieldPostings(context: Pick<JobContext, "step" | "signal">, now = new Date()): Promise<FieldScoringResult> {
  const plan = await fieldScoringPlan(now);
  if (!plan) return { scored: 0, message: "Nothing in your field to score now." };
  await context.step(`Scoring ${plural(plan.postings.length, "posting", "postings")} in your field`);
  const [score, profile] = await Promise.all([loadPostingScorer(), loadScoringProfile(plan.profileId)]);
  let scored = 0;
  let problem: string | null = null;
  for (const posting of plan.postings) {
    if (context.signal.aborted) break;
    // An agent run that started meanwhile scores its own finds: this stops, and carries on at the next check.
    if ((await findUnfinishedJobs(AGENT_JOB_KEY)).length > 0) break;
    // Scored since the plan was made (Score in Positions, Claude): not again.
    if ((await prisma.postingScore.count({ where: { source: posting.source, externalId: posting.externalId, profileId: plan.profileId } })) > 0) continue;
    try {
      const answer = await score(posting, profile, context.signal);
      if (context.signal.aborted) break;
      await saveScore(posting, answer.data, answer.scoredWith, plan.profileId);
      scored += 1;
      // Counted as it's kept, so a restart in between doesn't forget what the day spent.
      const { fieldScored } = await loadSettings();
      await saveSettings({ fieldScored: { day: plan.day, count: scoredOn(fieldScored, plan.day) + 1 } });
    } catch (error) {
      // One posting that fails doesn't stop the rest; a model that isn't answering is tried again at the next check.
      if (error instanceof AiError) {
        problem = error.message;
        break;
      }
      if (!context.signal.aborted) logServerError("field scoring", error);
    }
  }
  return { scored, message: scored > 0 ? `Scored ${plural(scored, "new posting", "new postings")} in your field.` : (problem ?? "Nothing in your field was scored this time.") };
}

export const fieldScoringJob = defineJob({
  type: "field-scoring",
  input: z.object({}),
  result: fieldScoringResultSchema,
  run: (_input, context) => scoreFieldPostings(context),
});

// ─── The daily scoring ──────────────────────────────────────────────────────
// A timer in this process, like the careers check's: every 30 minutes from
// 08:00 in her time zone (after the careers check at 06:00 and the job
// agent's usual 07:00, so the day's new postings are in Positions), it scores
// what the day's number still allows. Later in the day it picks up what
// searches found since, while the number isn't used up.

const EVERY_MS = 30 * 60 * 1000;
const FROM_HOUR = 8;

/** Whether the hour for it has come, in `timeZone`. */
export function fieldScoringHour(now: Date, timeZone: string): boolean {
  return Number(new Intl.DateTimeFormat("en-GB", { hour: "2-digit", hourCycle: "h23", timeZone }).format(now)) >= FROM_HOUR;
}

/** Starts a scoring when it's past the hour, there is something to score within the day's number, and none is queued or running. */
export async function startDueFieldScoring(now = new Date()): Promise<string | null> {
  if (!fieldScoringHour(now, await lastKnownTimeZone())) return null;
  if ((await findUnfinishedJobs(FIELD_SCORING_JOB_KEY)).length > 0) return null;
  if (!(await fieldScoringPlan(now))) return null;
  return startJob(fieldScoringJob, {}, { key: FIELD_SCORING_JOB_KEY });
}

const globalForField = globalThis as unknown as { fieldScoringTimer?: ReturnType<typeof setInterval> };

/** Starts the timer, once per process (dev reloads keep the one they have). */
export function startFieldScoringSchedule(): void {
  if (globalForField.fieldScoringTimer) return;
  const check = () => void startDueFieldScoring().catch((error: unknown) => logServerError("field scoring schedule", error));
  globalForField.fieldScoringTimer = setInterval(check, EVERY_MS);
  globalForField.fieldScoringTimer.unref?.();
  check();
}
