import "server-only";

import { z } from "zod";

import { Prisma } from "@/generated/prisma/client";
import { AgentCandidateStatus } from "@/generated/prisma/enums";
import { AiError } from "@/lib/ai/errors";
import { dayOf } from "@/lib/calendar-view";
import { germanFit, profileGerman, textForGerman } from "@/lib/german-need";
import { enabledPortals, loadJobSearchConfig, type JobSearchConfig } from "@/lib/job-search/config";
import { countryName } from "@/lib/job-search/countries";
import { postingKey, type FoundPosting, type JobSource, type SearchPortal } from "@/lib/job-search/search";
import { sourceCovers, sourceInfo } from "@/lib/job-search/sources";
import { startJob, type JobContext } from "@/lib/jobs/runner";
import { portalsOf, postingsOfSearch } from "@/lib/library";
import { logServerError } from "@/lib/log";
import type { EventData, PostingLine } from "@/lib/notifications/events";
import { emit } from "@/lib/notifications/notify";
import { runPortals } from "@/lib/posting-searches";
import { byBestFit, coverageOf, coversFromScore, coversLine, passes, type Coverage } from "@/lib/posting-coverage";
import { saveScore } from "@/lib/posting-scores";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { noteAgencies } from "@/lib/recruiters/store";
import { levelsProblem, listProfiles, profileIdOr, type LevelsProblem } from "@/lib/profiles";
import { breakdownOf, type PostingFit } from "@/lib/fit";
import { loadPostingScorer, loadScoringProfile, scoringProblem } from "@/lib/scoring";
import type { ScoringProfile } from "@/lib/scoring/questions";
import { loadSettings } from "@/lib/settings-data";
import { agentCoversOf, type SettingsData, type AgentSearchRun } from "@/lib/settings";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { attributeAgentCandidates } from "./attribution";
import { agentDedupeKeys, candidateCoverage, candidateData, stringsOf, type SkipReason } from "./candidates";
import { agentDraftJob, draftJobKey } from "./draft";
import { reconcileInterruptedRuns, recordRunEnd, recordSourceRequest, reserveRun } from "./runs";
import { agentMayAsk, agentPortalPool, agentPortals, portalProblem } from "./source";
import { listAgentSearches } from "./searches";
import { withAgentScanLock } from "./scan-lock";
import { agentSearchSetupProblem, type SavedAgentSearch } from "./search";

// One run: collect every enabled recurring search, then fairly evaluate
// new postings under shared score/draft limits. It never sends anything.
// Adapted from avinashbatchala's fork of Dossier. Since E22-8 (#394) each
// search asks every portal switched on that covers its country, as a search
// in Positions does, or the portals chosen for the agent (source.ts, jobauto
// fork), and what it finds lands in the library, "Found by the agent". The
// Bundesagentur für Arbeit is never asked (#223).

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
  const [searches, config, settings] = await Promise.all([listAgentSearches(), loadJobSearchConfig(), loadSettings()]);
  return setupProblemFor(searches, config, settings.agentPortals);
}

/** "JSearch: The portal couldn't be reached.", unless the message names the portal already. */
const withName = (id: string, message: string) => (message.startsWith(sourceInfo(id).name) ? message : `${sourceInfo(id).name}: ${message}`);

// The portals the agent asks are in source.ts: those switched on, with what
// they need saved, or the ones chosen for it in Settings → Job agent (jobauto
// fork); never the Bundesagentur für Arbeit, whose terms forbid searching on
// one's own most clearly (#223). Kept importable from here too.
export { agentPortals };

/** Each enabled search with the portals it goes to: the agent's that cover its country. */
export function agentPlan(searches: readonly SavedAgentSearch[], config: JobSearchConfig, chosen: readonly string[] | null): { search: SavedAgentSearch; portals: JobSource[] }[] {
  const portals = agentPortals(config, chosen);
  return searches.filter((search) => search.enabled).map((search) => ({ search, portals: portals.filter((id) => sourceCovers(id, search.query.country)) }));
}

/** The requests a run sends, one per search and portal, by portal: what the daily budget counts. */
export const planSlots = (plan: ReturnType<typeof agentPlan>): JobSource[] => plan.flatMap((entry) => entry.portals);

/** The requests the next run would send, for the budget. */
export async function agentSlots(): Promise<JobSource[]> {
  const [searches, config, settings] = await Promise.all([listAgentSearches(), loadJobSearchConfig(), loadSettings()]);
  return planSlots(agentPlan(searches, config, settings.agentPortals));
}

/** What the agent can't search without, when only the Bundesagentur is switched on (source.ts). */
const NO_AGENT_PORTAL =
  "The job agent has no portal it may search: the Bundesagentur can't be searched automatically, and no other portal has a key yet. Add a JSearch, SerpApi or Adzuna key in Settings → Job search, or choose FreeHire for it in Settings → Job agent.";

async function setupProblemFor(searches: readonly SavedAgentSearch[], config: JobSearchConfig, chosen: readonly string[] | null): Promise<string | null> {
  const searchProblem = agentSearchSetupProblem(searches);
  if (searchProblem) return searchProblem;
  // Scoring is what a run does; drafts ask the AI provider when there are any.
  const scoring = await scoringProblem();
  if (scoring) return scoring;
  // Its own portals, when some are chosen for it (jobauto fork).
  if (chosen) {
    const pool = agentPortalPool(config, chosen);
    if (pool.length === 0) return "None of the portals chosen for the job agent is there any more. Choose others in Settings → Job agent.";
    if (agentPortals(config, chosen).length === 0) return portalProblem(config, pool[0]);
  } else {
    const enabled = enabledPortals(config);
    if (enabled.length === 0) return "Switch on a portal in Settings → Job search first.";
    // It searches on its own, which the BA's terms forbid most clearly (#223); a key she has stands in (source.ts).
    const allowed = enabled.filter(agentMayAsk);
    if (agentPortals(config, null).length === 0) return allowed.length === 0 ? NO_AGENT_PORTAL : portalProblem(config, allowed[0]);
  }
  const plan = agentPlan(searches, config, chosen);
  if (planSlots(plan).length === 0) {
    const countries = [...new Set(plan.map((entry) => countryName(entry.search.query.country)))].join(", ");
    return chosen
      ? `None of the portals chosen for the job agent lists jobs in ${countries}. Choose one that does in Settings → Job agent.`
      : `None of the portals switched on for the job agent lists jobs in ${countries}. Switch on one that does in Settings → Job search.`;
  }
  return null;
}

/** The postings from a page that are new to the agent: not saved, dismissed, applied for or in the Archive, and not a candidate already. */
async function newPostings(postings: readonly FoundPosting[]): Promise<FoundPosting[]> {
  const states = await postingStates(postings);
  const unseen = postings.filter((posting) => {
    const state = states.get(postingKey(posting));
    return !state?.saved && !state?.dismissed && !state?.applicationId && !state?.archived;
  });
  // Each posting's keys: its own, and one for each other place it's listed to apply at (jobauto fork).
  const keys = unseen.map(agentDedupeKeys);
  // A posting a run skipped (E32-5) isn't seen yet: a later run can still score it.
  const known = await prisma.agentCandidate.findMany({
    where: { skipReason: null, OR: [...unseen.map(({ source, externalId }) => ({ source, externalId })), { dedupeKey: { in: keys.flat() } }] },
    select: { source: true, externalId: true, dedupeKey: true },
  });
  const seen = new Set(known.flatMap((candidate) => [postingKey(candidate), candidate.dedupeKey]));
  // The same job twice in one page counts once too.
  return unseen.filter((posting, index) => {
    const fresh = !seen.has(postingKey(posting)) && !keys[index].some((key) => seen.has(key));
    for (const key of keys[index]) seen.add(key);
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
  const setup = await setupProblemFor(allSearches, config, settings.agentPortals);
  if (setup) return stopped(setup);
  const plan = agentPlan(allSearches, config, settings.agentPortals);
  const searches = plan.map((entry) => entry.search);
  // Never the Bundesagentur: the pool leaves it out (source.ts).
  const allowed = agentPortalPool(config, settings.agentPortals);
  const run = await reserveRun(now, manual, planSlots(plan), await lastKnownTimeZone());
  if (typeof run === "string") return stopped(run);
  const results: AgentSearchRun[] = [];
  const pages: FoundPosting[][] = [];
  let slot = 0;
  try {
    for (const { search, portals } of plan) {
      if (context.signal.aborted) break;
      await context.step(searches.length === 1 ? "Searching for new postings" : `Searching ${search.name}`);
      if (context.signal.aborted) break;
      // Kept as a search, so what it finds is in Positions, "Found by the agent · <name>" (E22-8).
      const country = countryName(search.query.country);
      const skipped = (id: JobSource, message: string): SearchPortal => ({ id, status: "skipped", found: 0, next: null, message });
      const asked: SearchPortal[] = [
        ...portals.map((id): SearchPortal => ({ id, status: "waiting", found: 0, next: null, message: null })),
        ...allowed.filter((id) => !portals.includes(id)).map((id) => skipped(id, sourceCovers(id, search.query.country) ? (portalProblem(config, id) ?? "") : `${sourceInfo(id).name} doesn't cover ${country}.`)),
      ];
      const kept = await prisma.postingSearch.create({ data: { query: search.query, portals: asked, found: 0, agentSearchId: search.id, agentSearchName: search.name }, select: { id: true } });
      // Each request counts before it's sent, failed ones too; first page only, the portals four at a time.
      for (let index = 0; index < portals.length; index++) await recordSourceRequest(run, slot++, requestNow());
      if (portals.length > 0) await runPortals(kept.id, portals, { signal: context.signal });
      const answered = portalsOf((await prisma.postingSearch.findUniqueOrThrow({ where: { id: kept.id }, select: { portals: true } })).portals);
      const postings = await postingsOfSearch(kept.id);
      pages.push(postings);
      const failed = answered.filter((portal) => portals.includes(portal.id as JobSource) && (portal.status === "failed" || portal.status === "skipped"));
      results.push({
        searchId: search.id,
        searchName: search.name,
        found: postings.length,
        fresh: 0,
        error:
          portals.length === 0
            ? `None of the portals the agent uses lists jobs in ${country}.`
            : failed.length > 0
              ? failed.map((portal) => withName(portal.id, portal.message ?? "It didn't answer.")).join(" ")
              : null,
        postingSearchId: kept.id,
        portals: answered.map(({ id, status, found, message }) => ({ id, status, found, message })),
      });
      // Pass one links already-kept, non-dismissed candidates before dedupe
      // removes them from evaluation.
      await attributeAgentCandidates(search, postings);
      await recordRunEnd(run, null, results);
    }
    // The agent's daily searches can show an agency too: it goes on the Recruiters list (jobauto fork).
    await noteAgencies(pages.flat(), "search");
    const freshPages: FoundPosting[][] = [];
    for (let i = 0; i < pages.length; i++) {
      const fresh = await newPostings(pages[i]);
      freshPages.push(fresh);
      results[i].fresh = fresh.length;
    }
    // What the user already had in Positions waits under Skipped (E32-5), saying why.
    await skipKnown(pages.flat());
    const ordered = roundRobinPostings(freshPages);
    // Each posting is scored with the profile of the first search that found it (E24-6), or every profile (E25-5).
    const profiles = new Map<string, string | null | "all">();
    freshPages.forEach((page, index) => {
      for (const posting of page) if (!profiles.has(postingKey(posting))) profiles.set(postingKey(posting), searches[index].allProfiles ? "all" : searches[index].profileId);
    });
    const result = await evaluateAgentPostings(ordered, context, settings, (posting) => profiles.get(postingKey(posting)) ?? null);
    result.found = pages.reduce((sum, page) => sum + page.length, 0);
    result.skipped = result.found - result.fresh;
    if (!result.fresh && result.found) result.message = "No new postings this time.";
    // Pass two links newly created candidates to EVERY matching search,
    // including overlaps whose duplicate posting was never scored separately.
    for (let i = 0; i < pages.length; i++) await attributeAgentCandidates(searches[i], pages[i]);
    const failures = results.filter((search) => search.error);
    if (failures.length) result.message += ` ${failures.map((search) => `${search.searchName}: ${search.error}`).join(" ")}`;
    await recordRunEnd(run, result.message, results);
    // One message per scheduled run (E26-4); Run now and Positions' searches never send one.
    if (!manual && !context.signal.aborted) await emit("agent.run.finished", await runSummary(results, freshPages));
    return result;
  } catch (error) {
    await recordRunEnd(run, "The agent scan was interrupted. Try again.", results);
    throw error;
  }
}

/**
 * What a run's message says (E26-4, N2, N3): how many are new, each
 * search's new ones with its best, the portals that failed and why, and for
 * webhooks every new posting with the portals that found it and its scores
 * per profile. Never a posting's text.
 */
async function runSummary(results: readonly AgentSearchRun[], freshPages: readonly (readonly FoundPosting[])[]): Promise<EventData["agent.run.finished"]> {
  const unique = [...new Map(freshPages.flat().map((posting) => [postingKey(posting), posting])).values()];
  const [states, profiles] = await Promise.all([postingStates(unique), listProfiles()]);
  const profileName = (id: string) => profiles.find((profile) => profile.id === id)?.name ?? "";
  const several = profiles.length > 1;
  const best = (page: readonly FoundPosting[]) =>
    page
      .map((posting) => ({ posting, fit: states.get(postingKey(posting))?.score ?? null }))
      .filter((entry) => entry.fit !== null)
      .map((entry) => ({ ...entry, coverage: coverageOf(entry.fit), at: 0 }))
      .sort(byBestFit)[0];
  const failed = new Map<string, string>();
  for (const search of results) for (const portal of search.portals ?? []) if (portal.status === "failed" && !failed.has(portal.id)) failed.set(portal.id, portal.message ?? "It didn't answer.");
  const ran = results.flatMap((search) => search.postingSearchId ?? []);
  return {
    newCount: unique.length,
    searches: results.map((search, index) => {
      const top = best(freshPages[index] ?? []);
      return {
        name: search.searchName,
        newCount: freshPages[index]?.length ?? 0,
        best: top ? { title: top.posting.title, company: top.posting.company, coverage: top.coverage.total > 0 ? { hit: top.coverage.hit, total: top.coverage.total } : null, profile: several ? profileName(top.fit!.profileId) : "" } : null,
      };
    }),
    failed: [...failed].map(([id, why]) => ({ portal: sourceInfo(id).name, why })),
    postings: unique.map((posting) => {
      const state = states.get(postingKey(posting));
      return {
        title: posting.title,
        company: posting.company,
        place: posting.place,
        url: posting.url,
        portals: (state?.foundOn ?? [{ portal: posting.source, url: posting.url }]).map((entry) => sourceInfo(entry.portal).name),
        scores: (state?.scores ?? []).map((fit) => ({ profile: profileName(fit.profileId), score: fit.score })),
      };
    }),
    // Positions, filtered to the run: its search, or its searches together, best first.
    path: ran.length > 0 ? `/jobs?found=${ran.join(",")}` : "/jobs?found=agent",
  };
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
        const keys = agentDedupeKeys(posting);
        if (keys.some((key) => seen.has(key)) || seen.has(postingKey(posting))) continue;
        for (const key of keys) seen.add(key);
        seen.add(postingKey(posting));
        ordered.push(posting);
        break;
      }
    }
  }
  return ordered;
}

/**
 * Evaluate one ordered collection with shared score/draft caps. No source
 * calls. One scored before (Score in Positions) keeps its score and costs
 * nothing; the rest are scored up to agentMaxScores, and those past it stay
 * in the library unscored.
 */
async function evaluateAgentPostings(
  postings: readonly FoundPosting[],
  context: JobContext,
  settings: SettingsData,
  /** The profile a posting is scored with (E24-6): its search's, "all" for every profile (E25-5); the first when none is given. */
  profileOf: (posting: FoundPosting) => string | null | "all" = () => null,
): Promise<AgentScanResult> {
  const fresh = await newPostings(postings);
  const counts = { found: postings.length, fresh: fresh.length, skipped: postings.length - fresh.length, drafted: 0 };
  // The queue's cut-off (E32-2).
  const covers = agentCoversOf(settings);
  if (fresh.length === 0) return { ...counts, scored: 0, message: postings.length === 0 ? "The search found no postings this time." : "No new postings this time." };

  // Postings that need far more German than the profile has aren't scored: no AI is spent on them (jobauto fork).
  // They wait under Skipped, saying why, and a later run looks at them again. Languages are shared by every profile.
  const german = profileGerman(await prisma.language.findMany({ select: { name: true, level: true }, orderBy: [{ sort: "asc" }, { createdAt: "asc" }] }));
  const outOfReach = new Set(fresh.filter((posting) => germanFit(textForGerman(posting), german).verdict === "out"));
  const gated = outOfReach.size;
  const tooMuchGerman = gated ? ` ${gated} more ${gated === 1 ? "needs" : "need"} more German than your profile has, so ${gated === 1 ? "it wasn't" : "they weren't"} scored.` : "";
  if (gated > 0 && !context.signal.aborted) await skipCandidates([...outOfReach], "german");
  const reachable = fresh.filter((posting) => !outOfReach.has(posting));
  if (reachable.length === 0) return { ...counts, scored: 0, message: `No new postings within reach this time.${tooMuchGerman}` };

  // Scores kept before, per profile (E25-5): they cost nothing again.
  const scoreKey = (posting: Pick<FoundPosting, "source" | "externalId">, profileId: string) => `${postingKey(posting)}|${profileId}`;
  const known = new Map(
    (await prisma.postingScore.findMany({ where: { OR: reachable.map(({ source, externalId }) => ({ source, externalId })) } })).map((row) => [
      scoreKey(row, row.profileId),
      { data: { score: row.score, reasons: stringsOf(row.reasons), redFlags: stringsOf(row.redFlags), breakdown: breakdownOf(row.breakdown) }, scoredWith: row.scoredWith },
    ]),
  );
  // Each profile, read once: its levels must be chosen before anything is scored with it (E24-3), and nothing guesses them.
  const all = await listProfiles();
  const levelsWait = new Map<string, LevelsProblem | null>();
  for (const { id } of all) levelsWait.set(id, await levelsProblem(id));
  const asked = new Map<string | null, string[]>();
  for (const posting of reachable) {
    const wanted = profileOf(posting);
    if (!asked.has(wanted)) asked.set(wanted, wanted === "all" ? all.map((profile) => profile.id) : [await profileIdOr(wanted)]);
  }
  /** The profiles a posting is scored against: those asked for whose levels are chosen. */
  const targetsOf = (posting: FoundPosting) => asked.get(profileOf(posting))!.filter((id) => !levelsWait.get(id));
  const unscored = reachable.filter((posting) => targetsOf(posting).some((id) => !known.has(scoreKey(posting, id))));
  // The cap counts postings, whatever number of profiles each is scored against (M1c).
  const toScore = new Set(unscored.slice(0, settings.agentMaxScores));
  const evaluated = reachable.filter((posting) => targetsOf(posting).length > 0 && (toScore.has(posting) || targetsOf(posting).every((id) => known.has(scoreKey(posting, id)))));
  await context.step(`Scoring ${toScore.size} ${toScore.size === 1 ? "posting" : "postings"}`);
  const score = await loadPostingScorer();
  const loaded = new Map<string, ScoringProfile>();
  const profileData = async (id: string) => loaded.get(id) ?? loaded.set(id, await loadScoringProfile(id)).get(id)!;
  let scored = 0;
  let queued = 0;
  const kept: string[] = [];
  // A profile whose postings wait for its levels: the first asked for and left out.
  const blockedId = reachable.flatMap((posting) => (targetsOf(posting).length === 0 ? asked.get(profileOf(posting))! : [])).find((id) => levelsWait.get(id));
  const blocked = blockedId ? levelsWait.get(blockedId)! : null;
  let problem: string | null = blocked ? `${blocked.message} Choose them in Profile → Jobs it's for.` : null;
  // Strong new matches (jobauto fork): those covering at least the alert's cut-off, for one notification.
  const strongCovers = coversFromScore(settings.alertMinScore);
  const strong: { line: PostingLine; coverage: Coverage; at: number }[] = [];
  for (const posting of evaluated) {
    if (context.signal.aborted) break;
    try {
      // Each profile it's scored against; the candidate keeps the best.
      let best: { data: PostingFit; scoredWith: string } | null = null;
      let bestProfile = "";
      for (const id of targetsOf(posting)) {
        const answer = known.get(scoreKey(posting, id)) ?? (await score(posting, await profileData(id), context.signal));
        if (context.signal.aborted) break;
        // Positions shows it too (#208).
        if (!known.has(scoreKey(posting, id))) await saveScore(posting, answer.data, answer.scoredWith, id);
        // The best coverage (E32-2), as Best fit orders it.
        if (!best || byBestFit({ coverage: coverageOf(answer.data), at: 0 }, { coverage: coverageOf(best.data), at: 0 }) < 0) {
          best = answer;
          bestProfile = id;
        }
      }
      if (!best) continue;
      const { data } = best;
      // A source/model may finish after cancellation (notably a data wipe).
      // Respect cancellation before writing, but this is not an atomic fence
      // against imports/wipes; that needs the broader background-job lifecycle.
      if (context.signal.aborted) break;
      const candidate = await keepCandidate(posting, data);
      kept.push(candidate.id);
      scored += 1;
      if (passes(coverageOf(data), covers)) queued += 1;
      const coverage = coverageOf(data);
      if (passes(coverage, strongCovers)) {
        const profile = all.length > 1 ? (all.find((entry) => entry.id === bestProfile)?.name ?? "") : "";
        strong.push({ coverage, at: 0, line: { title: posting.title, company: posting.company, coverage: coverage.total > 0 ? { hit: coverage.hit, total: coverage.total } : null, profile } });
      }
    } catch (error) {
      // Another run kept it first: it's seen either way.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      // One posting that fails doesn't stop the rest.
      if (error instanceof AiError) problem = error.message;
      else if (!context.signal.aborted) logServerError("job agent scoring", error);
    }
  }

  // One notification for the strong new matches, after Run now too (jobauto fork; it was the ntfy phone alert).
  if (strong.length > 0 && !context.signal.aborted) await emit("matches.strong", { postings: strong.sort(byBestFit).map((entry) => entry.line), path: "/agent" });

  // What the scoring limit left out waits under Skipped (E32-5), still new to a later run.
  if (!context.signal.aborted) await skipCandidates(reachable.filter((posting) => targetsOf(posting).length > 0 && !evaluated.includes(posting)), "budget");

  // Auto-draft (#197, off by default): the best of this run's, one job each.
  let drafted = 0;
  if (settings.agentAutoDraft && settings.agentMaxDrafts > 0 && !context.signal.aborted) {
    // Best fit first; one with no requirements is never drafted on its own (decided 17 November).
    const best = (
      await prisma.agentCandidate.findMany({
        where: { id: { in: kept }, status: AgentCandidateStatus.SCORED, skipReason: null, requirements: { gt: 0 } },
        select: { id: true, covered: true, requirements: true, mustMissing: true, createdAt: true },
      })
    )
      .map((candidate) => ({ id: candidate.id, coverage: candidateCoverage(candidate), at: candidate.createdAt.getTime() }))
      .filter((candidate) => passes(candidate.coverage, covers))
      .sort(byBestFit)
      .slice(0, settings.agentMaxDrafts);
    // Drafts it prepares on its own say so when they're ready (E26-6).
    for (const { id } of best) await startJob(agentDraftJob, { candidateId: id, auto: true }, { key: draftJobKey(id) });
    drafted = best.length;
  }

  const waiting = `${queued} new ${queued === 1 ? "posting is" : "postings are"} waiting for a look.`;
  const message =
    scored === 0
      ? (problem ?? "No postings could be scored this time.")
      : queued === 0
        ? `Scored ${scored} new ${scored === 1 ? "posting" : "postings"}; none ${coversLine(covers) ?? "covers enough of the requirements"}.`
        : drafted > 0
          ? `${waiting} Preparing ${drafted === 1 ? "a draft for the best one" : `drafts for the best ${drafted}`}.`
          : waiting;
  // Some were scored, but a profile's postings wait for its levels (E24-6).
  const waitingFor = scored > 0 && blocked ? ` Postings found for “${blocked.name}” wait until its levels are chosen in Profile → Jobs it's for.` : "";
  return { ...counts, scored, drafted, message: message + waitingFor + tooMuchGerman };
}

/**
 * Keeps a scored posting as a candidate; one a run skipped before (E32-5)
 * becomes that candidate, with its skip gone.
 */
async function keepCandidate(posting: FoundPosting, fit: PostingFit): Promise<{ id: string }> {
  const data = candidateData(posting, fit);
  const skipped = await prisma.agentCandidate.findFirst({
    where: { skipReason: { not: null }, OR: [{ source: posting.source, externalId: posting.externalId }, { dedupeKey: { in: agentDedupeKeys(posting) } }] },
    select: { id: true },
  });
  if (!skipped) return prisma.agentCandidate.create({ data, select: { id: true } });
  return prisma.agentCandidate.update({ where: { id: skipped.id }, data: { ...data, skipReason: null, status: AgentCandidateStatus.SCORED }, select: { id: true } });
}

/** Keeps postings a run didn't score, with why (E32-5); one it knows already, scored or skipped, stays as it is. */
async function skipCandidates(postings: readonly FoundPosting[], reason: SkipReason): Promise<number> {
  let kept = 0;
  for (const posting of postings) {
    try {
      await prisma.agentCandidate.create({ data: { ...candidateData(posting, { score: 0, reasons: [], redFlags: [] }), skipReason: reason } });
      kept += 1;
    } catch (error) {
      // Known already (the same job, or this posting): nothing to add.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") continue;
      throw error;
    }
  }
  return kept;
}

/** Postings a run found that the user already saved, applied for, archived or dismissed: skipped, saying which (E32-5). */
async function skipKnown(postings: readonly FoundPosting[]): Promise<void> {
  const states = await postingStates(postings);
  const of = (reason: SkipReason) =>
    postings.filter((posting) => {
      const state = states.get(postingKey(posting));
      if (!state) return false;
      return reason === "dismissed" ? state.dismissed : !state.dismissed && (state.saved || state.applicationId !== null || state.archived);
    });
  await skipCandidates(of("dismissed"), "dismissed");
  await skipCandidates(of("known"), "known");
}
