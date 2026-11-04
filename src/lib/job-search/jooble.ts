import "server-only";

import { z } from "zod";

import { fetchPosting } from "@/lib/posting-fetch";

import type { JobSourceAdapter, RequestContext, SourceCredentials } from "./adapter";
import { countryName } from "./countries";
import { jobSearchError } from "./errors";
import { requestJson } from "./http";
import { POSTED_WITHIN, safeLink, type FoundPosting, type SearchPage, type SearchQuery } from "./search";
import { plainText } from "./text";

// Jooble: its own job index, free with a key it emails on request. A search is
// a POST with the key in the path, so requestJson is given a label to log
// instead of the path. A key belongs to one country (one from jooble.org lists
// US jobs only; Germany's is asked for on de.jooble.org), so the search says
// no country, and the free plan is 500 searches in all, not a month: a page of
// results is one of them, and nothing here asks twice. Only a snippet of each
// posting comes back, so the rest is read from its page when it's selected.

const BASE_URL = "https://jooble.org/api";
/** What the log calls a request: its real path holds the key. */
const CALL = "/api/{key}";

/** The radii Jooble takes, in km. */
const RADII = [0, 4, 8, 16, 26, 40, 80];

/** The smallest radius Jooble takes that reaches as far as `km`, or its widest. */
export function radiusFor(km: number): number {
  return RADII.find((radius) => radius >= km) ?? RADII[RADII.length - 1];
}

// Every field may be missing or null; one odd field doesn't drop the posting.
const maybeText = z.string().nullish().catch(null);

const jobSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String),
  title: maybeText,
  location: maybeText,
  snippet: maybeText,
  /** Free text, often empty: "17,600 UAH". */
  salary: maybeText,
  /** The board it came from; Jooble's own is "jooble". */
  source: maybeText,
  company: maybeText,
  link: maybeText,
  /** "2023-09-15T12:55:35.3870000": when the posting last changed. */
  updated: maybeText,
});
type Job = z.output<typeof jobSchema>;

const responseSchema = z.object({ jobs: z.array(z.unknown()), totalCount: z.coerce.number().nullish().catch(null) });

const UPDATED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:?\d{2})?$/;

/**
 * When the posting last changed, as an ISO time; null when it isn't one.
 * Jooble writes seven fractional digits and no zone, which is read as UTC: at
 * most a few hours off.
 */
export function updatedAt(text: string | null | undefined): string | null {
  const match = UPDATED.exec((text ?? "").trim());
  if (!match) return null;
  const time = Date.parse(`${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}${match[3] ?? "Z"}`);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/**
 * Jooble's id for the posting. Its ids run to 19 digits, past what a JSON number holds, so
 * `id` arrives rounded; the link, jooble.org/jdp/<id>, has it exactly.
 */
function idOf(job: Job): string {
  return /\/jdp\/(-?\d+)(?:[/?#]|$)/.exec(job.link ?? "")?.[1] ?? job.id;
}

export function postingFromJob(job: Job): FoundPosting {
  const via = (job.source ?? "").trim();
  return {
    source: "JOOBLE",
    externalId: idOf(job).slice(0, 500),
    title: plainText(job.title).slice(0, 500),
    company: plainText(job.company).slice(0, 300),
    place: plainText(job.location).slice(0, 300),
    remote: null,
    salary: plainText(job.salary).slice(0, 200),
    postedAt: updatedAt(job.updated),
    url: safeLink(job.link).slice(0, 2000),
    // Jooble's own index says "jooble"; a board it took the posting from, its name.
    via: /^jooble(?:\.org)?$/i.test(via) ? "" : via.slice(0, 100),
    description: plainText(job.snippet).slice(0, 100_000),
    complete: false,
  };
}

/** The request body: the page and radius as strings, as Jooble's own example sends them. */
function searchBody(query: SearchQuery, page: number): Record<string, string> {
  return {
    // Jooble has no remote filter: the word does what it can.
    keywords: query.remoteOnly ? `${query.keywords} remote` : query.keywords,
    location: query.place || (query.country ? countryName(query.country) : ""),
    // A radius only means something around a place.
    ...(query.place ? { radius: String(radiusFor(query.radiusKm)) } : {}),
    page: String(page),
  };
}

/** The cursor "page:2:20": the next page, and how many results the pages before it gave (Jooble's page size isn't promised). */
function cursorOf(next: string | null): { page: number; seen: number } {
  const match = /^page:(\d+):(\d+)$/.exec(next ?? "");
  return match ? { page: Math.max(1, Number(match[1])), seen: Number(match[2]) } : { page: 1, seen: 0 };
}

async function searchPage(query: SearchQuery, { key }: SourceCredentials["JOOBLE"], next: string | null, context: RequestContext = {}): Promise<SearchPage> {
  const { page, seen } = cursorOf(next);
  const url = new URL(`${context.baseUrl ?? BASE_URL}/${encodeURIComponent(key)}`);
  const answer = responseSchema.safeParse(await requestJson("JOOBLE", url, { body: searchBody(query, page), label: CALL, signal: context.signal }));
  if (!answer.success) throw jobSearchError("changed", "JOOBLE", { detail: `${CALL}: unexpected answer` });

  // Jooble has no date filter, so the window is applied here, to when each posting last changed; one without a date stays.
  const days = POSTED_WITHIN.find((option) => option.value === query.postedWithin)?.days ?? null;
  const earliest = days === null ? null : Date.now() - days * 86_400_000;
  const ids = new Set<string>();
  const postings: FoundPosting[] = [];
  for (const item of answer.data.jobs) {
    const job = jobSchema.safeParse(item);
    if (!job.success) continue;
    const posting = postingFromJob(job.data);
    if (ids.has(posting.externalId)) continue;
    ids.add(posting.externalId);
    if (earliest !== null && posting.postedAt !== null && Date.parse(posting.postedAt) < earliest) continue;
    postings.push(posting);
  }

  const total = answer.data.totalCount ?? 0;
  const given = seen + answer.data.jobs.length;
  return { postings, next: answer.data.jobs.length > 0 && given < total ? `page:${page + 1}:${given}` : null };
}

export const jooble: JobSourceAdapter<"JOOBLE"> = {
  source: "JOOBLE",
  search: searchPage,
  // The rest of the posting is on its page, which the guarded fetcher reads like "Fetch" does (E7-8); Jooble's own page may turn it away.
  details: async (posting) => {
    if (!posting.url) return null;
    const page = await fetchPosting(posting.url);
    return page.ok ? page.text : null;
  },
  // Whatever country the key is for, an answer (even without jobs) shows Jooble takes it.
  test: async (credentials, context) => {
    await searchPage({ keywords: "developer", place: "Berlin", country: "de", radiusKm: 25, remoteOnly: false, postedWithin: "any" }, credentials, null, context);
  },
};
