import "server-only";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { unitsSchema } from "@/lib/application-data";
import { germanNeed, textForGerman, type GermanNeed } from "@/lib/german-need";
import { fullText } from "@/lib/job-search/find";
import { postingText, type FoundPosting, type ProfileFit, type SearchPortal, type ShownPosting } from "@/lib/job-search/search";
import { sourceInfo } from "@/lib/job-search/sources";
import { withoutPrivateParts } from "@/lib/letter-frame";
import { postingsOfSearch } from "@/lib/library";
import { coverageOf, fitWords } from "@/lib/posting-coverage";
import { FETCH_MESSAGES, fetchPosting } from "@/lib/posting-fetch";
import { foundFromPosting, storePosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";
import { profileNamed, type ProfileSummary } from "@/lib/profiles";

import { readPastedPosting } from "./handoff";

// What every group of the connector's tools shares (src/lib/connector/tools/*):
// how answers and failures look, the address links point to, and where a
// posting comes from.

/** What a group of tools registers with: the request's server, and links into the app. */
export type ToolContext = {
  server: McpServer;
  /** The app's address for a path, e.g. linkTo("/profile"). */
  linkTo: (path: string) => string;
  /** The name the client signed in with, e.g. "Claude Code"; "" when unknown. */
  clientName?: string;
};

/** An answer: a string as is, anything else as indented JSON. */
export const text = (value: unknown): CallToolResult => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] });

/** A failure Claude reads and can act on, written for the user. */
export const failure = (message: string): CallToolResult => ({ content: [{ type: "text", text: message }], isError: true });

/** Work that goes on in the background: its task_id, to follow with check_task. */
export const started = (taskId: string, extra: Record<string, unknown> = {}): CallToolResult =>
  text({ task_id: taskId, status: "started", ...extra, next: "Call check_task with this task_id until it's done." });

/** Which of the user's profiles a tool reads or writes (E24-6), by name or id. */
export const profileInput = z.string().max(200).optional().describe("The profile's name, as get_profile lists them; the first profile when left out");

/** The profile a tool was given by name or id (the first without one), or a failure saying which there are. */
export async function chooseProfile(asked: string | undefined): Promise<ProfileSummary | { failure: CallToolResult }> {
  const chosen = await profileNamed(asked);
  return "error" in chosen ? { failure: failure(chosen.error) } : chosen;
}

/**
 * A posting's score as Claude reads it (E32-2): how many of its requirements
 * the profile covers, in words, and which profile when there are several.
 */
export function fitLine(fit: (Pick<ProfileFit, "breakdown"> & { profileName?: string }) | null | undefined) {
  if (!fit) return undefined;
  const coverage = coverageOf(fit);
  return { covered: `${coverage.hit} of ${coverage.total}`, fit: fitWords(coverage), profile: fit.profileName || undefined };
}

/** The portals of a search that answered, by name. */
export const portalsAnswered = (portals: readonly SearchPortal[]): string[] =>
  portals.filter((portal) => portal.status === "done").map((portal) => sourceInfo(portal.id).name);

/**
 * The portals of a search that failed or were skipped, and why, as the
 * search's bar on Positions says it: "Adzuna: The portal couldn't be reached."
 */
export function portalProblems(portals: readonly SearchPortal[]): string[] | undefined {
  const problems = portals
    .filter((portal) => portal.status === "failed" || portal.status === "skipped")
    .map((portal) => `${sourceInfo(portal.id).name}: ${portal.message ?? (portal.status === "failed" ? "It didn't answer." : "Skipped.")}`);
  return problems.length > 0 ? problems : undefined;
}

/** Whether Show more (more_jobs) has more to ask for: it asks every portal of the search that has a next page. */
export const hasMore = (portals: readonly SearchPortal[]): boolean => portals.some((portal) => portal.next !== null);

/** A posting as Claude sees it in a list: numbered, without its whole text. */
export function postingLine(posting: ShownPosting | FoundPosting, number: number) {
  const state = "state" in posting ? posting.state : null;
  // The other portals the same job was found on (E22-6); its own comes first.
  const alsoOn = state?.foundOn.slice(1).map((found) => sourceInfo(found.portal).name) ?? [];
  return {
    number,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary || undefined,
    posted: posting.postedAt?.slice(0, 10),
    via: posting.via || undefined,
    also_on: alsoOn.length > 0 ? [...new Set(alsoOn)] : undefined,
    // The AI clients or careers pages that added it (add_found_jobs, careers pages).
    added_by: state?.addedBy.length ? state.addedBy : undefined,
    url: posting.url || undefined,
    saved: state?.saved || undefined,
    applied: state?.applicationId ? true : undefined,
    fit: fitLine(state?.score),
    german: germanLine(germanNeed(textForGerman(posting))),
    snippet: posting.description.replace(/\s+/g, " ").slice(0, 280),
  };
}

/** The German a posting asks for, in a few words for Claude to weigh against the profile's; undefined when it names none. */
function germanLine(need: GermanNeed): string | undefined {
  if (need.englishWorkplace) return `the team works in English: “${need.evidence}”`;
  if (need.implied) return "the ad is in German and names no level: expect about B2";
  if (need.level) return `${need.level}: “${need.evidence}”`;
  if (need.optional) return `only a plus: “${need.evidence}”`;
  return undefined;
}

/** The text of a tailored document's parts, in order, without a letter's sender and signature. */
export function documentText(units: unknown): string {
  const parsed = unitsSchema.safeParse(units);
  if (!parsed.success) return "";
  return withoutPrivateParts(parsed.data)
    .map((unit) => `## ${unit.label || unit.id}\n${unit.text}`)
    .join("\n\n");
}

/** Where a posting comes from, in a tool's input. */
export const postingSource = {
  posting_id: z.string().max(100).optional().describe("A posting Dossier handed over, by its posting_id"),
  paste_id: z.string().max(100).optional().describe("A pasted posting Dossier handed over, by its paste_id"),
  search_id: z.string().max(100).optional().describe("A search from search_jobs"),
  number: z.number().int().min(1).optional().describe("The posting's number in that search"),
  posting_url: z.url({ protocol: /^https?$/ }).max(2000).optional().describe("The posting's web address"),
  posting_text: z.string().max(100_000).optional().describe("The posting's text, pasted"),
};

export type PostingSource = { posting_id?: string; paste_id?: string; search_id?: string; number?: number; posting_url?: string; posting_text?: string };
export type ResolvedPosting = { text: string; url: string; postingId: string | null; title?: string; company?: string; place?: string };

/** The whole text of a posting from a search, one handed over, a link or pasted text, or what's wrong. */
export async function resolvePosting(source: PostingSource): Promise<ResolvedPosting | { error: string }> {
  if (source.posting_id) {
    const row = await prisma.posting.findUnique({ where: { id: source.posting_id } });
    if (!row) return { error: "That posting is no longer in Dossier. Open it again from Positions." };
    const found = foundFromPosting(row);
    const description = found.complete ? found.description : ((await fullText(found)) ?? found.description);
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    return { text: postingText({ ...found, description }), url: found.url, postingId: row.id, title: found.title, company: found.company, place: found.place };
  }
  if (source.paste_id) {
    const pasted = await readPastedPosting(source.paste_id);
    if (!pasted) return { error: "That pasted posting is no longer kept. Paste it into New application again, or here as posting_text." };
    return { text: pasted.text, url: pasted.url, postingId: null };
  }
  if (source.search_id) {
    // Numbered in the order the search found them, as search_jobs listed them (E22-5).
    const kept = await postingsOfSearch(source.search_id);
    const found = source.number ? kept[source.number - 1] : undefined;
    if (!found) return { error: "There's no such posting in that search. Use a number from search_jobs." };
    const whole = await fullText(found);
    const description = whole ?? found.description;
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    return {
      text: postingText({ ...found, description }),
      url: found.url,
      // Kept with its whole text when the portal gave it, as Positions keeps a posting it applies from.
      postingId: (await storePosting(whole ? { ...found, description: whole, complete: true } : found)).id,
      title: found.title,
      company: found.company,
      place: found.place,
    };
  }
  // Pasted text is used as it is, with its link kept: a page Dossier can't read, such as one behind a sign-in, mustn't fail it.
  if (source.posting_text?.trim()) return { text: source.posting_text.trim(), url: source.posting_url ?? "", postingId: null };
  if (source.posting_url) {
    const fetched = await fetchPosting(source.posting_url);
    if (!fetched.ok) return { error: `${fetched.error} Paste the posting's text as posting_text instead.` };
    // Menus or links rather than a posting (#232): nothing to write from.
    if (fetched.doubtful) return { error: `${FETCH_MESSAGES.doubtful} Paste the posting's text as posting_text instead.` };
    return { text: fetched.text, url: fetched.url, postingId: null };
  }
  return { error: "Give posting_id, paste_id, search_id and number, posting_url, or posting_text." };
}
