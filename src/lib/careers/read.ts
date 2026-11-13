import "server-only";

import { parse } from "node-html-parser";

import { PostingSource } from "@/generated/prisma/enums";
import type { FoundPosting } from "@/lib/job-search/search";
import { fetchHtml, htmlText } from "@/lib/posting-fetch";

import { BOARD_NAMES, type Board } from "./boards";

// Reading the jobs on a careers page (jobauto fork): each job system's public
// feed of open jobs, in the shape Find jobs' postings have. Feeds sit on the
// job system's own hosts; a page of the employer's own goes through the
// guarded fetch, as a posting's link does.

export class CareersError extends Error {}

const TIMEOUT_MS = 20_000;
const MAX_CHARS = 20 * 1024 * 1024;
/** Workday lists 20 jobs a page: this many pages for each search word, at most. */
const WORKDAY_PAGES = 5;

/** The feed's answer as text, or why it couldn't be had, in words. */
async function get(url: string, init: RequestInit = {}): Promise<string> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.8", ...init.headers }, signal: AbortSignal.timeout(TIMEOUT_MS), cache: "no-store" });
  } catch {
    throw new CareersError(`${new URL(url).host} couldn't be reached.`);
  }
  if (response.status === 404) throw new CareersError("The job system doesn't know this careers page. Check its address.");
  if (!response.ok) throw new CareersError(`${new URL(url).host} answered ${response.status}.`);
  const text = await response.text();
  if (text.length > MAX_CHARS) throw new CareersError("The careers page lists more than Dossier can read.");
  return text;
}

async function getJson(url: string, init?: RequestInit): Promise<unknown> {
  const text = await get(url, init);
  try {
    return JSON.parse(text);
  } catch {
    throw new CareersError("The job system's answer couldn't be read.");
  }
}

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const iso = (value: unknown): string | null => {
  const time = typeof value === "number" ? value : Date.parse(str(value));
  return Number.isFinite(time) && time > 0 ? new Date(time).toISOString() : null;
};
const web = (value: string) => (/^https?:\/\//i.test(value) ? value.slice(0, 2000) : "");

/** One job, as a posting from the CAREERS source. */
function job(board: Board, fields: { id: string; title: string; company: string; place?: string; remote?: boolean | null; postedAt?: string | null; url: string; description?: string }): FoundPosting {
  const description = (fields.description ?? "").slice(0, 100_000);
  return {
    source: PostingSource.CAREERS,
    externalId: `${board.kind}:${boardKey(board)}:${fields.id}`.slice(0, 500),
    title: fields.title.slice(0, 500),
    company: fields.company.slice(0, 300),
    place: (fields.place ?? "").slice(0, 300),
    remote: fields.remote ?? null,
    salary: "",
    postedAt: fields.postedAt ?? null,
    url: web(fields.url),
    via: BOARD_NAMES[board.kind],
    description,
    complete: description.length > 200,
  };
}

/** What tells this board apart from another of the same job system. */
function boardKey(board: Board): string {
  switch (board.kind) {
    case "personio":
      return board.host.split(".")[0];
    case "greenhouse":
      return board.token;
    case "lever":
    case "smartrecruiters":
      return board.company;
    case "recruitee":
      return board.slug;
    case "ashby":
      return board.name;
    case "workday":
      return `${board.tenant}/${board.site}`;
    case "page":
      return new URL(board.url).hostname;
  }
}

/**
 * Every open job on the board, as postings from the CAREERS source, with
 * `company` as their company where the feed doesn't name one. `words` are
 * the employer's search words: Workday, whose feeds of big employers run
 * to thousands of jobs, is searched for each instead of read whole.
 */
export async function readBoard(board: Board, company: string, words: readonly string[] = []): Promise<FoundPosting[]> {
  switch (board.kind) {
    case "personio":
      return readPersonio(board, company);
    case "greenhouse": {
      const data = record(await getJson(`https://boards-api${board.eu ? ".eu" : ""}.greenhouse.io/v1/boards/${encodeURIComponent(board.token)}/jobs?content=true`));
      return list(data.jobs).map((entry) => {
        const item = record(entry);
        return job(board, { id: str(item.id), title: str(item.title), company: str(item.company_name) || company, place: str(record(item.location).name), postedAt: iso(item.first_published ?? item.updated_at), url: str(item.absolute_url), description: htmlText(str(item.content)) });
      });
    }
    case "lever": {
      const data = await getJson(`https://api${board.eu ? ".eu" : ""}.lever.co/v0/postings/${encodeURIComponent(board.company)}?mode=json`);
      return list(data).map((entry) => {
        const item = record(entry);
        const categories = record(item.categories);
        const sections = list(item.lists).map((section) => `${str(record(section).text)}\n${htmlText(str(record(section).content))}`);
        const workplace = str(item.workplaceType);
        return job(board, {
          id: str(item.id),
          title: str(item.text),
          company,
          place: str(categories.location) || list(categories.allLocations).map(str).join(" / "),
          remote: workplace ? workplace === "remote" : null,
          postedAt: iso(item.createdAt),
          url: str(item.hostedUrl),
          description: [str(item.descriptionPlain), ...sections, str(item.additionalPlain)].filter(Boolean).join("\n\n"),
        });
      });
    }
    case "smartrecruiters": {
      const data = record(await getJson(`https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(board.company)}/postings?limit=100`));
      return list(data.content).map((entry) => {
        const item = record(entry);
        const location = record(item.location);
        return job(board, {
          id: str(item.id),
          title: str(item.name),
          company: str(record(item.company).name) || company,
          place: [str(location.city), str(location.country).toUpperCase()].filter(Boolean).join(", "),
          remote: typeof location.remote === "boolean" ? location.remote : null,
          postedAt: iso(item.releasedDate),
          url: `https://jobs.smartrecruiters.com/${encodeURIComponent(board.company)}/${encodeURIComponent(str(item.id))}`,
        });
      });
    }
    case "recruitee": {
      const data = record(await getJson(`https://${board.slug}.recruitee.com/api/offers/`));
      return list(data.offers).map((entry) => {
        const item = record(entry);
        return job(board, {
          id: str(item.id),
          title: str(item.title),
          company: str(item.company_name) || company,
          place: str(item.location) || [str(item.city), str(item.country)].filter(Boolean).join(", "),
          remote: typeof item.remote === "boolean" ? item.remote : null,
          postedAt: iso(item.published_at ?? item.created_at),
          url: str(item.careers_url),
          description: [htmlText(str(item.description)), htmlText(str(item.requirements))].filter(Boolean).join("\n\n"),
        });
      });
    }
    case "ashby": {
      const data = record(await getJson(`https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(board.name)}`));
      return list(data.jobs).map((entry) => {
        const item = record(entry);
        return job(board, {
          id: str(item.id),
          title: str(item.title),
          company,
          place: str(item.location),
          remote: typeof item.isRemote === "boolean" ? item.isRemote : null,
          postedAt: iso(item.publishedAt),
          url: str(item.jobUrl),
          description: str(item.descriptionPlain) || htmlText(str(item.descriptionHtml)),
        });
      });
    }
    case "workday":
      return readWorkday(board, company, words);
    case "page":
      return readPage(board, company);
  }
}

// ─── Personio ───────────────────────────────────────────────────────────────

/** Personio's XML feed: one <position> a job, its texts as HTML in CDATA. */
async function readPersonio(board: Extract<Board, { kind: "personio" }>, company: string): Promise<FoundPosting[]> {
  const xml = await get(`https://${board.host}/xml`);
  if (!/<workzag-jobs[\s>]/.test(xml)) throw new CareersError("The job system's answer couldn't be read.");
  return [...xml.matchAll(/<position>([\s\S]*?)<\/position>/g)].map(([, position]) => {
    const descriptions = /<jobDescriptions>([\s\S]*?)<\/jobDescriptions>/.exec(position)?.[1] ?? "";
    const own = position.replace(/<jobDescriptions>[\s\S]*?<\/jobDescriptions>/, "");
    const field = (tag: string) => xmlText(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(own)?.[1] ?? "");
    const offices = [field("office"), ...[...own.matchAll(/<additionalOffice>([\s\S]*?)<\/additionalOffice>/g)].map(([, office]) => xmlText(office))].filter(Boolean);
    const description = [...descriptions.matchAll(/<jobDescription>([\s\S]*?)<\/jobDescription>/g)]
      .map(([, part]) => {
        const name = xmlText(/<name>([\s\S]*?)<\/name>/.exec(part)?.[1] ?? "");
        const value = htmlText(cdata(/<value>([\s\S]*?)<\/value>/.exec(part)?.[1] ?? ""));
        return [name, value].filter(Boolean).join("\n");
      })
      .filter(Boolean)
      .join("\n\n");
    const id = field("id");
    return job(board, {
      id,
      title: field("name"),
      company: field("subcompany") || company,
      place: [...new Set(offices)].join(" / "),
      postedAt: iso(field("createdAt")),
      url: `https://${board.host}/job/${encodeURIComponent(id)}`,
      description,
    });
  });
}

const cdata = (value: string) => value.trim().replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, "$1");
/** A plain XML field's text, entities decoded. */
const xmlText = (value: string) => parse(cdata(value)).text.replace(/\s+/g, " ").trim();

// ─── Workday ────────────────────────────────────────────────────────────────

/** Workday's job search, as its careers site asks it: 20 jobs a page, searched for each word. */
async function readWorkday(board: Extract<Board, { kind: "workday" }>, company: string, words: readonly string[]): Promise<FoundPosting[]> {
  const api = `${board.origin}/wday/cxs/${encodeURIComponent(board.tenant)}/${encodeURIComponent(board.site)}/jobs`;
  const found = new Map<string, FoundPosting>();
  for (const searchText of words.length > 0 ? words : [""]) {
    for (let page = 0; page < WORKDAY_PAGES; page++) {
      const data = record(
        await getJson(api, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ appliedFacets: {}, limit: 20, offset: page * 20, searchText }),
        }),
      );
      const postings = list(data.jobPostings).map(record);
      for (const item of postings) {
        const path = str(item.externalPath);
        if (!path) continue;
        found.set(path, job(board, {
          id: path.split("_").pop() || path,
          title: str(item.title),
          company,
          place: str(item.locationsText),
          remote: /remote/i.test(str(item.remoteType)) || null,
          postedAt: workdayPosted(str(item.postedOn)),
          url: `${board.origin}${board.locale ? `/${board.locale}` : ""}/${board.site}${path}`,
        }));
      }
      if (postings.length < 20 || (page + 1) * 20 >= Number(data.total ?? 0)) break;
    }
  }
  return [...found.values()];
}

/** "Posted Today", "Posted Yesterday", "Posted 3 Days Ago" as a date; "30+ Days Ago" too far back to say. */
export function workdayPosted(text: string, now = new Date()): string | null {
  const days = /today|heute/i.test(text) ? 0 : /yesterday|gestern/i.test(text) ? 1 : /(\d+)\s*(days?|tage?n?)/i.exec(text)?.[1];
  if (days === undefined || /\+/.test(text)) return null;
  const day = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - Number(days)));
  return day.toISOString();
}

// ─── A page of the employer's own ───────────────────────────────────────────

/** The JobPosting data (JSON-LD) on a careers page: each job it lists, or the one it is. */
async function readPage(board: Extract<Board, { kind: "page" }>, company: string): Promise<FoundPosting[]> {
  const page = await fetchHtml(board.url);
  if (!page.ok) throw new CareersError(page.error);
  const root = parse(page.html, { blockTextElements: { script: true } });
  const postings: FoundPosting[] = [];
  for (const script of root.querySelectorAll('script[type="application/ld+json"]')) {
    let data: unknown;
    try {
      data = JSON.parse(script.rawText);
    } catch {
      continue;
    }
    for (const item of jobPostings(data)) {
      const url = str(item.url) || page.url;
      const places = list([item.jobLocation].flat()).map((place) => {
        const address = record(record(place).address);
        return [str(address.addressLocality), str(address.addressCountry) || str(record(address.addressCountry).name)].filter(Boolean).join(", ");
      });
      postings.push(
        job(board, {
          id: str(item.identifier) || str(record(item.identifier).value) || url,
          title: str(item.title),
          company: str(record(item.hiringOrganization).name) || company,
          place: [...new Set(places.filter(Boolean))].join(" / "),
          remote: str(item.jobLocationType) === "TELECOMMUTE" || null,
          postedAt: iso(item.datePosted),
          url,
          description: htmlText(str(item.description)),
        }),
      );
    }
  }
  if (postings.length === 0) {
    throw new CareersError(
      "Dossier can't read the jobs on this page. It reads Personio, Greenhouse, Lever, SmartRecruiters, Recruitee, Ashby and Workday careers pages, and pages with job data: look for the page where the jobs are listed on one of those, often linked as “All jobs” or “Offene Stellen”.",
    );
  }
  return postings;
}

/** Every JobPosting in JSON-LD: an object, a list, an @graph, or an ItemList's items. */
function jobPostings(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.flatMap(jobPostings);
  const item = record(data);
  const type = item["@type"];
  if (type === "JobPosting" || (Array.isArray(type) && type.includes("JobPosting"))) return [item];
  return [...jobPostings(item["@graph"]), ...list(item.itemListElement).flatMap((element) => jobPostings(record(element).item ?? element))];
}
