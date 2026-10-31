import "server-only";

import { z } from "zod";

import { isAiUsable } from "@/lib/ai/config";
import { countryName } from "@/lib/job-search/countries";
import { describeSearch, postingKey, searchRunHref, viewHref, type FoundPosting, type ShownPosting } from "@/lib/job-search/search";
import { SOURCE_INFO } from "@/lib/job-search/sources";
import { startScoring } from "@/lib/jobs/score-posting";
import { listSearches, loadSearch, removeSearch } from "@/lib/posting-searches";
import { dismissPosting, foundFromPosting, listPostings, postingStates, savePosting, unmarkPosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { lastKnownTimeZone } from "@/lib/time-zone";

import { failure, postingLine, started, text, type ToolContext } from "../kit";

// Find jobs: saved and dismissed postings, past searches and Dossier's own scoring (jobauto fork).
// What the Saved, Dismissed and Past searches views show, and what their
// buttons do. Start application has no tool of its own: draft_application
// and save_application start one from the same postings, by search_id and
// number or posting_id, and keep the posting with it as the button does.

const LISTS = ["saved", "dismissed", "searches"] as const;
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

/** Registers these tools on the connector's server. */
export function registerPostingTools({ server, linkTo }: ToolContext): void {
  server.registerTool(
    "list_postings",
    {
      title: "List saved postings and past searches",
      description:
        "What Find jobs keeps: saved postings, dismissed ones and past searches, with the posting_id and search_id values the other tools take. " +
        "With a search_id: the postings that search found, numbered, without asking the job source again.",
      inputSchema: z.object({
        view: z.enum(LISTS).optional().describe("Only this list: saved, dismissed or searches. Without it, all three."),
        search_id: z.string().min(1).max(100).optional().describe("A past search, to list the postings it found instead"),
        from: z.number().int().min(1).optional().describe("Where each list (or the search) starts. Defaults to 1."),
        limit: z.number().int().min(1).max(100).optional().describe("At most this many per list. Defaults to 20."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ view, search_id, from, limit }) => {
      const take = limit ?? 20;
      const start = (from ?? 1) - 1;
      const timeZone = await lastKnownTimeZone();
      if (search_id) {
        const search = await loadSearch(search_id, { timeZone });
        if (!search) return failure(SEARCH_GONE);
        return text({
          search_id: search.id,
          searched: describeSearch(search.query, countryName(search.query.country)),
          source: SOURCE_INFO[search.source].name,
          ran: search.ranAt,
          found: search.postings.length,
          more_available: search.next !== null,
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
            searches.map((search) => ({
              search_id: search.id,
              searched: describeSearch(search.query, countryName(search.query.country)),
              ran: `${day} at ${search.time}`,
              found: search.found,
              source: SOURCE_INFO[search.source].name,
            })),
          );
          answer.searches = { total: searches.length, searches: searches.slice(start, start + take), link: linkTo(viewHref("history")) };
        } else {
          const postings = await listPostings(list);
          answer[list] = { total: postings.length, postings: postings.slice(start, start + take).map(keptLine), link: linkTo(viewHref(list)) };
        }
      }
      return text(answer);
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
}
