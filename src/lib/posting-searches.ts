import "server-only";

import type { Prisma } from "@/generated/prisma/client";
import { daysBetween, formatDay, formatTime } from "@/lib/dates";
import { enabledPortals, loadJobSearchConfig } from "@/lib/job-search/config";
import { countryName } from "@/lib/job-search/countries";
import { askSource } from "@/lib/job-search/find";
import {
  EMPTY_QUERY,
  isJobSource,
  jobKeys,
  postingKey,
  searchQuerySchema,
  type FoundPosting,
  type PastSearchDay,
  type PostingOrigin,
  type SearchPortal,
  type JobSource,
  type SearchProblem,
  type SearchQuery,
  type ShownPosting,
  type StoredSearch,
} from "@/lib/job-search/search";
import { CLIENT_SOURCE, sourceCovers, sourceInfo, type CAREERS_SOURCE } from "@/lib/job-search/sources";
import { findUnfinishedJobs, startJob } from "@/lib/jobs/runner";
import { keepFound, portalsOf, postingsOfSearch, withStates } from "@/lib/library";
import { logServerError } from "@/lib/log";
import { loadInstalledPortals } from "@/lib/portals/installed";
import { prisma } from "@/lib/prisma";
import { noteAgencies } from "@/lib/recruiters/store";

// Searches kept until the user removes them (E14-10): what was asked, each
// portal's state and what to ask it next. A search asks every portal
// switched on that covers its country, four at a time, in the background
// (E22-4). What it found is in the library (E22-5), linked to it, so going
// back to it costs no searches from a portal's plan.

/** Portals asked at once; the rest wait their turn. */
const AT_ONCE = 4;

const queryOf = (value: Prisma.JsonValue): SearchQuery => searchQuerySchema.catch(EMPTY_QUERY).parse(value);

/** "today at 14:32", "yesterday at 09:05" or "on Thu 1 Oct at 18:20". */
function ranAtLabel(date: Date, timeZone?: string, now = new Date()): string {
  const days = daysBetween(date, now, timeZone);
  const day = days === 0 ? "today" : days === 1 ? "yesterday" : `on ${formatDay(date, timeZone, now)}`;
  return `${day} at ${formatTime(date, timeZone)}`;
}

/** The portal a search asked first: the one it shows as, and Show more's. */
const firstPortal = (search: { source: string | null; portals: Prisma.JsonValue }): SearchPortal | null => portalsOf(search.portals)[0] ?? null;

/**
 * Asks portals for a kept search, `AT_ONCE` at a time: each into the
 * library as it answers, its state saved as it changes. One that fails
 * never fails the rest; one out of searches is skipped, saying so. With
 * `more`, each is asked for its next page. Gives how many new postings it
 * found.
 */
export async function runPortals(
  searchId: string,
  which: readonly string[],
  { more = false, signal, onChange }: { more?: boolean; signal?: AbortSignal; onChange?: (portals: SearchPortal[]) => Promise<void> | void } = {},
): Promise<number> {
  const search = await prisma.postingSearch.findUnique({ where: { id: searchId } });
  if (!search) return 0;
  // The portals the user added, known before their ids are checked (E23-3).
  await loadInstalledPortals();
  const query = queryOf(search.query);
  let portals = portalsOf(search.portals);
  let added = 0;
  // Saved one change at a time, in order, so no answer overwrites another.
  let saving: Promise<unknown> = Promise.resolve();
  // Agencies are noted one portal at a time too, so two portals can't add the same one twice (jobauto fork).
  let noting: Promise<unknown> = Promise.resolve();
  const change = (id: string, patch: Partial<SearchPortal>) => {
    portals = portals.map((portal) => (portal.id === id ? { ...portal, ...patch } : portal));
    const snapshot = portals;
    const found = snapshot.reduce((sum, portal) => sum + portal.found, 0);
    saving = saving.then(async () => {
      await prisma.postingSearch.updateMany({ where: { id: searchId }, data: { portals: snapshot, found } });
      await onChange?.(snapshot);
    });
    return saving;
  };
  const queue = which.filter((id) => portals.some((portal) => portal.id === id) && isJobSource(id));
  const work = async () => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      signal?.throwIfAborted();
      const before = portals.find((portal) => portal.id === id)!;
      const next = more ? before.next : null;
      if (more && !next) continue;
      await change(id, { status: "searching", message: null, problem: undefined });
      let answer: Awaited<ReturnType<typeof askSource>>;
      try {
        answer = await askSource(query, { source: id as JobSource, next });
      } catch (error) {
        // Anything unexpected fails this portal only, said plainly; the details go to the log.
        if (signal?.aborted) throw error;
        logServerError("portal search", error);
        answer = { ok: false, problem: "unavailable", message: "The portal couldn't be reached. Try again." };
      }
      if (!answer.ok) {
        // Out of searches is a skip, saying when they come back; anything else a failure, with Try again.
        await change(id, { status: answer.problem === "quota" ? "skipped" : "failed", message: answer.message, problem: answer.problem });
        continue;
      }
      const kept = new Set((await postingsOfSearch(searchId, { withRemoved: true })).map(postingKey));
      const fresh = answer.postings.filter((posting) => !kept.has(postingKey(posting)));
      await keepFound(searchId, id, fresh);
      // An agency among the postings goes on the Recruiters list (jobauto fork).
      noting = noting.then(() => noteAgencies(fresh, "search"));
      await noting;
      added += fresh.length;
      await change(id, { status: "done", found: (more ? before.found : 0) + fresh.length, next: answer.next, message: answer.note ?? null });
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, queue.length) }, work));
  await saving;
  return added;
}

/** Starts the background search of `portals` for a kept search; its job's id. */
async function startSearching(searchId: string, portals: readonly string[], more = false): Promise<string> {
  // Imported here: the job's module imports this one.
  const { portalSearchJob, searchJobKey } = await import("@/lib/jobs/portal-search");
  return startJob(portalSearchJob, { searchId, portals: [...portals], more }, { key: searchJobKey(searchId) });
}

/**
 * Runs a search on every portal switched on that covers its country, and
 * keeps it: at once it's there, its portals waiting, and they're asked in
 * the background. With `wait`, it returns once they've all answered (for
 * the Claude connector, which wants the results).
 */
export async function runSearch(query: SearchQuery, { wait = false }: { wait?: boolean } = {}): Promise<{ ok: true; id: string } | SearchProblem> {
  const enabled = enabledPortals(await loadJobSearchConfig());
  if (enabled.length === 0) return { ok: false, problem: "off", message: "Switch on a portal in Settings → Job search first." };
  if (!query.country) return { ok: false, problem: "no-country", message: "Choose a country to search in." };
  const portals: SearchPortal[] = enabled.map((id) =>
    sourceCovers(id, query.country)
      ? { id, status: "waiting", found: 0, next: null, message: null }
      : { id, status: "skipped", found: 0, next: null, message: `${sourceInfo(id).name} doesn't cover ${countryName(query.country)}.` },
  );
  const asked = portals.filter((portal) => portal.status === "waiting").map((portal) => portal.id);
  if (asked.length === 0) {
    return { ok: false, problem: "country", message: `None of the portals switched on lists jobs in ${countryName(query.country)}. Switch on one that does in Settings → Job search.` };
  }
  const search = await prisma.postingSearch.create({ data: { query, portals, found: 0 }, select: { id: true } });
  if (wait) await runPortals(search.id, asked);
  else await startSearching(search.id, asked);
  return { ok: true, id: search.id };
}

/** A kept search with what it found, the latest one without an id; null when there's none. */
export async function loadSearch(id?: string, { timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<StoredSearch | null> {
  const search = id
    ? await prisma.postingSearch.findUnique({ where: { id } })
    : await prisma.postingSearch.findFirst({ where: { agentSearchName: null }, orderBy: { createdAt: "desc" } });
  if (!search) return null;
  await loadInstalledPortals();
  const portal = firstPortal(search);
  const source = portal?.id ?? search.source ?? "";
  const jobId = (await findUnfinishedJobs(`search:${search.id}`))[0]?.id ?? null;
  const portals = portalsOf(search.portals);
  return {
    id: search.id,
    source,
    addedBy: search.addedBy,
    query: queryOf(search.query),
    ranAt: ranAtLabel(search.createdAt, timeZone, now),
    postings: await withStates(await postingsOfSearch(search.id)),
    // A source that's no longer listed (#269) keeps what it found, without Show more.
    next: portal && isJobSource(source) ? portal.next : null,
    portals: jobId ? portals : portals.map(stopped),
    jobId,
  };
}

/**
 * "Show more": the next page from each of the search's portals that has
 * more, into the library. In the background, unless `wait` (the connector),
 * which gives what it added.
 */
export async function showMoreFor(id: string, { wait = false }: { wait?: boolean } = {}): Promise<{ ok: true; postings: ShownPosting[]; next: string | null } | SearchProblem> {
  const search = await prisma.postingSearch.findUnique({ where: { id } });
  if (!search) return { ok: false, problem: "changed", message: "That search is no longer kept. Search again." };
  await loadInstalledPortals();
  const portals = portalsOf(search.portals).filter((portal) => portal.next && isJobSource(portal.id));
  if (portals.length === 0) return { ok: true, postings: [], next: null };
  const ids = portals.map((portal) => portal.id);
  if (!wait) {
    await startSearching(id, ids, true);
    return { ok: true, postings: [], next: null };
  }
  const before = new Set((await postingsOfSearch(id)).map(postingKey));
  await runPortals(id, ids, { more: true });
  const after = await postingsOfSearch(id);
  const left = portalsOf((await prisma.postingSearch.findUniqueOrThrow({ where: { id } })).portals);
  const failed = left.find((portal) => ids.includes(portal.id) && (portal.status === "failed" || portal.status === "skipped"));
  if (failed && after.length === before.size) return { ok: false, problem: failed.status === "skipped" ? "quota" : "unavailable", message: failed.message ?? "The portal didn't answer." };
  return { ok: true, postings: await withStates(after.filter((posting) => !before.has(postingKey(posting)))), next: left.find((portal) => portal.next)?.next ?? null };
}

/** A portal still waiting or searching without a job to do it (Dossier restarted meanwhile): it failed. */
function stopped(portal: SearchPortal): SearchPortal {
  return portal.status === "waiting" || portal.status === "searching" ? { ...portal, status: "failed", message: "Dossier stopped before it answered. Try again." } : portal;
}

/** "Try again" on one portal that failed, or that a restart left waiting: asked again, in the background. */
export async function retryPortal(searchId: string, portal: string): Promise<boolean> {
  const search = await prisma.postingSearch.findUnique({ where: { id: searchId }, select: { portals: true } });
  await loadInstalledPortals();
  const running = (await findUnfinishedJobs(`search:${searchId}`)).length > 0;
  const portals = search ? portalsOf(search.portals).map((entry) => (running ? entry : stopped(entry))) : [];
  if (!portals.some((entry) => entry.id === portal && entry.status === "failed") || !isJobSource(portal)) return false;
  await prisma.postingSearch.update({
    where: { id: searchId },
    data: { portals: portals.map((entry) => (entry.id === portal ? { ...entry, status: "waiting", message: null } : entry)) },
  });
  await startSearching(searchId, [portal]);
  return true;
}

/**
 * Every search the user ran, newest first, grouped by the day it ran in the
 * user's time zone: the "found by" list. The job agent's runs are one entry
 * there, "The job agent" (E22-8).
 */
export async function listSearches({ timeZone, now = new Date() }: { timeZone?: string; now?: Date } = {}): Promise<PastSearchDay[]> {
  const searches = await prisma.postingSearch.findMany({
    where: { agentSearchName: null },
    select: { id: true, source: true, addedBy: true, portals: true, query: true, found: true, createdAt: true },
    orderBy: { createdAt: "desc" },
  });
  const days: PastSearchDay[] = [];
  for (const search of searches) {
    const ago = daysBetween(search.createdAt, now, timeZone);
    const day = ago === 0 ? "Today" : ago === 1 ? "Yesterday" : formatDay(search.createdAt, timeZone, now);
    if (days.at(-1)?.day !== day) days.push({ day, searches: [] });
    const source = firstPortal(search)?.id ?? search.source ?? "";
    days.at(-1)!.searches.push({ id: search.id, source, addedBy: search.addedBy, query: queryOf(search.query), found: search.found, time: formatTime(search.createdAt, timeZone) });
  }
  return days;
}

export const countSearches = () => prisma.postingSearch.count({ where: { agentSearchName: null } });

/** Removes a kept search; what it found stays in the library. */
export async function removeSearch(id: string): Promise<void> {
  await prisma.postingSearch.deleteMany({ where: { id } });
}

// ─── Postings added, not searched (jobauto fork) ────────────────────────────
// What an AI client found itself (add_found_jobs) and new jobs on the
// careers pages the user follows go into the library as a search of their
// own, from the CLIENT or CAREERS source and named by who added them, so
// they're in Positions like any other, "Added by …". A job Dossier has
// already, by its keys (jobKeys), isn't added again.

/** Where Dossier already has a job, so an add leaves it out: the most telling place when it's in several. */
export type KnownJob =
  | { where: "application"; applicationId: string }
  /** Saved, dismissed, in the Archive, or removed from it (E22-7). */
  | { where: "saved" | "dismissed" | "archived" | "removed"; postingId: string }
  /** In Positions: found by a search on `source` (its `number` in that search's list), or added by `addedBy`. */
  | { where: "search"; searchId: string; number: number; source: PostingOrigin; addedBy: string }
  | { where: "agent" }
  | { where: "twice" };

type KnownRow = { id: string; mergedIntoId: string | null; url: string; title: string; company: string; place: string; savedAt: Date | null; dismissedAt: Date | null; archivedAt: Date | null; removedAt: Date | null };

/**
 * Every job Dossier has, by its keys (jobKeys): applied to, saved,
 * dismissed, in the Archive or removed from it, in Positions from a search
 * or an add (by the latest search that has it, numbered as that search
 * lists it), or found by the job agent. Where one is in several places, the
 * one the user acted on most wins. A posting merged into another (E22-6)
 * counts as that one, by its own keys too.
 */
export async function knownJobs(): Promise<Map<string, KnownJob>> {
  const [candidates, finds, postings, applications] = await Promise.all([
    prisma.agentCandidate.findMany({ select: { url: true, title: true, company: true, place: true } }),
    // In each search's own order, as postingsOfSearch lists it.
    prisma.postingFind.findMany({
      select: { searchId: true, postingId: true, portal: true, posting: { select: { removedAt: true } }, search: { select: { addedBy: true, agentSearchName: true, createdAt: true } } },
      orderBy: [{ foundAt: "asc" }, { id: "asc" }],
    }),
    prisma.posting.findMany({
      select: { id: true, mergedIntoId: true, url: true, title: true, company: true, place: true, savedAt: true, dismissedAt: true, archivedAt: true, removedAt: true },
    }),
    prisma.application.findMany({ where: { awaitingReview: false }, select: { id: true, postingUrl: true, title: true, company: true, location: true } }),
  ]);
  // Each find's number in its search's list (one removed from the Archive isn't listed), and the latest search that has each posting.
  const listed = new Map<string, number>();
  const latest = new Map<string, { entry: KnownJob; agent: boolean; at: Date }>();
  for (const find of finds) {
    const number = find.posting.removedAt ? 0 : (listed.get(find.searchId) ?? 0) + 1;
    if (number > 0) listed.set(find.searchId, number);
    // A search the user ran, or an add, beats the job agent's; of two alike, the later one.
    const agent = find.search.agentSearchName !== null;
    const before = latest.get(find.postingId);
    if (before && ((agent && !before.agent) || (agent === before.agent && before.at > find.search.createdAt))) continue;
    const entry: KnownJob = agent ? { where: "agent" } : { where: "search", searchId: find.searchId, number, source: find.portal, addedBy: find.search.addedBy };
    latest.set(find.postingId, { entry, agent, at: find.search.createdAt });
  }
  const byId = new Map(postings.map((posting) => [posting.id, posting]));
  /** The posting this one shows as (E22-6), whose marks count. */
  const shownOf = (posting: KnownRow) => byId.get(posting.mergedIntoId ?? posting.id) ?? posting;
  const known = new Map<string, KnownJob>();
  const note = (job: Parameters<typeof jobKeys>[0], entry: KnownJob) => {
    for (const key of jobKeys(job)) known.set(key, entry);
  };
  const mark = (where: "archived" | "removed" | "dismissed" | "saved", has: (shown: KnownRow) => boolean) => {
    for (const posting of postings) if (has(shownOf(posting))) note(posting, { where, postingId: shownOf(posting).id });
  };
  // The least telling first: a later note for the same key wins.
  for (const candidate of candidates) note(candidate, { where: "agent" });
  for (const posting of postings) {
    const found = latest.get(shownOf(posting).id);
    if (found) note(posting, found.entry);
  }
  mark("archived", (shown) => shown.archivedAt !== null);
  mark("removed", (shown) => shown.removedAt !== null);
  mark("dismissed", (shown) => shown.dismissedAt !== null);
  mark("saved", (shown) => shown.savedAt !== null);
  for (const application of applications) {
    note({ url: application.postingUrl, title: application.title, company: application.company, place: application.location }, { where: "application", applicationId: application.id });
  }
  return known;
}

/**
 * Keeps postings an AI client found itself (add_found_jobs), from the CLIENT
 * source and named by the client, or new jobs on careers pages, from CAREERS
 * and named by the employers, as a search of their own whose postings go
 * into the library, new: in Positions, where they're saved, scored and
 * applied from like any other. Jobs Dossier already has (knownJobs) and jobs
 * given twice are left out and returned with where they are; nothing is kept
 * when none remain. `addKnown` adds known jobs anyway, for openings the user
 * says are different.
 */
export async function addClientSearch({
  addedBy,
  query,
  postings,
  addKnown = false,
  source = CLIENT_SOURCE,
}: {
  addedBy: string;
  /** CLIENT for an AI client's finds, CAREERS for new jobs on careers pages. */
  source?: typeof CLIENT_SOURCE | typeof CAREERS_SOURCE;
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
  const portals: SearchPortal[] = [{ id: source, status: "done", found: added.length, next: null, message: null }];
  const search = await prisma.postingSearch.create({ data: { query, addedBy, portals, found: added.length }, select: { id: true } });
  await keepFound(search.id, source, added);
  await noteAgencies(added, "search");
  return { id: search.id, added, skipped };
}
