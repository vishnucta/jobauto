import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { AiError } from "@/lib/ai/errors";
import { germanFit, textForGerman, profileGerman } from "@/lib/german-need";
import { dayOf } from "@/lib/calendar-view";
import { searchPostings } from "@/lib/job-search";
import { noteAgencies } from "@/lib/recruiters/store";
import { credentialsFor, loadJobSearchConfig, requestContext, type JobSearchConfig } from "@/lib/job-search/config";
import { JobSearchError } from "@/lib/job-search/errors";
import { postingKey, type FoundPosting } from "@/lib/job-search/search";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { logServerError } from "@/lib/log";
import { saveScore } from "@/lib/posting-scores";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { loadPostingScorer, scoringProblem } from "@/lib/scoring";
import { loadSettings } from "@/lib/settings-data";
import type { SettingsData, AgentSearchRun } from "@/lib/settings";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { attributeAgentCandidates } from "./attribution";
import { agentDedupeKey, candidateData } from "./candidates";
import { agentDraftJob, draftJobKey } from "./draft";
import { reconcileInterruptedRuns, recordRunEnd, recordSourceRequest, reserveRun } from "./runs";
import { listAgentSearches } from "./searches";
import { withAgentScanLock } from "./scan-lock";
import { agentSearchSetupProblem, type SavedAgentSearch } from "./search";

// One run: collect every enabled recurring search, then fairly evaluate
// new postings under shared score/draft limits. It never sends anything.
// Adapted from avinashbatchala's fork of Dossier.

export const agentScanResultSchema = z.object({
  /** Postings the source returned. */
  found: z.number().int().min(0),
  /** Of those, the ones not seen before. */
  fresh: z.number().int().min(0),
  scored: z.number().int().min(0),
  drafted: z.number().int().min(0),
  /** Found but seen before: saved, dismissed or applied for in Find jobs, or a candidate already. */
  skipped: z.number().int().min(0),
  /** What to tell the user. */
  message: z.string(),
});
export type AgentScanResult = z.infer<typeof agentScanResultSchema>;

const stopped = (message: string): AgentScanResult => ({ found: 0, fresh: 0, scored: 0, drafted: 0, skipped: 0, message });

/** Why the agent can't run at all, in words, or null when it's set up. */
export async function agentSetupProblem(): Promise<string | null> {
  const [searches, config] = await Promise.all([listAgentSearches(), loadJobSearchConfig()]);
  return setupProblemFor(searches, config);
}

async function setupProblemFor(searches: readonly SavedAgentSearch[], config: JobSearchConfig): Promise<string | null> {
  const searchProblem = agentSearchSetupProblem(searches);
  if (searchProblem) return searchProblem;
  // Scoring is what a run does; drafts ask the AI provider when there are any.
  const scoring = await scoringProblem();
  if (scoring) return scoring;
  if (!config.source) return "Choose a job source in Settings → Job search first.";
  // It searches on its own, which the BA's terms forbid most clearly (#223).
  if (config.source === "ARBEITSAGENTUR") return "The job agent doesn't search the Bundesagentur für Arbeit. Choose JSearch, SerpApi, Adzuna or FreeHire in Settings → Job search for it.";
  try {
    credentialsFor(config, config.source);
  } catch (error) {
    if (error instanceof JobSearchError) return error.message;
    throw error;
  }
  return null;
}

/** The postings from a page that are new to the agent: not saved, dismissed or applied for, and not a candidate already. */
export async function newPostings(postings: readonly FoundPosting[]): Promise<FoundPosting[]> {
  const states = await postingStates(postings);
  const unseen = postings.filter((posting) => {
    const state = states.get(postingKey(posting));
    return !state?.saved && !state?.dismissed && !state?.applicationId;
  });
  const keys = unseen.map(agentDedupeKey);
  const known = await prisma.agentCandidate.findMany({
    where: { OR: [...unseen.map(({ source, externalId }) => ({ source, externalId })), { dedupeKey: { in: keys } }] },
    select: { source: true, externalId: true, dedupeKey: true },
  });
  const seen = new Set(known.flatMap((candidate) => [postingKey(candidate), candidate.dedupeKey]));
  // The same job twice in one page counts once too.
  return unseen.filter((posting, index) => {
    const fresh = !seen.has(postingKey(posting)) && !seen.has(keys[index]);
    seen.add(keys[index]);
    return fresh;
  });
}

const newestFirst = (a: FoundPosting, b: FoundPosting) => (b.postedAt ? Date.parse(b.postedAt) : 0) - (a.postedAt ? Date.parse(a.postedAt) : 0);

/**
 * One run: each enabled search's first page only, then round-robin newest
 * new postings within each search, up to agentMaxScores. Each is kept as a
 * candidate, so it doesn't come back; one below agentMinScore stays out of
 * the queue. With auto-draft on, the best of them get a draft each, up to
 * agentMaxDrafts, each its own job. A scheduled run does nothing while the
 * agent is off.
 */
export async function runAgentScan({ manual }: { manual: boolean }, context: JobContext, now = new Date()): Promise<AgentScanResult> {
  const startedAt = Date.now();
  const requestNow = () => new Date(now.getTime() + Date.now() - startedAt);
  const result = await withAgentScanLock(async (signal) => {
    await reconcileInterruptedRuns();
    return scan(manual, { ...context, signal: AbortSignal.any([context.signal, signal]) }, now, requestNow);
  });
  return result ?? stopped("An agent scan is already running.");
}

async function scan(manual: boolean, context: JobContext, now: Date, requestNow: () => Date): Promise<AgentScanResult> {
  const settings = await loadSettings();
  if (!settings.agentEnabled && !manual) return stopped("The job agent is off.");
  // Two scheduler checks can queue work before either starts (and the local
  // AI runner may serialize those jobs). Recheck the day under scan ownership.
  if (!manual) {
    const timeZone = await lastKnownTimeZone();
    if (settings.agentRuns.some((run) => dayOf(new Date(run.at), timeZone) === dayOf(now, timeZone))) return stopped("The agent already ran today.");
  }
  // Validate and execute one configuration snapshot. Concurrent source/key
  // edits apply to the next run, not to slots already admitted for this one.
  const [allSearches, config] = await Promise.all([listAgentSearches(), loadJobSearchConfig()]);
  const setup = await setupProblemFor(allSearches, config);
  if (setup) return stopped(setup);
  const searches = allSearches.filter((search) => search.enabled);
  const source = config.source;
  // Keep this explicit server-side guard before admission as well as setup.
  if (!source || source === "ARBEITSAGENTUR") return stopped("Choose JSearch, SerpApi, Adzuna or FreeHire in Settings → Job search for the job agent.");
  const credentials = credentialsFor(config, source);
  const run = await reserveRun(now, manual, searches.length, await lastKnownTimeZone());
  if (typeof run === "string") return stopped(run);
  const results: AgentSearchRun[] = [];
  const pages: FoundPosting[][] = [];
  try {
    for (const search of searches) {
      if (context.signal.aborted) break;
      await context.step(searches.length === 1 ? "Searching for new postings" : `Searching ${search.name}`);
      if (context.signal.aborted) break;
      await recordSourceRequest(run, results.length, requestNow());
      let postings: FoundPosting[] = [];
      let errorMessage: string | null = null;
      try {
        // Sequential, first page only. Global credentials are never copied to searches.
        postings = (await searchPostings(source, credentials, search.query, null, requestContext(source))).postings;
      } catch (error) {
        errorMessage = error instanceof JobSearchError ? error.message : "The job source couldn't be reached. Try again.";
        if (!(error instanceof JobSearchError)) logServerError("job agent search", error);
      }
      pages.push(postings);
      results.push({ searchId: search.id, searchName: search.name, found: postings.length, fresh: 0, error: errorMessage });
      // Pass one links already-kept, non-dismissed candidates before dedupe
      // removes them from evaluation. No raw source results are persisted.
      await attributeAgentCandidates(search, postings);
      await recordRunEnd(run, null, results);
    }
    // The agent's daily searches can show an agency too: it goes on the Recruiters list.
    await noteAgencies(pages.flat(), "search");
    const freshPages: FoundPosting[][] = [];
    for (let i = 0; i < pages.length; i++) {
      const fresh = await newPostings(pages[i]);
      freshPages.push(fresh);
      results[i].fresh = fresh.length;
    }
    const ordered = roundRobinPostings(freshPages);
    const result = await evaluateAgentPostings(ordered, context, settings);
    result.found = pages.reduce((sum, page) => sum + page.length, 0);
    result.skipped = result.found - result.fresh;
    if (!result.fresh && result.found) result.message = "No new postings this time.";
    // Pass two links newly created candidates to EVERY matching search,
    // including overlaps whose duplicate posting was never scored separately.
    for (let i = 0; i < pages.length; i++) await attributeAgentCandidates(searches[i], pages[i]);
    const failures = results.filter((search) => search.error);
    if (failures.length) result.message += ` ${failures.map((search) => `${search.searchName}: ${search.error}`).join(" ")}`;
    await recordRunEnd(run, result.message, results);
    return result;
  } catch (error) {
    await recordRunEnd(run, "The agent scan was interrupted. Try again.", results);
    throw error;
  }
}

/** Newest-first within each search; cycle searches, skipping shared identities. */
export function roundRobinPostings(pages: readonly (readonly FoundPosting[])[]): FoundPosting[] {
  const queues = pages.map((page) => page.toSorted(newestFirst));
  const seen = new Set<string>();
  const ordered: FoundPosting[] = [];
  while (queues.some((queue) => queue.length)) {
    for (const queue of queues) {
      while (queue.length) {
        const posting = queue.shift()!;
        const key = agentDedupeKey(posting);
        if (seen.has(key) || seen.has(postingKey(posting))) continue;
        seen.add(key);
        seen.add(postingKey(posting));
        ordered.push(posting);
        break;
      }
    }
  }
  return ordered;
}

/** Evaluate one ordered collection with shared score/draft caps. No source calls. */
export async function evaluateAgentPostings(postings: readonly FoundPosting[], context: JobContext, settings: SettingsData): Promise<AgentScanResult> {
  const fresh = await newPostings(postings);
  const counts = { found: postings.length, fresh: fresh.length, skipped: postings.length - fresh.length, drafted: 0 };
  if (fresh.length === 0) return { ...counts, scored: 0, message: postings.length === 0 ? "The search found no postings this time." : "No new postings this time." };

  // Postings that need far more German than the profile has aren't scored: no AI is spent on them.
  const profile = await loadProfile();
  const german = profileGerman(profile.languages);
  const reachable = fresh.filter((posting) => germanFit(textForGerman(posting), german).verdict !== "out");
  const gated = fresh.length - reachable.length;
  const tooMuchGerman = gated ? ` ${gated} more ${gated === 1 ? "needs" : "need"} more German than your profile has, so ${gated === 1 ? "it wasn't" : "they weren't"} scored.` : "";
  if (reachable.length === 0) return { ...counts, scored: 0, message: `No new postings within reach this time.${tooMuchGerman}` };

  const toScore = reachable.slice(0, settings.agentMaxScores);
  await context.step(`Scoring ${toScore.length} ${toScore.length === 1 ? "posting" : "postings"}`);
  const score = await loadPostingScorer();
  let scored = 0;
  let queued = 0;
  const kept: string[] = [];
  let problem: string | null = null;
  for (const posting of toScore) {
    if (context.signal.aborted) break;
    try {
      const { data, scoredWith } = await score(posting, profile, context.signal);
      // A source/model may finish after cancellation (notably a data wipe).
      // Respect cancellation before writing, but this is not an atomic fence
      // against imports/wipes; that needs the broader background-job lifecycle.
      if (context.signal.aborted) break;
      const candidate = await prisma.agentCandidate.create({ data: candidateData(posting, data), select: { id: true } });
      // Find jobs shows it too (#208).
      await saveScore(posting, data, scoredWith);
      kept.push(candidate.id);
      scored += 1;
      if (data.score >= settings.agentMinScore) queued += 1;
    } catch (error) {
      // Another run kept it first: it's seen either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      // One posting that fails doesn't stop the rest.
      if (error instanceof AiError) problem = error.message;
      else if (!context.signal.aborted) logServerError("job agent scoring", error);
    }
  }

  // Auto-draft (#197, off by default): the best of this run's, one job each.
  let drafted = 0;
  if (settings.agentAutoDraft && settings.agentMaxDrafts > 0 && !context.signal.aborted) {
    const best = await prisma.agentCandidate.findMany({
      where: { id: { in: kept }, status: AgentCandidateStatus.SCORED, score: { gte: settings.agentMinScore } },
      orderBy: { score: "desc" },
      take: settings.agentMaxDrafts,
      select: { id: true },
    });
    for (const { id } of best) await startJob(agentDraftJob, { candidateId: id }, { key: draftJobKey(id) });
    drafted = best.length;
  }

  const waiting = `${queued} new ${queued === 1 ? "posting is" : "postings are"} waiting for a look.`;
  const message =
    scored === 0
      ? (problem ?? "No postings could be scored this time.")
      : queued === 0
        ? `Scored ${scored} new ${scored === 1 ? "posting" : "postings"}; none reached your minimum score of ${settings.agentMinScore}.`
        : drafted > 0
          ? `${waiting} Preparing ${drafted === 1 ? "a draft for the best one" : `drafts for the best ${drafted}`}.`
          : waiting;
  return { ...counts, scored, drafted, message: message + tooMuchGerman };
}
