import "server-only";

import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

import { unitsSchema } from "@/lib/application-data";
import { fullText } from "@/lib/job-search/find";
import { foundPostingSchema, postingText, type FoundPosting, type ShownPosting } from "@/lib/job-search/search";
import { withoutPrivateParts } from "@/lib/letter-frame";
import { fetchPosting } from "@/lib/posting-fetch";
import { foundFromPosting, storePosting } from "@/lib/postings";
import { prisma } from "@/lib/prisma";

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

/** A posting as Claude sees it in a list: numbered, without its whole text. */
export function postingLine(posting: ShownPosting | FoundPosting, number: number) {
  const state = "state" in posting ? posting.state : null;
  return {
    number,
    title: posting.title,
    company: posting.company,
    place: posting.place,
    remote: posting.remote,
    salary: posting.salary || undefined,
    posted: posting.postedAt?.slice(0, 10),
    via: posting.via || undefined,
    also_on: posting.alsoOn?.length ? posting.alsoOn.map((source) => source.toLowerCase()) : undefined,
    url: posting.url || undefined,
    saved: state?.saved || undefined,
    applied: state?.applicationId ? true : undefined,
    fit: state?.score ?? undefined,
    snippet: posting.description.replace(/\s+/g, " ").slice(0, 280),
  };
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
    if (!row) return { error: "That posting is no longer in Dossier. Open it again from Find jobs." };
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
    const search = await prisma.postingSearch.findUnique({ where: { id: source.search_id }, select: { postings: true } });
    const kept = foundPostingSchema.array().catch([]).parse(search?.postings ?? []);
    const found = source.number ? kept[source.number - 1] : undefined;
    if (!found) return { error: "There's no such posting in that search. Use a number from search_jobs." };
    const whole = await fullText(found);
    const description = whole ?? found.description;
    if (!description.trim()) return { error: "That posting has no text to write from. Give its link as posting_url instead." };
    return {
      text: postingText({ ...found, description }),
      url: found.url,
      // Kept with its whole text when the source gave it, as Find jobs keeps a posting it applies from.
      postingId: (await storePosting(whole ? { ...found, description: whole, complete: true } : found)).id,
      title: found.title,
      company: found.company,
      place: found.place,
    };
  }
  if (source.posting_url) {
    const fetched = await fetchPosting(source.posting_url);
    if (!fetched.ok) return { error: `${fetched.error} Paste the posting's text as posting_text instead.` };
    return { text: fetched.text, url: fetched.url, postingId: null };
  }
  if (source.posting_text?.trim()) return { text: source.posting_text.trim(), url: "", postingId: null };
  return { error: "Give posting_id, paste_id, search_id and number, posting_url, or posting_text." };
}
