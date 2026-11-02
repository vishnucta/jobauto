import "server-only";

import { fetchPosting } from "@/lib/posting-fetch";

import { credentialsFor, loadJobSearchConfig, requestContext, type JobSearchConfig } from "./config";
import { JobSearchError } from "./errors";
import { postingDetails, searchPostings } from "./index";
import {
  isJobSource,
  JOB_SOURCES,
  uniquePostings,
  type Cursors,
  type FoundPosting,
  type JobSource,
  type SearchPage,
  type SearchProblem,
  type SearchQuery,
  type SourceProblem,
  type SourceState,
} from "./search";
import { SOURCE_INFO } from "./sources";

// Asking job sources from Find jobs (E14-6): a page from one or several
// sources, merged into one list, or what went wrong in words for the screen.
// Kept searches are in src/lib/posting-searches.ts.

/** Every source this server offers, with why one can't be searched now (no key, note not accepted), for the form's Source list. */
export function sourceStates(config: JobSearchConfig): SourceState[] {
  return JOB_SOURCES.filter((source) => source !== "ARBEITSAGENTUR" || config.arbeitsagentur.offered).map((source) => {
    try {
      credentialsFor(config, source);
      return { source, problem: null };
    } catch (error) {
      if (error instanceof JobSearchError) return { source, problem: error.message };
      throw error;
    }
  });
}

/** The sources a search can go to now. */
export const readySources = (config: JobSearchConfig): JobSource[] => sourceStates(config).flatMap(({ source, problem }) => (problem === null ? [source] : []));

type Answered = { source: JobSource; page: SearchPage };
type SourceAnswer = Answered | { source: JobSource; error: JobSearchError };

async function ask(config: JobSearchConfig, source: JobSource, query: SearchQuery, next: string | null): Promise<SourceAnswer> {
  try {
    return { source, page: await searchPostings(source, credentialsFor(config, source), query, next, requestContext(source)) };
  } catch (error) {
    if (error instanceof JobSearchError) return { source, error };
    throw error;
  }
}

export type SourcesAnswer = { ok: true; sources: JobSource[]; postings: FoundPosting[]; cursors: Cursors; problems: SourceProblem[] } | SearchProblem;

/**
 * One page from each of `sources`, as one list without the same job twice
 * (uniquePostings). A source that doesn't answer (no key, out of searches,
 * down) doesn't stop the others: on a first page, a ready source that wasn't
 * asked stands in for it, once each, and what went wrong comes back beside
 * the postings. Only nothing at all is a problem of its own. `cursors` ask
 * the sources for their next pages; `known` are the keys of postings a kept
 * search already holds, left out.
 */
export async function askSources(
  query: SearchQuery,
  sources: readonly JobSource[],
  { cursors = {}, known = [] }: { cursors?: Cursors; known?: Iterable<string> } = {},
): Promise<SourcesAnswer> {
  const config = await loadJobSearchConfig();
  const asked = JOB_SOURCES.filter((source) => sources.includes(source));
  if (asked.length === 0) return { ok: false, problem: "off", message: "Choose where to search in Settings → Job search first." };
  if (!query.country) return { ok: false, problem: "no-country", message: "Choose a country to search in." };

  const answers = await Promise.all(asked.map((source) => ask(config, source, query, cursors[source] ?? null)));
  // Standing in: the ready sources that weren't asked, in Settings' order, one for each that failed; not while paging.
  const spare = Object.keys(cursors).length > 0 ? [] : readySources(config).filter((source) => !asked.includes(source));
  const pages: Answered[] = [];
  const problems: SourceProblem[] = [];
  const standIns: JobSource[] = [];
  for (const answer of answers) {
    if ("page" in answer) {
      pages.push(answer);
      continue;
    }
    const fallback = spare.shift();
    problems.push({ source: answer.source, problem: answer.error.problem, message: answer.error.message, ...(fallback ? { fallback } : {}) });
    if (fallback) standIns.push(fallback);
  }
  for (const answer of await Promise.all(standIns.map((source) => ask(config, source, query, null)))) {
    if ("page" in answer) pages.push(answer);
    else problems.push({ source: answer.source, problem: answer.error.problem, message: answer.error.message });
  }

  if (pages.length === 0) {
    const [first] = problems;
    const message = problems.length === 1 ? first.message : problems.map((problem) => `${SOURCE_INFO[problem.source].name}: ${problem.message}`).join(" ");
    return { ok: false, problem: first.problem, message };
  }
  return {
    ok: true,
    sources: pages.map(({ source }) => source),
    postings: uniquePostings(
      pages.flatMap(({ page }) => page.postings),
      known,
    ),
    cursors: Object.fromEntries(pages.flatMap(({ source, page }) => (page.next ? [[source, page.next]] : []))),
    problems,
  };
}

/**
 * The whole text of a posting, from its own source (which may no longer be
 * the one chosen, for a saved posting); null when it can't be had.
 */
export async function fullText(posting: FoundPosting): Promise<string | null> {
  if (posting.complete) return posting.description;
  // An AI client's posting has no job source to ask: read its own page.
  if (!isJobSource(posting.source)) {
    const page = posting.url ? await fetchPosting(posting.url) : null;
    return page?.ok ? page.text : null;
  }
  try {
    return await postingDetails(posting.source, credentialsFor(await loadJobSearchConfig(), posting.source), posting, requestContext(posting.source));
  } catch (error) {
    if (error instanceof JobSearchError) return null;
    throw error;
  }
}
