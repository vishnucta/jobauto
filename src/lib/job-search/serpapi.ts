import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import type { JobSourceAdapter, RequestContext, SourceCredentials } from "./adapter";
import { jobSearchError } from "./errors";
import { requestJson } from "./http";
import { normalText, POSTED_WITHIN, safeLink, type FoundPosting, type SearchPage, type SearchQuery } from "./search";

// SerpApi: Google for Jobs through serpapi.com's google_jobs engine, which
// gives each posting's whole text. A page of ten is one search from the plan
// (250 a month free, 50 an hour); the same search again within the hour comes
// from SerpApi's cache and costs nothing. The key goes in the query string,
// as SerpApi takes it; requestJson only ever logs the path.
//
// Google answers in the country's own language, or not at all: asked for
// Hamburg in English (hl=en, gl=de) it has no jobs, asked in German it has
// pages of them. So the search goes in that language, and what Google writes
// under each posting (its age, remote work, pay) is read in it too.

const BASE_URL = "https://serpapi.com";
const SEARCH_PATH = "/search.json";

/** Countries where English is the working language, though not the likely one by CLDR. */
const IN_ENGLISH = new Set(["in", "sg", "ae", "sa", "qa", "kw", "bh", "om", "za", "ph", "my", "hk", "ng", "ke", "pk", "lk", "mt", "cy"]);
/** Where the likely language isn't the one Google's jobs are in. */
const INSTEAD: Record<string, string> = { lu: "fr" };
/** Google's own codes where they differ from CLDR's. */
const GOOGLE_CODES: Record<string, string> = { nb: "no", nn: "no", he: "iw", fil: "tl" };

/** The language to ask Google for jobs in a country: "de" for Germany, "en" without a country. */
export function languageFor(country: string): string {
  if (!country || IN_ENGLISH.has(country)) return "en";
  if (INSTEAD[country]) return INSTEAD[country];
  let language: string;
  try {
    language = new Intl.Locale(`und-${country.toUpperCase()}`).maximize().language;
  } catch {
    return "en";
  }
  if (language === "und") return "en";
  if (language === "zh") return country === "tw" ? "zh-TW" : "zh-CN";
  return GOOGLE_CODES[language] ?? language;
}

// Every field may be missing or null; one odd field doesn't drop the posting.
const maybeText = z.string().nullish().catch(null);
const maybeFlag = z.boolean().nullish().catch(null);

const jobSchema = z.object({
  job_id: z.string().min(1),
  title: maybeText,
  company_name: maybeText,
  location: maybeText,
  via: maybeText,
  share_link: maybeText,
  description: maybeText,
  /** What Google shows under the title ("vor 5 Tagen", "Vollzeit", "Homeoffice", "60.000 € pro Jahr"), in the search's language. */
  extensions: z.array(z.string().catch("")).nullish().catch(null),
  /** The same, read by SerpApi: in English only. */
  detected_extensions: z.object({ posted_at: maybeText, salary: maybeText, work_from_home: maybeFlag }).nullish().catch(null),
  apply_options: z.array(z.object({ title: maybeText, link: maybeText })).nullish().catch(null),
});
type Job = z.output<typeof jobSchema>;

const responseSchema = z.object({
  jobs_results: z.array(z.unknown()).optional(),
  serpapi_pagination: z.object({ next_page_token: z.string().nullish() }).nullish(),
  /** "Fully empty" when Google found nothing. */
  search_information: z.object({ jobs_results_state: z.string().nullish() }).nullish().catch(null),
  /** With a 200: nothing found, or a request Google didn't take. */
  error: z.string().optional(),
});

// How Google writes a posting's age in the languages its jobs search speaks:
// a number (or "30+") and a unit, around words like "ago", "vor" or "il y a".
const JUST_NOW = /^(?:just posted|today|now|heute|gerade eben|soeben|aujourd.hui|à l.instant|vandaag|zojuist|hoy|ahora|oggi|adesso|hoje|agora|dzisiaj|dziś|teraz|idag|i dag|nyss|tänään|juuri nyt)$/u;
const YESTERDAY = /^(?:yesterday|gestern|hier|gisteren|ayer|ieri|ontem|wczoraj|igår|i går|eilen)$/u;
const AGE = /^(?:vor|il y a|hace|h[aá]|för|for)?\s*(über|more than|plus de|más de|oltre|mais de|ponad|över|over)?\s*(\d+)\s*(\+?)\s*(\p{L}+)\.?\s*(?:ago|geleden|fa|temu|sedan|siden|sitten)?$/u;
const UNITS: [RegExp, number][] = [
  [/^(?:min|mins?|minutes?|minuten?|minuut|minutos?|minut[oi]|minut[ay]?|minuter|minuutti|minuuttia)$/u, 1 / 1440],
  [/^(?:h|hrs?|hours?|std|stunden?|heures?|uur|uren|horas?|or[ae]|godzin[ay]?|timm(?:e|ar)|timer?|tunti|tuntia)$/u, 1 / 24],
  [/^(?:days?|tag(?:en?)?|jours?|dag(?:en)?|d[ií]as?|giorn[oi]|dni|dzień|dagar|dage|dager|päivä|päivää)$/u, 1],
  [/^(?:weeks?|wochen?|semaines?|we(?:e)?k(?:en)?|semanas?|settiman[ae]|tygodni[ea]?|tydzień|veck(?:a|or)|uger?|uker?|viikko|viikkoa)$/u, 7],
  [/^(?:months?|monat(?:en?)?|mois|maand(?:en)?|mes(?:es)?|mês|mes[ei]|miesi[ąę]c[ey]?|månad(?:er)?|måned(?:er)?|kuukau(?:si|tta))$/u, 30],
];

/**
 * How many days ago "4 days ago", "vor 2 Stunden", "il y a 3 jours", "Just
 * posted" or "30+ days ago" was (Google says how long ago, not when); null
 * when the text says nothing of the kind. "30+" counts as 31: older than a
 * month.
 */
export function daysAgo(text: string | null | undefined): number | null {
  const age = (text ?? "").trim().toLocaleLowerCase().replace(/\s+/g, " ");
  if (!age) return null;
  if (JUST_NOW.test(age)) return 0;
  if (YESTERDAY.test(age)) return 1;
  const match = AGE.exec(age);
  if (!match) return null;
  const unit = UNITS.find(([words]) => words.test(match[4]));
  if (!unit) return null;
  const [, over, count, plus] = match;
  return (Number(count) + (over || plus ? 1 : 0)) * unit[1];
}

/** The posting's age as Google wrote it: SerpApi's reading of it (in English), else the extension that reads as one. */
function ageOf(job: Job): number | null {
  const detected = daysAgo(job.detected_extensions?.posted_at);
  if (detected !== null) return detected;
  for (const extension of job.extensions ?? []) {
    const days = daysAgo(extension);
    if (days !== null) return days;
  }
  return null;
}

/** When the posting went up, from its age, to the minute; null beyond a month, where Google only gives a bound ("30+ days ago"). */
function postedAtOf(days: number | null, now: number): string | null {
  if (days === null || days > 30) return null;
  return new Date(Math.round((now - days * 86_400_000) / 60_000) * 60_000).toISOString();
}

const REMOTE = /work from home|remote|home.?office|télétravail|thuiswerk|teletrabajo|smart working|da remoto|trabalho remoto|praca zdalna|hemifrån|hjemmefra|etätyö/iu;
const MONEY = /[€$£¥]|\b(?:EUR|USD|GBP|CHF|PLN|SEK|NOK|DKK|CZK|HUF|INR|AUD|CAD|NZD|SGD|AED|ZAR|BRL|MXN|TRY)\b/u;

/**
 * Google's own id for the posting, from inside SerpApi's job_id (base64 JSON
 * with an `htidocid`, the same id its share links carry); else a hash of the
 * job_id, which can run to a thousand characters.
 */
function externalIdOf(jobId: string): string {
  try {
    const decoded: unknown = JSON.parse(Buffer.from(jobId, "base64").toString("utf8"));
    const docId = (decoded as { htidocid?: unknown } | null)?.htidocid;
    if (typeof docId === "string" && docId) return docId.slice(0, 500);
  } catch {
    // Not base64 JSON: hashed below.
  }
  return createHash("sha256").update(jobId).digest("hex");
}

/** The employer's own apply link when Google lists one (named after the company, or its careers site), else the first, else Google's page. */
function linkOf(job: Job): string {
  const options = (job.apply_options ?? []).filter((option) => safeLink(option.link));
  const company = normalText(job.company_name ?? "");
  const own = options.find(({ title }) => title && (/career|karriere|jobs at/i.test(title) || (company !== "" && normalText(title).includes(company))));
  return safeLink(own?.link) || safeLink(options[0]?.link) || safeLink(job.share_link);
}

/** True when Google marks it work from home, or places it "Anywhere"; Google doesn't say when it isn't, so null otherwise. */
function remoteOf(job: Job, extensions: string[]): boolean | null {
  if (job.detected_extensions?.work_from_home === true || extensions.some((extension) => REMOTE.test(extension))) return true;
  return /^anywhere$/i.test((job.location ?? "").trim()) ? true : null;
}

export function postingFromJob(job: Job, now = Date.now()): FoundPosting {
  const description = (job.description ?? "").trim().slice(0, 100_000);
  const extensions = (job.extensions ?? []).map((extension) => extension.trim()).filter(Boolean);
  return {
    source: "SERPAPI",
    externalId: externalIdOf(job.job_id),
    title: (job.title ?? "").trim().slice(0, 500),
    company: (job.company_name ?? "").trim().slice(0, 300),
    place: (job.location ?? "").replace(/\s+/g, " ").trim().slice(0, 300),
    remote: remoteOf(job, extensions),
    // As written: "75K–90K a year", "60.000–70.000 € pro Jahr".
    salary: (job.detected_extensions?.salary?.trim() || extensions.find((extension) => MONEY.test(extension)) || "").slice(0, 200),
    postedAt: postedAtOf(ageOf(job), now),
    url: linkOf(job).slice(0, 2000),
    // "via LinkedIn", or just "LinkedIn".
    via: (job.via ?? "").replace(/^via\s+/i, "").trim().slice(0, 100),
    description,
    complete: description.length > 0,
  };
}

/** "designer in Hamburg remote": Google reads the place, and remote work, from the query; its own filters for them are gone. */
function queryText({ keywords, place, remoteOnly }: SearchQuery): string {
  return [keywords, place ? `in ${place}` : "", remoteOnly ? "remote" : ""].filter(Boolean).join(" ");
}

function searchUrl(query: SearchQuery, key: string, next: string | null, baseUrl?: string): URL {
  const url = new URL(`${baseUrl ?? BASE_URL}${SEARCH_PATH}`);
  url.searchParams.set("engine", "google_jobs");
  url.searchParams.set("q", queryText(query));
  // Without a country, Google searches the US.
  url.searchParams.set("gl", query.country || "us");
  url.searchParams.set("hl", languageFor(query.country));
  if (query.place) url.searchParams.set("lrad", String(query.radiusKm));
  if (next) url.searchParams.set("next_page_token", next);
  url.searchParams.set("api_key", key);
  return url;
}

async function searchPage(query: SearchQuery, { key }: SourceCredentials["SERPAPI"], next: string | null, context: RequestContext = {}): Promise<SearchPage> {
  const url = searchUrl(query, key, next, context.baseUrl);
  const answer = responseSchema.safeParse(await requestJson("SERPAPI", url, { signal: context.signal }));
  if (!answer.success) throw jobSearchError("changed", "SERPAPI", { detail: `${SEARCH_PATH}: unexpected answer` });

  const { jobs_results: jobs, serpapi_pagination: pagination, search_information: information, error } = answer.data;
  if (!jobs) {
    // Nothing found comes as a 200 with an error and a "Fully empty" state; anything else it says, Dossier doesn't know.
    if (information?.jobs_results_state === "Fully empty" || (error && /hasn't returned any results/i.test(error))) return { postings: [], next: null };
    throw jobSearchError("changed", "SERPAPI", { detail: `${SEARCH_PATH}: ${error ? "error" : "unexpected answer"}` });
  }

  // Google's date filter went with its chips, so the window is applied here,
  // to the ages it gives; a posting without one stays.
  const days = POSTED_WITHIN.find((option) => option.value === query.postedWithin)?.days ?? null;
  const now = Date.now();
  const seen = new Set<string>();
  const postings: FoundPosting[] = [];
  for (const item of jobs) {
    const job = jobSchema.safeParse(item);
    if (!job.success) continue;
    const posting = postingFromJob(job.data, now);
    if (seen.has(posting.externalId)) continue;
    seen.add(posting.externalId);
    if (days !== null) {
      const age = ageOf(job.data);
      if (age !== null && age > days) continue;
    }
    postings.push(posting);
  }

  return { postings, next: pagination?.next_page_token || null };
}

export const serpapi: JobSourceAdapter<"SERPAPI"> = {
  source: "SERPAPI",
  search: searchPage,
  // Search results carry the whole description.
  details: async (posting) => (posting.description ? posting.description : null),
  test: async (credentials, context) => {
    const page = await searchPage({ keywords: "developer", place: "", country: "us", radiusKm: 25, remoteOnly: false, postedWithin: "any" }, credentials, null, context);
    // Google has developer jobs in the US every day: none means the request isn't what it expects any more.
    if (page.postings.length === 0) throw jobSearchError("changed", "SERPAPI", { detail: `${SEARCH_PATH}: nothing for the test search` });
  },
};
