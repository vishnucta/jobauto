import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { daysBetween, formatDay, formatTime } from "@/lib/dates";
import { askSource } from "@/lib/job-search/find";
import {
  EMPTY_QUERY,
  foundPostingSchema,
  isJobSource,
  jobKeys,
  postingKey,
  searchQuerySchema,
  type FoundPosting,
  type PastSearchDay,
  type PostingOrigin,
  type SearchProblem,
  type SearchQuery,
  type ShownPosting,
  type StoredSearch,
} from "@/lib/job-search/search";
import { postingStates } from "@/lib/postings";
import { prisma } from "@/lib/prisma";

// Searches kept with what they found (E14-10), until the user removes them,
// so going back to one costs no searches from the source's plan.

/** The postings column, read back; a posting that no longer fits the shape is left out. */
function postingsOf(value: Prisma.JsonValue): FoundPosting[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const posting = foundPostingSchema.safeParse(item);
    return posting.success ? [posting.data] : [];
  });
}

const queryOf = (value: Prisma.JsonValue): SearchQuery => searchQuerySchema.catch(EMPTY_QUERY).parse(value);

/** Postings with where each stands for the user now. */
async function withStates(postings: FoundPosting[]): Promise<ShownPosting[]> {
  const states = await postingStates(postings);
  return postings.map((posting) => ({ ...posting, state: states.get(postingKey(posting))! }));
}

/** "today at 14:32", "yesterday at 09:05" or "on Thu 1 Oct at 18:20". */
function ranAtLabel(date: Date, timeZone?: string, now = new Date()): string {
  const days = daysBetween(date, now, timeZone);
  const day = days === 0 ? "today" : days === 1 ? "yesterday" : `on ${formatDay(date, timeZone, now)}`;
  return `${day} at ${formatTime(date, timeZone)}`;
}

/** Runs a search on the chosen source and keeps it with its first page. */
export async function runSearch(query: SearchQuery): Promise<{ ok: true; id: string } | SearchProblem> {
  const answer = await askSource(query);
  if (!answer.ok) return answer;
  const search = await prisma.postingSearch.create({
    data: { source: answer.source, query, postings: answer.postings, found: answer.postings.length, next: answer.next },
    select: { id: true },
  });
  return { ok: true, id: search.id };
}

/** Where Dossier already has a job, so an AI client's add leaves it out: the most telling place when it's in several. */
export type KnownJob =
  | { where: "application"; applicationId: string }
  | { where: "saved" | "dismissed"; postingId: string }
  | { where: "search"; searchId: string; number: number; source: PostingOrigin; addedBy: string }
  | { where: "agent" }
  | { where: "twice" };

/**
 * Every job Dossier has, by its keys (jobKeys): applied to, saved, dismissed,
 * in a kept search from any source, or found by the job agent. Where one is
 * in several places, the one the user acted on most wins, and a later search
 * beats an earlier one.
 */
export async function knownJobs(): Promise<Map<string, KnownJob>> {
  const [candidates, searches, postings, applications] = await Promise.all([
    prisma.agentCandidate.findMany({ select: { url: true, title: true, company: true, place: true } }),
    prisma.postingSearch.findMany({ select: { id: true, source: true, addedBy: true, postings: true }, orderBy: { createdAt: "asc" } }),
    prisma.posting.findMany({
      where: { OR: [{ savedAt: { not: null } }, { dismissedAt: { not: null } }] },
      select: { id: true, url: true, title: true, company: true, place: true, savedAt: true, dismissedAt: true },
    }),
    prisma.application.findMany({ where: { awaitingReview: false }, select: { id: true, postingUrl: true, title: true, company: true, location: true } }),
  ]);
  const known = new Map<string, KnownJob>();
  const note = (job: Parameters<typeof jobKeys>[0], entry: KnownJob) => {
    for (const key of jobKeys(job)) known.set(key, entry);
  };
  // The least telling first: a later note for the same key wins.
  for (const candidate of candidates) note(candidate, { where: "agent" });
  for (const search of searches) {
    postingsOf(search.postings).forEach((posting, index) => note(posting, { where: "search", searchId: search.id, number: index + 1, source: search.source, addedBy: search.addedBy }));
  }
  for (const posting of postings) if (posting.dismissedAt) note(posting, { where: "dismissed", postingId: posting.id });
  for (const posting of postings) if (posting.savedAt) note(posting, { where: "saved", postingId: posting.id });
  for (const application of applications) {
    note({ url: application.postingUrl, title: application.title, company: application.company, place: application.location }, { where: "application", applicationId: application.id });
  }
  return known;
}

/**
 * Keeps postings an AI client found itself (add_found_jobs) as a search of
 * their own, from the CLIENT source and named by the client, so they stay
 * apart from what a job source found but can be saved, scored and applied
 * from the same way. Jobs Dossier already has (knownJobs) and jobs given
 * twice are left out and returned with where they are; nothing is kept when
 * none remain. `addKnown` adds known jobs anyway, for openings the user says
 * are different.
 */
export async function addClientSearch({
  addedBy,
  query,
  postings,
  addKnown = false,
}: {
  addedBy: string;
  query: SearchQuery;
  postings: FoundPosting[];
  addKnown?: boolean;
}): Promise<{ id: string | null; added: FoundPosting[]; skipped: { posting: FoundPosting; known: KnownJob }[] }> {
  const known = addKnown ? new Map<string, KnownJob>() : await knownJobs();
  const seen = new Set<string>();
  const added: FoundPosting[] = [];
  const skipped: { posting: FoundPosting; known: KnownJob }[] = [];
  for (const posting of postings) {
    const keys = jobKeys(posting);
    const have = keys.map((key) => known.get(key)).find((entry) => entry !== undefined);
    if (have) {
      skipped.push({ posting, known: have });
    } else if (keys.some((key) => seen.has(key))) {
      skipped.push({ posting, known: { where: "twice" } });
    } else {
      for (const key of keys) seen.add(key);
      added.push(posting);
    }
  }
  if (added.length === 0) return { id: null, added, skipped };
  const search = await prisma.postingSearch.create({
    data: { source: "CLIENT", addedBy, query, postings: added, found: added.length, next: null },
    select: { id: true },
  });
  return { id: search.id, added, skipped };
}

/** A kept search, the latest one without an id; null when there's none. */
export async function loadSearch(id?: string, { timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<StoredSearch | null> {
  const search = id
    ? await prisma.postingSearch.findUnique({ where: { id } })
    : await prisma.postingSearch.findFirst({ orderBy: { createdAt: "desc" } });
  if (!search) return null;
  return {
    id: search.id,
    source: search.source,
    addedBy: search.addedBy,
    query: queryOf(search.query),
    ranAt: ranAtLabel(search.createdAt, timeZone, now),
    postings: await withStates(postingsOf(search.postings)),
    next: search.next,
  };
}

/** "Show more": the next page from the search's own source, added to the kept search. */
export async function showMoreFor(id: string): Promise<{ ok: true; postings: ShownPosting[]; next: string | null } | SearchProblem> {
  const search = await prisma.postingSearch.findUnique({ where: { id } });
  if (!search) return { ok: false, problem: "changed", message: "That search is no longer kept. Search again." };
  if (!search.next || !isJobSource(search.source)) return { ok: true, postings: [], next: null };
  const answer = await askSource(queryOf(search.query), { source: search.source, next: search.next });
  if (!answer.ok) return answer;
  const kept = postingsOf(search.postings);
  const seen = new Set(kept.map(postingKey));
  const added = answer.postings.filter((posting) => !seen.has(postingKey(posting)));
  const postings = [...kept, ...added];
  await prisma.postingSearch.update({ where: { id }, data: { postings, found: postings.length, next: answer.next } });
  return { ok: true, postings: await withStates(added), next: answer.next };
}

/** Every kept search, newest first, grouped by the day it ran in the user's time zone. */
export async function listSearches({ timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<PastSearchDay[]> {
  const searches = await prisma.postingSearch.findMany({
    select: { id: true, source: true, addedBy: true, query: true, found: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const days: PastSearchDay[] = [];
  for (const search of searches) {
    const ago = daysBetween(search.createdAt, now, timeZone);
    const day = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : formatDay(search.createdAt, timeZone, now);
    if (days.at(-1)?.day !== day) days.push({ day, searches: [] });
    days.at(-1)!.searches.push({ id: search.id, source: search.source, addedBy: search.addedBy, query: queryOf(search.query), found: search.found, time: formatTime(search.createdAt, timeZone) });
  }
  return days;
}

export const countSearches = () => prisma.postingSearch.count();

export async function removeSearch(id: string): Promise<void> {
  await prisma.postingSearch.deleteMany({ where: { id } });
}
