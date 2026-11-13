// Which job system a careers page runs on (jobauto fork), from its address.
// Most employers publish their jobs through one of a few systems, each with
// a public feed of every open job: reading the feed is reliable where
// scraping the page isn't. Anything else is read as a page, for the job data
// (JSON-LD) many careers pages carry.

export const BOARD_KINDS = ["personio", "greenhouse", "lever", "smartrecruiters", "recruitee", "ashby", "workday", "page"] as const;
export type BoardKind = (typeof BOARD_KINDS)[number];

export const BOARD_NAMES: Record<BoardKind, string> = {
  personio: "Personio",
  greenhouse: "Greenhouse",
  lever: "Lever",
  smartrecruiters: "SmartRecruiters",
  recruitee: "Recruitee",
  ashby: "Ashby",
  workday: "Workday",
  page: "its own page",
};

/** A careers page's job system, with what its feed needs. */
export type Board =
  | { kind: "personio"; host: string }
  | { kind: "greenhouse"; token: string; eu: boolean }
  | { kind: "lever"; company: string; eu: boolean }
  | { kind: "smartrecruiters"; company: string }
  | { kind: "recruitee"; slug: string }
  | { kind: "ashby"; name: string }
  | { kind: "workday"; origin: string; tenant: string; site: string; locale: string }
  | { kind: "page"; url: string };

const SLUG = /^[\w.-]{1,100}$/;
const LOCALE = /^[a-z]{2}-[A-Z]{2}$/;

/** The board a careers page's address points to; null when it isn't a web address. */
export function boardFor(address: string): Board | null {
  let url: URL;
  try {
    url = new URL(address.trim());
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const host = url.hostname.toLowerCase();
  const path = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const first = path[0] ?? "";

  if (/^[a-z0-9-]+\.jobs\.personio\.(de|com)$/.test(host)) return { kind: "personio", host };
  if (/^(job-)?boards(\.eu)?\.greenhouse\.io$/.test(host)) {
    const token = url.searchParams.get("for") ?? (first === "embed" ? "" : first);
    if (SLUG.test(token)) return { kind: "greenhouse", token, eu: host.includes(".eu.") };
  }
  if (/^jobs(\.eu)?\.lever\.co$/.test(host) && SLUG.test(first)) return { kind: "lever", company: first, eu: host.includes(".eu.") };
  if (/^(jobs|careers)\.smartrecruiters\.com$/.test(host) && SLUG.test(first)) return { kind: "smartrecruiters", company: first };
  if (/^[a-z0-9-]+\.recruitee\.com$/.test(host)) return { kind: "recruitee", slug: host.split(".")[0] };
  if (host === "jobs.ashbyhq.com" && SLUG.test(first)) return { kind: "ashby", name: first };
  // {tenant}.wd3.myworkdayjobs.com/[de-DE/]{site}, or wd3.myworkdaysite.com/[de-DE/]recruiting/{tenant}/{site}
  const workday = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (workday) {
    const [locale, site] = LOCALE.test(first) ? [first, path[1]] : ["", first];
    if (site && SLUG.test(site)) return { kind: "workday", origin: url.origin, tenant: workday[1], site, locale };
  }
  if (/^wd\d+\.myworkdaysite\.com$/.test(host)) {
    const rest = LOCALE.test(first) ? path.slice(1) : path;
    if (rest[0] === "recruiting" && rest[1] && rest[2] && SLUG.test(rest[1]) && SLUG.test(rest[2])) {
      return { kind: "workday", origin: url.origin, tenant: rest[1], site: rest[2], locale: LOCALE.test(first) ? first : "" };
    }
  }
  url.hash = "";
  return { kind: "page", url: url.toString() };
}

/** A name for the employer from its careers page's address, for the form to start from: "acme" from acme.jobs.personio.de. */
export function nameFromBoard(board: Board): string {
  const raw =
    board.kind === "personio"
      ? board.host.split(".")[0]
      : board.kind === "greenhouse"
        ? board.token
        : board.kind === "lever" || board.kind === "smartrecruiters"
          ? board.company
          : board.kind === "recruitee"
            ? board.slug
            : board.kind === "ashby"
              ? board.name
              : board.kind === "workday"
                ? board.tenant
                : new URL(board.url).hostname.replace(/^(www|careers|jobs|karriere)\./, "").split(".")[0];
  return raw.replace(/[-_]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}
