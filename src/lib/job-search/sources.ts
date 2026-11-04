import type { JobSource, JSearchHost, PostingOrigin, SourceProblem } from "./search";

/** What Settings → Job search may know about a source's key: never the key itself. "env" means it comes from the environment. */
export type JobKeyState = "none" | "set" | "unreadable" | "env";

/** What the Job search section starts from (E14-4). */
export type JobSearchSettingsView = {
  source: JobSource | "OFF";
  jsearch: { host: JSearchHost; keyState: JobKeyState };
  serpapi: { keyState: JobKeyState };
  adzuna: { appId: string; keyState: JobKeyState };
  jooble: { keyState: JobKeyState };
  /** Whether this server offers the Bundesagentur für Arbeit, and when its note was accepted (#223). */
  arbeitsagentur: { offered: boolean; acceptedAt: string | null };
};

export const JOB_KEY_UNREADABLE = "Your saved key can't be read. Please enter it again.";

/** Where to get a JSearch key, by where it's from. */
export const JSEARCH_KEY_URLS: Record<JSearchHost, string> = {
  openwebninja: "https://www.openwebninja.com/api/jsearch",
  rapidapi: "https://rapidapi.com/letscrape-6bRBa3QguO5/api/jsearch",
};

/** How Settings → Job search and the Find jobs screen describe each source (E14). */
export type SourceInfo = {
  name: string;
  /** What it covers, in a line. */
  description: string;
  /** Cost and reach at a glance. */
  tag: string;
  /** Where to get a key; null when none is needed. */
  keyUrl: string | null;
  /** When used-up searches come back: "this month", "today"; null when there's no quota. */
  quotaPeriod: string | null;
  /** Shown with its results, as the source's terms ask. */
  attribution: string | null;
  /**
   * Where the attribution links, when the terms ask for a link: the source's
   * site for the posting's country when its link is on one (`local`), else
   * `home`. Null for a plain-text attribution.
   */
  attributionLink: { home: string; local: RegExp } | null;
  /** The countries it lists jobs in (ISO codes); null for every country. */
  countries: readonly string[] | null;
};

export const SOURCE_INFO: Record<PostingOrigin, SourceInfo> = {
  JSEARCH: {
    name: "JSearch",
    description: "Postings from LinkedIn, Indeed, Glassdoor and company sites, through Google for Jobs.",
    tag: "Most countries · free key with 200 searches a month",
    keyUrl: "https://www.openwebninja.com/api/jsearch",
    quotaPeriod: "this month",
    attribution: null,
    attributionLink: null,
    countries: null,
  },
  SERPAPI: {
    name: "SerpApi",
    description: "Google for Jobs through SerpApi: postings from LinkedIn, Indeed, company sites and more, with their whole text.",
    tag: "Most countries · free key with 250 searches a month",
    keyUrl: "https://serpapi.com/manage-api-key",
    quotaPeriod: "this month",
    attribution: null,
    attributionLink: null,
    countries: null,
  },
  ADZUNA: {
    name: "Adzuna",
    description: "Adzuna's own job index in 19 countries. It only shares the start of each posting.",
    tag: "19 countries · free key, about 250 searches a day",
    keyUrl: "https://developer.adzuna.com/signup",
    quotaPeriod: "today",
    attribution: "Jobs by Adzuna",
    // Its terms: "Adzuna" on each displayed advert, at least 116 × 23 px, linked to adzuna.co.uk or the local site.
    attributionLink: { home: "https://www.adzuna.co.uk", local: /^www\.adzuna\.(?:[a-z]{2,3}|co\.[a-z]{2}|com\.[a-z]{2})$/ },
    countries: ["at", "au", "be", "br", "ca", "ch", "de", "es", "fr", "gb", "in", "it", "mx", "nl", "nz", "pl", "sg", "us", "za"],
  },
  JOOBLE: {
    name: "Jooble",
    description: "Jooble's own job index. A key is for one country (Germany's is asked for on de.jooble.org), and it only shares the start of each posting.",
    tag: "One country per key · free key, 500 searches in all",
    keyUrl: "https://jooble.org/api/about",
    // Not a month or a day: the free plan's 500 searches are for good.
    quotaPeriod: "in all",
    attribution: "Jobs by Jooble",
    attributionLink: null,
    countries: null,
  },
  ARBEITSAGENTUR: {
    name: "Bundesagentur für Arbeit",
    description: "Germany's federal job board, with full postings. Unofficial: you choose it on your own responsibility.",
    tag: "Germany only · free, no key · unofficial",
    keyUrl: null,
    quotaPeriod: null,
    attribution: "Source: Bundesagentur für Arbeit",
    attributionLink: null,
    countries: ["de"],
  },
  // Not a source to choose: postings an AI client (Claude, Gemini…) found itself and added through the connector.
  CLIENT: {
    name: "AI client",
    description: "Postings an AI client like Claude or Gemini found on the web and added to Dossier.",
    tag: "Added through the connector",
    keyUrl: null,
    quotaPeriod: null,
    attribution: null,
    attributionLink: null,
    countries: null,
  },
};

/** "JSearch and SerpApi", or "AI client · Gemini CLI": where a kept search's postings came from, naming the client that added them. */
export function searchSourcesName(sources: readonly PostingOrigin[], addedBy = ""): string {
  if (sources.includes("CLIENT")) return addedBy ? `${SOURCE_INFO.CLIENT.name} · ${addedBy}` : SOURCE_INFO.CLIENT.name;
  const names = sources.map((source) => SOURCE_INFO[source].name);
  return names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

/** "You've used up your JSearch searches for this month. … Searched SerpApi instead.": a source's problem in a search that went on. */
export function describeSourceProblem(problem: SourceProblem): string {
  return problem.fallback ? `${problem.message} Searched ${SOURCE_INFO[problem.fallback].name} instead.` : problem.message;
}

/** Whether a source lists jobs in a country ("de"). */
export function sourceCovers(source: JobSource, country: string): boolean {
  const countries = SOURCE_INFO[source].countries;
  return countries === null || countries.includes(country);
}

// The Bundesagentur für Arbeit (#223) has no official API: Dossier uses the
// access its own job search uses, without its permission. So it's the
// user's own choice, after this note, and a server can turn it off
// (DOSSIER_JOBS_ARBEITSAGENTUR=off).

/** The BA's terms of use for arbeitsagentur.de. */
export const ARBEITSAGENTUR_TERMS_URL = "https://www.arbeitsagentur.de/datei/nutzungsbedingungen_ba036575.pdf";

/** What "I understand" agrees to, in Settings, in Find jobs and in the server log. */
export const ARBEITSAGENTUR_NOTE =
  "The Bundesagentur für Arbeit has no official API. Dossier searches it through the access its own job search uses, without its permission, " +
  "and the BA's terms of use don't allow automated access. You choose this source on your own responsibility, and it can stop working at any time.";

/** A BA posting's own page on arbeitsagentur.de, which its results always link to, even when they have a link of their own. */
export function arbeitsagenturPage(posting: { source: PostingOrigin; externalId: string }): string | null {
  return posting.source === "ARBEITSAGENTUR" ? `https://www.arbeitsagentur.de/jobsuche/jobdetail/${encodeURIComponent(posting.externalId)}` : null;
}

/** Where a posting's attribution links (www.adzuna.de for one of Adzuna's German postings); null when it's plain text. */
export function attributionHref(source: PostingOrigin, postingUrl: string): string | null {
  const link = SOURCE_INFO[source].attributionLink;
  if (!link) return null;
  const host = URL.canParse(postingUrl) ? new URL(postingUrl) : null;
  return host?.protocol === "https:" && link.local.test(host.hostname) ? host.origin : link.home;
}
