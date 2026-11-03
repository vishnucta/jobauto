import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { isAiUsable } from "@/lib/ai/config";
import { countryName } from "@/lib/job-search/countries";
import {
  DEFAULT_RADIUS_KM,
  describeSearch,
  linkKey,
  postingKey,
  safeLink,
  searchRunHref,
  viewHref,
  type FoundPosting,
  type PostingOrigin,
  type ShownPosting,
} from "@/lib/job-search/search";
import { describeSourceProblem, searchSourcesName, SOURCE_INFO } from "@/lib/job-search/sources";
import { searchChips, searchWords } from "@/lib/job-search/suggestions";
import { startScoring } from "@/lib/jobs/score-posting";
import { addClientSearch, listSearches, loadSearch, removeSearch, type KnownJob } from "@/lib/posting-searches";
import { dismissPosting, foundFromPosting, listPostings, postingStates, savePosting, unmarkPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { loadProfile } from "@/lib/profile-data";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { failure, postingLine, started, text, type ToolContext } from "../kit";

// Find jobs: saved and dismissed postings, past searches and Dossier's own scoring (jobauto fork).
// What the Saved, Dismissed and Past searches views show, and what their
// buttons do. Start application has no tool of its own: draft_application
// and save_application start one from the same postings, by search_id and
// number or posting_id, and keep the posting with it as the button does.

const LISTS = ["saved", "dismissed", "searches"] as const;
/** The From filter's sources, as the URL spells them (?from=client). */
const FROM = ["jsearch", "serpapi", "adzuna", "arbeitsagentur", "client"] as const satisfies readonly Lowercase<PostingOrigin>[];
const CHANGES = ["save", "unsave", "dismiss", "restore"] as const;

/** What each change does, as the button on a posting does it. */
const CHANGE: Record<(typeof CHANGES)[number], (posting: FoundPosting) => Promise<unknown>> = {
  save: savePosting,
  unsave: (posting) => unmarkPosting(posting, "saved"),
  dismiss: dismissPosting,
  // Bring back, as on Dismissed: in searches again, not in Saved.
  restore: (posting) => unmarkPosting(posting, "dismissed"),
};

const SEARCH_GONE = "That search is no longer kept. Search again.";

/** A saved or dismissed posting as Claude sees it in a list: by its posting_id, with the application made from it. */
function keptLine(posting: ShownPosting) {
  const { number, applied, ...line } = postingLine(posting, 0);
  void number;
  void applied;
  return { posting_id: posting.state.postingId ?? undefined, ...line, application_id: posting.state.applicationId ?? undefined };
}

/** The posting a change names: from the search by its number, or kept in Dossier by its posting_id; null when it isn't there. */
async function postingFor(ref: { number?: number; posting_id?: string }, searched: readonly ShownPosting[]): Promise<FoundPosting | null> {
  if (ref.posting_id) {
    const row = await prisma.posting.findUnique({ where: { id: ref.posting_id } });
    return row ? foundFromPosting(row) : null;
  }
  const shown = ref.number ? searched[ref.number - 1] : undefined;
  if (!shown) return null;
  const { state, ...posting } = shown;
  void state;
  return posting;
}

/** One job an AI client found, as add_found_jobs takes it. */
const foundJob = z.object({
  title: z.string().trim().min(1).max(500),
  company: z.string().trim().max(300).default(""),
  place: z.string().trim().max(300).default("").describe("City or region, as the posting says"),
  url: z.url({ protocol: /^https?$/ }).max(2000).describe("The posting's own page, where it can be read and applied to"),
  description: z.string().max(100_000).default("").describe("The posting's text, or what you know of it; Dossier reads the page itself when this is short"),
  salary: z.string().trim().max(200).default(""),
  posted: z.iso.date().optional().describe("When it was posted, e.g. 2026-10-28"),
  remote: z.boolean().optional(),
  found_on: z.string().trim().max(100).default("").describe("The site you found it on, e.g. LinkedIn or the company's careers page"),
});

/**
 * A job an AI client found, in the shape every posting has. Its id comes from
 * its link, so the same job added twice is the same posting in Saved.
 */
function postingFromClient(job: z.output<typeof foundJob>): FoundPosting {
  const url = safeLink(job.url);
  return {
    source: "CLIENT",
    externalId: createHash("sha256").update(linkKey(url) || url).digest("hex").slice(0, 32),
    title: job.title,
    company: job.company,
    place: job.place,
    remote: job.remote ?? null,
    salary: job.salary,
    postedAt: job.posted ? new Date(`${job.posted}T00:00:00Z`).toISOString() : null,
    url,
    via: job.found_on,
    description: job.description.trim(),
    complete: false,
  };
}

/** Why a job an AI client gave wasn't added, as the client tells the user, with the id to find it by. */
function skippedWhere(known: KnownJob) {
  switch (known.where) {
    case "application":
      return { reason: "already applied to", application_id: known.applicationId };
    case "saved":
      return { reason: "already saved", posting_id: known.postingId };
    case "dismissed":
      return { reason: "dismissed before", posting_id: known.postingId };
    case "search":
      return {
        reason: known.source === "CLIENT" ? `already added by ${known.addedBy || "an AI client"}` : `already found by ${SOURCE_INFO[known.source].name}`,
        search_id: known.searchId,
        number: known.number,
      };
    case "agent":
      return { reason: "the job agent already found it" };
    case "twice":
      return { reason: "twice in this list" };
  }
}

/** Registers these tools on the connector's server. */
export function registerPostingTools({ server, linkTo, clientName = "" }: ToolContext): void {
  server.registerTool(
    "list_postings",
    {
      title: "List saved postings and past searches",
      description:
        "What Find jobs keeps: saved postings, dismissed ones and past searches, with the posting_id and search_id values the other tools take. " +
        "With a search_id: the postings that search found, numbered, without asking the job source again.",
      inputSchema: z.object({
        view: z.enum(LISTS).optional().describe("Only this list: saved, dismissed or searches. Without it, all three."),
        source: z.enum(FROM).optional().describe("Only from this source, as the From filter on Find jobs: jsearch, serpapi, adzuna, arbeitsagentur, or client for what AI clients added"),
        search_id: z.string().min(1).max(100).optional().describe("A past search, to list the postings it found instead"),
        from: z.number().int().min(1).optional().describe("Where each list (or the search) starts. Defaults to 1."),
        limit: z.number().int().min(1).max(100).optional().describe("At most this many per list. Defaults to 20."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ view, search_id, from, limit, source }) => {
      const take = limit ?? 20;
      const start = (from ?? 1) - 1;
      const origin = source ? (source.toUpperCase() as PostingOrigin) : null;
      const fromSource = (candidate: PostingOrigin) => origin === null || candidate === origin;
      const timeZone = await lastKnownTimeZone();
      if (search_id) {
        const search = await loadSearch(search_id, { timeZone });
        if (!search) return failure(SEARCH_GONE);
        return text({
          search_id: search.id,
          searched: describeSearch(search.query, countryName(search.query.country)),
          source: searchSourcesName(search.sources, search.addedBy),
          problems: search.problems.length > 0 ? search.problems.map(describeSourceProblem) : undefined,
          ran: search.ranAt,
          found: search.postings.length,
          more_available: search.more,
          postings: search.postings
            .slice(start, start + take)
            .map((posting, index) => ({ ...postingLine(posting, start + index + 1), dismissed: posting.state.dismissed || undefined })),
          link: linkTo(searchRunHref(search.id)),
        });
      }
      const answer: Record<string, unknown> = {};
      for (const list of view ? [view] : LISTS) {
        if (list === "searches") {
          const searches = (await listSearches({ timeZone })).flatMap(({ day, searches }) =>
            searches
              .filter((search) => search.sources.some(fromSource))
              .map((search) => ({
                search_id: search.id,
                searched: describeSearch(search.query, countryName(search.query.country)),
                ran: `${day} at ${search.time}`,
                found: search.found,
                source: searchSourcesName(search.sources, search.addedBy),
              })),
          );
          answer.searches = { total: searches.length, searches: searches.slice(start, start + take), link: linkTo(viewHref("history", origin)) };
        } else {
          const postings = (await listPostings(list)).filter((posting) => fromSource(posting.source));
          answer[list] = { total: postings.length, postings: postings.slice(start, start + take).map(keptLine), link: linkTo(viewHref(list, origin)) };
        }
      }
      return text(answer);
    },
  );

  server.registerTool(
    "add_found_jobs",
    {
      title: "Add jobs you found",
      description:
        "Adds jobs you found yourself (by searching the web, not with search_jobs) to Find jobs, as a search of their own marked as found by an AI client and named by you, " +
        "kept apart from what the job source found. Give what you searched for and each job's title, company, place and link; add its text when you have it. " +
        "Only add real postings you saw, with their own links: never make one up. Nothing is added twice: jobs Dossier already has (in any kept search, by link or as the same opening on another site; saved; dismissed; applied to; " +
        "or found by the job agent) are left out and listed as skipped with where each one is, so tell the user. Answers with a search_id and numbers, which list_postings, get_posting, update_postings, " +
        "save_job_scores, score_with_dossier and save_application take like any other search's.",
      inputSchema: z.object({
        client: z.string().trim().max(60).optional().describe("Your own name, e.g. 'Claude Code' or 'Gemini CLI', shown with the search"),
        searched: z
          .object({
            keywords: z.string().trim().min(1).max(200).describe("What you searched for, e.g. 'Financial Analyst'"),
            place: z.string().trim().max(200).default(""),
            country: z
              .string()
              .trim()
              .toLowerCase()
              .regex(/^([a-z]{2})?$/)
              .default("")
              .describe("ISO code, e.g. 'de'"),
            remote_only: z.boolean().default(false),
          })
          .describe("The search you ran"),
        jobs: z.array(foundJob).min(1).max(50),
        add_known: z.boolean().default(false).describe("Also add jobs Dossier already has: only when the user says a skipped one is a different opening"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async ({ client, searched, jobs, add_known }) => {
      const query = { keywords: searched.keywords, place: searched.place, country: searched.country, radiusKm: DEFAULT_RADIUS_KM, remoteOnly: searched.remote_only, postedWithin: "any" as const };
      const addedBy = (client || clientName).slice(0, 60);
      const { id, skipped } = await addClientSearch({ addedBy, query, postings: jobs.map(postingFromClient), addKnown: add_known });
      const leftOut = skipped.map(({ posting, known }) => ({ title: posting.title, company: posting.company || undefined, url: posting.url, ...skippedWhere(known) }));
      if (!id) {
        return text({
          added: 0,
          skipped: leftOut,
          message: "Dossier already has every one of those jobs, so nothing was added: tell the user where each one is. Pass add_known only when the user says one is a different opening.",
          link: linkTo(viewHref("history")),
        });
      }
      const search = await loadSearch(id, { timeZone: await lastKnownTimeZone() });
      if (!search) return failure("Dossier couldn't keep those jobs. Try again in a moment.");
      const kept = "Added to Find jobs as a search of its own, marked as found by an AI client.";
      return text({
        search_id: search.id,
        searched: describeSearch(search.query, countryName(search.query.country)),
        source: searchSourcesName(search.sources, search.addedBy),
        added: search.postings.length,
        postings: search.postings.map((posting, index) => ({ ...postingLine(posting, index + 1), dismissed: posting.state.dismissed || undefined })),
        skipped: leftOut.length > 0 ? leftOut : undefined,
        message: leftOut.length > 0 ? `${kept} ${leftOut.length === 1 ? "One job" : `${leftOut.length} jobs`} Dossier already had ${leftOut.length === 1 ? "was" : "were"} left out: see skipped for where each one is.` : kept,
        link: linkTo(searchRunHref(search.id)),
      });
    },
  );

  server.registerTool(
    "update_postings",
    {
      title: "Save or dismiss postings",
      description:
        "Saves, unsaves, dismisses or brings back postings as the buttons in Find jobs do, from a search by number or by posting_id, and returns where each one stands. " +
        "Dismissed postings stay out of later searches. One unsaved or brought back is no longer kept unless an application uses it, and its posting_id stops working.",
      inputSchema: z.object({
        search_id: z.string().min(1).max(100).optional().describe("The search the numbered postings are from"),
        changes: z
          .array(
            z.object({
              action: z.enum(CHANGES).describe("save, unsave, dismiss, or restore to bring a dismissed posting back"),
              number: z.number().int().min(1).optional().describe("The posting's number in the search"),
              posting_id: z.string().min(1).max(100).optional().describe("Instead of a number: a posting from list_postings"),
            }),
          )
          .min(1)
          .max(50),
      }),
      // Unsave and restore delete a posting nothing else keeps, whole text and all: no Undo from here.
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ search_id, changes }) => {
      const search = search_id ? await loadSearch(search_id) : null;
      if (search_id && !search) return failure(SEARCH_GONE);
      // All found first: a posting one change takes out of Dossier can still be saved again by a later one.
      const postings = await Promise.all(changes.map((change) => postingFor(change, search?.postings ?? [])));
      const missing = changes.flatMap((change, index) => (postings[index] ? [] : [change.posting_id ?? change.number ?? "?"]));
      if (missing.length === changes.length) return failure("None of those postings could be found. Use numbers from the search, or posting_id values from list_postings.");
      for (const [index, change] of changes.entries()) {
        const posting = postings[index];
        if (posting) await CHANGE[change.action](posting);
      }
      const states = await postingStates(postings.filter((posting) => posting !== null));
      const updated = changes.flatMap((change, index) => {
        const posting = postings[index];
        const state = posting && states.get(postingKey(posting));
        if (!posting || !state) return [];
        return [{ number: change.number, posting_id: state.postingId ?? undefined, title: posting.title, saved: state.saved, dismissed: state.dismissed }];
      });
      const view = changes.every((change) => change.action === "dismiss") ? "dismissed" : "saved";
      return text({ updated, not_found: missing.length > 0 ? missing : undefined, link: linkTo(search_id ? searchRunHref(search_id) : viewHref(view)) });
    },
  );

  server.registerTool(
    "remove_search",
    {
      title: "Remove a past search",
      description: "Removes a past search and the postings it found from Find jobs, as Remove in Past searches does. Saved and dismissed postings from it stay.",
      inputSchema: z.object({ search_id: z.string().min(1).max(100) }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ search_id }) => {
      const search = await prisma.postingSearch.findUnique({ where: { id: search_id }, select: { id: true } });
      if (!search) return failure("That search is no longer kept.");
      await removeSearch(search_id);
      return text({ search_id, removed: true, message: "Search removed. Saved postings from it stay in Saved.", link: linkTo(viewHref("history")) });
    },
  );

  server.registerTool(
    "score_with_dossier",
    {
      title: "Have Dossier score a posting",
      description:
        "Has Dossier's own AI model score how well one posting fits the profile, as the Score button in Find jobs does, only when an AI provider is set up in Dossier's settings. " +
        "Without one, score it yourself and save it with save_job_scores. Follow it with check_task.",
      inputSchema: z.object({
        search_id: z.string().min(1).max(100).optional().describe("The search the posting is from"),
        number: z.number().int().min(1).optional().describe("The posting's number in that search"),
        posting_id: z.string().min(1).max(100).optional().describe("Instead: a posting from list_postings, or one Dossier handed over"),
      }),
      annotations: { readOnlyHint: false, openWorldHint: true },
    },
    async ({ search_id, number, posting_id }) => {
      if (!(await isAiUsable())) {
        return failure("Dossier has no AI model of its own set up. Score it yourself: get_profile and get_posting, then save_job_scores.");
      }
      if (!posting_id && !(search_id && number)) return failure("Give search_id and number, or posting_id.");
      const search = search_id && !posting_id ? await loadSearch(search_id) : null;
      if (search_id && !posting_id && !search) return failure(SEARCH_GONE);
      const posting = await postingFor({ number, posting_id }, search?.postings ?? []);
      if (!posting) return failure(posting_id ? "That posting is no longer in Dossier." : "There's no such posting in that search. Use a number from search_jobs or list_postings.");
      const taskId = await startScoring(posting);
      return started(taskId, { title: posting.title, company: posting.company, link: search ? linkTo(searchRunHref(search.id)) : undefined });
    },
  );

  server.registerTool(
    "get_search_words",
    {
      title: "Suggested search words",
      description:
        "The search words Find jobs and the profile editor suggest, worked out from the profile: job titles from the roles, specialties from the headline, and skills, with German words for a profile in Germany, Austria or Switzerland. " +
        "Use one as search_jobs keywords: a source treats every word as a requirement, so a whole headline finds nothing where \"Financial Analyst\" finds hundreds. " +
        "\"Senior\" is only a guess from about eight years of experience: leave it out when the user doesn't want it.",
      inputSchema: z.object({
        senior: z.boolean().optional().describe("Offer \"Senior\" with the latest title when the experience adds up to enough (default true)"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ senior }) => {
      const suggested = searchWords(await loadProfile(), new Date(), { senior: senior ?? true });
      if (suggested.groups.length === 0) {
        return text({ groups: [], message: "The profile has no roles, headline or skills to suggest words from yet. Fill them in on Profile, or search with the words the user gives.", link: linkTo("/profile") });
      }
      return text({
        german: suggested.german,
        senior_years: suggested.seniorYears ?? undefined,
        best: searchChips(suggested),
        groups: suggested.groups.map((group) => ({ title: group.title, words: group.words.map((word) => ({ text: word.text, language: word.language, why: word.why })) })),
        link: linkTo("/profile"),
      });
    },
  );
}
