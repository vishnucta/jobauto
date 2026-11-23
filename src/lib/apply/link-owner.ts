import { FIELD_EMPLOYERS } from "@/lib/careers/field-employers";
import { companyKey, sameCompany } from "@/lib/network";

import { detectAts, hostOf } from "./ats";

// Whose page a posting's link is (jobauto fork, "Apply at the source"):
// Google Jobs and the aggregators often hand over a copy of the ad on a site
// that collects other sites' job ads, and its "apply" is that site's own form
// or a detour. What is sent there reaches the employer late, without the
// PDFs, or not at all; a recruiter reads what arrives in their own job
// system against the opening. So a copy is called one, its form is never
// filled, and the way to the employer's own posting is offered instead.
// Shared with the browser: nothing here reads the database.

/** Sites that copy other sites' job ads, by the name the screens use, matched against the link's host without "www.". */
export const AD_COPY_SITES: readonly { name: string; pattern: RegExp }[] = [
  { name: "StudySmarter", pattern: /(^|\.)studysmarter\.de$/ },
  { name: "Trabajo.org", pattern: /(^|\.)trabajo\.org$/ },
  { name: "learn4good", pattern: /(^|\.)learn4good\.com$/ },
  { name: "Jooble", pattern: /(^|\.)jooble\.(org|com)$/ },
  { name: "Adzuna", pattern: /(^|\.)adzuna\.(de|com|at|ch|co\.uk)$/ },
  { name: "Women For Hire", pattern: /(^|\.)womenforhire\.com$/ },
  { name: "JobLeads", pattern: /(^|\.)jobleads\.(com|de)$/ },
  { name: "BeBee", pattern: /(^|\.)bebee\.com$/ },
  { name: "Jobilize", pattern: /(^|\.)jobilize\.com$/ },
  { name: "jobde.org", pattern: /(^|\.)jobde\.org$/ },
  { name: "Talent.com", pattern: /(^|\.)talent\.com$/ },
  { name: "Careerjet", pattern: /(^|\.)careerjet\.(de|com|at|ch)$/ },
  { name: "Jobrapido", pattern: /(^|\.)jobrapido\.com$/ },
  { name: "Kimeta", pattern: /(^|\.)kimeta\.de$/ },
  { name: "WhatJobs", pattern: /(^|\.)whatjobs\.com$/ },
  { name: "Jobsora", pattern: /(^|\.)jobsora\.com$/ },
  { name: "Jobted", pattern: /(^|\.)jobted\.(de|com)$/ },
  { name: "Jobijoba", pattern: /(^|\.)jobijoba\.(de|com)$/ },
  { name: "SimplyHired", pattern: /(^|\.)simplyhired\.(de|com)$/ },
];

/** Recruitment agencies' own sites: applying there reaches the consultant who holds the role, so it's no copy. */
const AGENCY_SITES: readonly { name: string; pattern: RegExp }[] = [
  { name: "Selby Jennings", pattern: /(^|\.)selbyjennings\.(com|de)$/ },
  { name: "Phaidon International", pattern: /(^|\.)phaidoninternational\.com$/ },
  { name: "Michael Page", pattern: /(^|\.)michaelpage\.(de|com|co\.uk)$/ },
  { name: "Page Personnel", pattern: /(^|\.)pagepersonnel\.(de|com)$/ },
  { name: "Robert Half", pattern: /(^|\.)roberthalf\.(de|com)$/ },
  { name: "Robert Walters", pattern: /(^|\.)robertwalters\.(de|com|co\.uk)$/ },
  { name: "Hays", pattern: /(^|\.)hays\.(de|com|co\.uk)$/ },
  { name: "Amadeus Fire", pattern: /(^|\.)amadeus-fire\.de$/ },
  { name: "Morgan McKinley", pattern: /(^|\.)morganmckinley\.(com|de)$/ },
  { name: "Amoria Bond", pattern: /(^|\.)amoriabond\.com$/ },
  { name: "Brewer Morris", pattern: /(^|\.)brewermorris\.com$/ },
  { name: "Harvey Nash", pattern: /(^|\.)harveynash\.(de|com)$/ },
  { name: "Randstad", pattern: /(^|\.)randstad\.(de|com)$/ },
  { name: "Adecco", pattern: /(^|\.)adecco\.(de|com)$/ },
];

export type LinkOwner =
  /** A copy of the ad on a site that collects other sites' job ads. */
  | { kind: "copy"; site: string }
  /** A recruitment agency's own site. */
  | { kind: "agency"; site: string }
  /** A site the app doesn't know that isn't named like the employer: it may be a copy. */
  | { kind: "unsure" };

/** Why the apply assistant doesn't fill a copy of the ad: the run's note, and the Apply tab's and the connector's answer. */
export const copyMessage = (site: string) =>
  `This link is a copy of the ad on ${site}, a site that collects other sites' job ads, so I don't fill in its form: what's sent there may never reach the employer. Find the employer's own posting and paste its link on the Apply tab.`;

/** The site a link copies an ad on ("Jooble"), or null when it isn't one the app knows. */
export function adCopySite(url: string): string | null {
  const host = hostOf(url);
  return (host && AD_COPY_SITES.find(({ pattern }) => pattern.test(host))?.name) || null;
}

const GERMAN_LETTERS: Readonly<Record<string, string>> = { ä: "ae", ö: "oe", ü: "ue", ß: "ss", Ä: "Ae", Ö: "Oe", Ü: "Ue" };

/**
 * Whether a host carries the employer's name: "mueller-logistik.de" for
 * "Müller Logistik GmbH", "nordbank.de" for "NORD BANK AG",
 * "karriere.ledgerly.de" for "Ledgerly GmbH". A word of the name counts from
 * four letters, so "AG" or "Co" alone match nothing; the whole name run
 * together counts at any length.
 */
export function namedLike(host: string, company: string): boolean {
  // Without the last part ("de", "com"): "ledgerly.de" doesn't name a company "De…".
  const core = host.toLowerCase().split(".").slice(0, -1).join(".").replace(/-/g, "");
  if (!core) return false;
  for (const name of [company, company.replace(/[äöüßÄÖÜ]/g, (letter) => GERMAN_LETTERS[letter] ?? letter)]) {
    const words = companyKey(name).split(" ").filter(Boolean);
    if (words.length === 0) continue;
    if (core.includes(words.join(""))) return true;
    if (words.some((word) => word.length >= 4 && core.includes(word))) return true;
  }
  return false;
}

/**
 * Whose page a link is: a copy of the ad, an agency's own site, or a site
 * that isn't named like the employer. Null when it's a job system or job
 * board the app knows, a site named like the employer, or there's no
 * employer to compare it with.
 */
export function linkOwner(url: string, company: string): LinkOwner | null {
  const host = hostOf(url);
  if (!host || detectAts(url).id !== "unknown") return null;
  const copy = AD_COPY_SITES.find(({ pattern }) => pattern.test(host));
  if (copy) return { kind: "copy", site: copy.name };
  const agency = AGENCY_SITES.find(({ pattern }) => pattern.test(host));
  if (agency) return { kind: "agency", site: agency.name };
  if (!companyKey(company) || namedLike(host, company)) return null;
  return { kind: "unsure" };
}

/**
 * How good a place to apply at is, best first (jobauto fork, "Keep every
 * apply option"): 0 the employer's own site or its job system, 1 an
 * agency's own site, 2 a job board, 3 a site the app can't place (no
 * employer to compare, or not named like it), 4 a copy of the ad; null for
 * what isn't a web address. `name` is what the portal calls the site
 * ("Ledgerly Careers"): a site it names after the employer counts as the
 * employer's.
 */
export function linkRank({ url, name = "" }: { url: string; name?: string }, company: string): number | null {
  const host = hostOf(url);
  if (!host || !/^https?:\/\//i.test(url.trim())) return null;
  const ats = detectAts(url);
  if (ats.id !== "unknown") return ats.board ? 2 : 0;
  const owner = linkOwner(url, company);
  if (owner?.kind === "copy") return 4;
  if (owner?.kind === "agency") return 1;
  if (!companyKey(company)) return 3;
  if (owner === null || namedAfter(name, company)) return 0;
  return 3;
}

/** Whether the portal's name for a site names the employer: "Ledgerly Careers" for "Ledgerly GmbH". */
function namedAfter(name: string, company: string): boolean {
  const key = companyKey(company);
  const said = companyKey(name);
  return key.length >= 3 && said.length > 0 && ` ${said} `.includes(` ${key} `);
}

/**
 * The link to keep as a posting's own: the best-ranked of `options`
 * (linkRank), the first of them on a tie, so a portal's own choice, put
 * first, stays when nothing is better. "" when none is a web address.
 */
export function bestApplyLink(options: readonly { url: string; name?: string }[], company: string): string {
  let best: { url: string; rank: number } | null = null;
  for (const option of options) {
    const rank = linkRank(option, company);
    if (rank !== null && (best === null || rank < best.rank)) best = { url: option.url, rank };
  }
  return best?.url ?? "";
}

/** Where to look for the employer's own posting: its careers page when the app knows it, else a web search in her own browser. */
export type FindPosting = {
  href: string;
  via: "careers" | "search";
  employer: string;
  /** Other places the portal listed it to apply at, best first and never a copy of the ad (jobauto fork); missing when there are none. */
  listed?: { name: string; url: string }[];
};

/** The places to offer instead of a link that is a copy of the ad, or may be one: the others listed, best first, without copies or the link itself. */
export function betterListed(options: readonly { name: string; url: string }[], current: string, company: string): { name: string; url: string }[] {
  const here = current.trim();
  return options
    .map((option) => ({ option, rank: linkRank(option, company) }))
    .filter(({ option, rank }) => rank !== null && rank < 4 && option.url !== here)
    .sort((a, b) => a.rank! - b.rank!)
    .map(({ option }) => ({ name: option.name, url: option.url }));
}

/** "Senior Analyst (m/w/d)" without the gender mark, for a search. */
const withoutGenderMark = (title: string) => title.replace(/\((?:[mwfdx*]\s*\/\s*){1,3}[mwfdx*]\)/gi, " ").replace(/\s+/g, " ").trim();

/**
 * The way to the employer's own posting: the careers page of an employer she
 * follows, else of one in her field's list, else a web search for the
 * company, the role and "Karriere", which opens in her own browser.
 */
export function findPostingAt(company: string, role: string, followed: readonly { name: string; careersUrl: string }[]): FindPosting {
  const key = companyKey(company);
  const known = key ? [...followed, ...FIELD_EMPLOYERS].find((employer) => sameCompany(companyKey(employer.name), key)) : undefined;
  const employer = company.trim();
  if (known && /^https?:\/\//i.test(known.careersUrl)) return { href: known.careersUrl, via: "careers", employer };
  const query = [employer, withoutGenderMark(role), "Karriere"].filter(Boolean).join(" ");
  return { href: `https://www.google.com/search?${new URLSearchParams({ q: query })}`, via: "search", employer };
}
